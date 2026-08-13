"""Windows 前台窗口轮询监控：黑名单命中自动记分心（设计 5.5）。

只做检测与上报，不拦截、不惩罚；命中黑名单且存在进行中会话才上报。
注意：进程必须跑在交互桌面（WinSta0\\Default），否则 GetForegroundWindow 永远返回 0。
"""
import ctypes
import json
import time
import urllib.request
from datetime import date
from ctypes import wintypes

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
COOLDOWN_SECONDS = 120  # 同一窗口持续命中时不重复上报
UOI_NAME = 2            # GetUserObjectInformationW 信息类：对象名称
MISS_GRACE = 30         # 短暂未命中视为检测噪声（如窗口标题变化），不中断连续计时

# 监控自检状态：/api/monitor/status 读取，用于诊断"自动检测不生效"
STATUS = {
    "desktop": None,           # (窗口站, 桌面)；非交互桌面时前台窗口不可见
    "foreground_seen": False,  # 是否曾取到过前台窗口（粘性，启动后变 True 即正常）
    "last_tick_at": None,      # 最近一次轮询时间戳（端点据此判断 alive）
    "last_foreground": None,   # 最近一次取到的前台窗口（进程名|标题），诊断用
}


def status_snapshot():
    """返回自检状态副本（供 API 读取，避免外部直接改全局状态）。"""
    return dict(STATUS)


# 分心命中状态：/api/monitor/hit 读取，前端轮询用于抖音实时提醒
HIT_STATE = {
    "hit": False,       # 当前前台是否命中黑名单
    "app": None,        # 命中的黑名单条目（如"抖音"）
    "since": None,      # 本次连续命中的起始时间戳（秒）
    "total": 0,         # 本场会话累计命中秒数（切走不清零，会话结束清零）
    "last_tick": None,  # 上一次命中 tick 的时间戳，用于累计 total
    "miss_since": None, # 本次未命中开始的时间戳，用于判断是否超过噪声容忍窗口
}


def hit_snapshot():
    """返回命中状态副本（供 API 读取）。"""
    return dict(HIT_STATE)


def reset_hit_state():
    """完全重置命中状态（无会话/新会话/会话结束时调用）。"""
    HIT_STATE.update({"hit": False, "app": None, "since": None, "total": 0, "last_tick": None, "miss_since": None})


def update_hit_state(hit: bool, app: str | None, now: float, reset_total: bool = False, force: bool = False):
    """维护命中状态与本场累计时长。

    - 命中：自上次观测以来的时间计入 total；连续计时(since)保持或重新开始
    - 短暂未命中（<=MISS_GRACE）：视为检测噪声，保持连续计时并继续累计
      （以首次未命中的 miss_since 为基准，不会因噪声而永远不超时）
    - 长时间未命中：视为切走，重置连续计时（累计保留）
    - reset_total（会话结束）：清零累计；force：跳过噪声容忍，立即重置
    """
    last = HIT_STATE.get("last_tick")
    if hit:
        if last is not None:
            HIT_STATE["total"] += max(0, now - last)
        if not HIT_STATE["hit"]:
            HIT_STATE["since"] = now
        HIT_STATE.update({"hit": True, "app": app, "last_tick": now, "miss_since": None})
        return
    miss_since = HIT_STATE.get("miss_since")
    if miss_since is None:
        miss_since = now  # 本次未命中开始计时
    if not force and HIT_STATE["hit"] and now - miss_since <= MISS_GRACE:
        # 短暂未命中：噪声容忍，保持命中状态并继续累计
        if last is not None:
            HIT_STATE["total"] += max(0, now - last)
        HIT_STATE.update({"last_tick": now, "miss_since": miss_since})
        return
    HIT_STATE.update({"hit": False, "app": None, "since": None, "last_tick": None, "miss_since": None})
    if reset_total:
        HIT_STATE["total"] = 0


