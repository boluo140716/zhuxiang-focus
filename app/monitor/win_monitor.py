"""Windows 前台窗口轮询监控：黑名单命中自动记分心（设计 5.5）。

只做检测与上报，不拦截、不惩罚；命中黑名单且存在进行中会话才上报。
"""
import ctypes
import json
import time
import urllib.request
from ctypes import wintypes

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
COOLDOWN_SECONDS = 120  # 同一窗口持续命中时不重复上报


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
        if self._settings is None or now - self._settings_at > self.settings_ttl:
            try:
                self._settings = self._get("/api/settings")
                self._settings_at = now
            except Exception:
                return  # 服务未就绪，下一轮再试
        blacklist = self._settings.get("blacklist") or []
        try:
            session = self._get("/api/sessions/current")
        except Exception:
            return
        if not session or session.get("status") != "running":
            self._last_key = None
            return
        name, title = foreground_info()
        if not name and not title:
            return
        from app.services.blacklist import match

        hit = match(title, name, blacklist)
        key = f"{name}|{title}"
        if hit and should_report(self._last_key, key, self._last_report_at, now):
            self._post(
                f"/api/sessions/{session['id']}/distractions",
                {"source": "auto_detect", "app_name": hit, "resolved_reason": "走神"},
            )
            self._last_report_at = now
        self._last_key = key

    def run(self):
        while True:
            try:
                self._tick()
            except Exception:
                pass
            time.sleep(self.interval)
