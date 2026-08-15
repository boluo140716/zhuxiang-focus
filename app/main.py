"""FastAPI 入口。"""
import os
import sys
import threading
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from fastapi import Depends, HTTPException, Request
from sqlmodel import Session as DBSession, select

from app.db import AVATAR_DIR, get_session, init_db
from app.models import Distraction, FocusSession
from app.routers import auth, data, diary, distractions, notify, sessions, settings, stats, sync, todos
from app.schemas import MonitorDistraction

init_db()

MONITOR_ALIVE_TTL = 20  # 超过该秒数无轮询视为监控线程失活（单轮 tick 最坏约 12s，留余量）


def _require_loopback(request: Request):
    """仅允许本机来源：monitor 内部端点暴露黑名单/会话状态，防止局域网读取。"""
    client = request.client.host if request.client else ""
    if client not in ("127.0.0.1", "::1", "testclient"):  # testclient = 测试客户端标识，生产不可能出现
        raise HTTPException(403, "仅允许本机调用")

app = FastAPI(title="篆香")
app.include_router(auth.router)
app.include_router(sessions.router)
app.include_router(distractions.router)
app.include_router(settings.router)
app.include_router(stats.router)
app.include_router(todos.router)
app.include_router(diary.router)
app.include_router(notify.router)
app.include_router(data.router)
app.include_router(sync.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/system/shutdown")
def system_shutdown(request: Request):
    """退出应用（EXE 版"退出"按钮调用）。仅允许本机来源，防止局域网误关。"""
    client = request.client.host if request.client else ""
    if client not in ("127.0.0.1", "::1"):
        raise HTTPException(403, "仅允许本机调用")

    def _die():
        time.sleep(1.0)  # 先让响应返回，并给 WebView2 留刷盘时间
        os._exit(0)

    threading.Thread(target=_die, daemon=True).start()
    return {"ok": True}


@app.get("/api/monitor/status")
def monitor_status(request: Request):
    """监控自检：desktop 为 (WinSta0, Default) 且 foreground_seen=True 才说明前台窗口可见。"""
    _require_loopback(request)
    try:
        from app.monitor import win_monitor

        snapshot = win_monitor.status_snapshot()
        last = snapshot.get("last_tick_at")
        snapshot["alive"] = bool(last) and (time.time() - last) < MONITOR_ALIVE_TTL
        return snapshot
    except Exception as e:
        return {
            "alive": False,
            "desktop": None,
            "foreground_seen": False,
            "last_tick_at": None,
            "error": f"monitor unavailable: {e}",
        }


@app.get("/api/monitor/hit")
def monitor_hit(request: Request):
    """实时命中状态：前端轮询用于抖音实时提醒。"""
    _require_loopback(request)
    try:
        from app.monitor import win_monitor

        return win_monitor.hit_snapshot()
    except Exception as e:
        return {"hit": False, "app": None, "since": None, "error": f"monitor unavailable: {e}"}


@app.get("/api/monitor/active_session")
def monitor_active_session(request: Request, db: DBSession = Depends(get_session)):
    """桌面监控内部：最新开始的 running 会话（不含任务名，仅 id/归属用户）。"""
    _require_loopback(request)
    session = db.exec(
        select(FocusSession)
        .where(FocusSession.status == "running")
        .order_by(FocusSession.started_at.desc())
    ).first()
    if not session:
        return None
    return {"id": session.id, "user_id": session.user_id, "status": session.status}


@app.get("/api/monitor/settings")
def monitor_settings(request: Request, user_id: str | None = None, db: DBSession = Depends(get_session)):
    """桌面监控内部：指定用户的分心黑名单与裸专注日设置（L3 预备毕业不再检测黑名单）。"""
    _require_loopback(request)
    from app.services.settings import current_stage, get_settings

    s = get_settings(db, user_id)
    stage = current_stage(db, user_id)
    return {"blacklist": [] if stage >= 3 else s["blacklist"], "naked_day": s["naked_day"]}


@app.post("/api/monitor/distraction")
def monitor_distraction(body: MonitorDistraction, request: Request, db: DBSession = Depends(get_session)):
    """桌面监控内部：自动检测命中上报（仅本机回环可调）。"""
    if request.client.host not in ("127.0.0.1", "::1", "testclient"):  # testclient=测试客户端
        raise HTTPException(403, "仅本机可调用")
    session = db.get(FocusSession, body.session_id)
    if not session or session.status != "running":
        return {"ok": False, "reason": "no running session"}
    record = Distraction(
        session_id=session.id,
        user_id=session.user_id,
        source="auto_detect",
        app_name=body.app_name,
        resolved_reason="走神",
    )
    db.add(record)
    db.commit()
    return {"ok": True}


app.mount("/avatars", StaticFiles(directory=AVATAR_DIR), name="avatars")


_STATIC_DIR = str(Path(sys._MEIPASS) / "static") if getattr(sys, "frozen", False) else "static"
app.mount("/", StaticFiles(directory=_STATIC_DIR, html=True), name="static")