def desktop_context():
    """返回 (窗口站, 桌面) 名称；失败返回 (None, None)。"""

    def _name(handle):
        if not handle:
            return None
        n = wintypes.DWORD()
        # 首次调用用于查询所需缓冲区长度（按惯例返回失败，属正常）
        user32.GetUserObjectInformationW(handle, UOI_NAME, None, 0, ctypes.byref(n))
        if not n.value:
            return None
        buf = ctypes.create_unicode_buffer(n.value // 2 + 1)
        if not user32.GetUserObjectInformationW(handle, UOI_NAME, buf, n.value, ctypes.byref(n)):
            return None
        return buf.value

    return (
        _name(user32.GetProcessWindowStation()),
        _name(user32.GetThreadDesktop(kernel32.GetCurrentThreadId())),
    )


def foreground_info():
    """返回 (进程名, 窗口标题)；失败返回 (None, None)。"""
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None, None
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(max(length + 1, 1))
    user32.GetWindowTextW(hwnd, buf, length + 1)
    title = buf.value
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    name = None
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if handle:
        size = wintypes.DWORD(1024)
        buf2 = ctypes.create_unicode_buffer(1024)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf2, ctypes.byref(size)):
            name = buf2.value.split("\\")[-1]
        kernel32.CloseHandle(handle)
    return name, title


def is_naked_day(settings, today=None):
    """裸专注日：设置 naked_day（1-7=周一至周日）与今天匹配时返回 True。"""
    naked = settings.get("naked_day") if settings else None
    if not naked:
        return False
    try:
        return (today or date.today()).isoweekday() == int(naked)
    except (TypeError, ValueError):
        return False


def should_report(last_key, current_key, last_time, now, cooldown=COOLDOWN_SECONDS):
    """窗口变化时上报；同一窗口持续命中时按冷却期节流。"""
    if current_key != last_key:
        return True
    return (now - last_time) > cooldown


class MonitorLoop:
    """轮询循环：读设置/当前会话 → 取前台窗口 → 命中黑名单则上报。"""

    def __init__(self, api_base="http://127.0.0.1:8000", interval=3.0, settings_ttl=30.0):
        self.api_base = api_base
        self.interval = interval
        self.settings_ttl = settings_ttl
        self._settings = None
        self._settings_at = 0.0
        self._last_key = None
        self._last_report_at = 0.0
        self._seen_session_id = None
        self._settings_key = None  # 设置归属用户，变化时重新读取

    def _get(self, path):
        with urllib.request.urlopen(self.api_base + path, timeout=3) as r:
            return json.load(r)

    def _post(self, path, body):
        req = urllib.request.Request(
            self.api_base + path,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=3) as r:
            return json.load(r)

    def _tick(self):
        now = time.time()
        STATUS["desktop"] = desktop_context()
        STATUS["last_tick_at"] = now
        # 自检：无论有无会话都记录前台窗口是否可见（与上报逻辑解耦）
        name, title = foreground_info()
        if name or title:
            STATUS["foreground_seen"] = True
            STATUS["last_foreground"] = f"{name}|{title}"
        # 取最新 running 会话（内部端点，跨用户；单机场景同一时间只有一人用电脑）
        try:
            session = self._get("/api/monitor/active_session")
        except Exception:
            return
        if not session or session.get("status") != "running":
            self._last_key = None
            reset_hit_state()
            self._seen_session_id = None
            return
        sid = session.get("id")
        uid = session.get("user_id")
        if sid is not None and sid != self._seen_session_id:
            # 新会话开始：完全重置命中状态，防止上一轮残留的 since/total 影响新会话
            reset_hit_state()
            self._seen_session_id = sid
            self._settings_key = None  # 新会话可能属于新用户，重新读设置
        if self._settings_key != uid or now - self._settings_at > self.settings_ttl:
            try:
                self._settings = self._get(f"/api/monitor/settings?user_id={uid}")
                self._settings_at = now
                self._settings_key = uid
            except Exception:
                return  # 服务未就绪，下一轮再试
        if is_naked_day(self._settings):
            # 裸专注日：产品不干预——不检测、不上报，前台命中状态保持未命中
            update_hit_state(False, None, now, force=True)
            self._last_key = None
            return
        blacklist = self._settings.get("blacklist") or []
        if not name and not title:
            update_hit_state(False, None, now)  # 前台暂时取不到（锁屏/UAC 等）：视为切走；保持 _last_key 不变，避免绕过冷却
            return
        from app.services.blacklist import match

        hit = match(title, name, blacklist)
        update_hit_state(bool(hit), hit, now)
        key = f"{name}|{title}"
        if hit and should_report(self._last_key, key, self._last_report_at, now):
            self._post("/api/monitor/distraction", {"session_id": sid, "app_name": hit})
            self._last_report_at = now
        self._last_key = key

    def run(self):
        while True:
            try:
                self._tick()
            except Exception:
                pass
            time.sleep(self.interval)
