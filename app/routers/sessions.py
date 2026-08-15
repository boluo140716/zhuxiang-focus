"""专注会话 API：开始 / 结束（设计 5.4）。"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session as DBSession, select

from app.db import get_session
from app.deps import get_current_user
from app.models import Distraction, FocusSession, Todo, User
from app.schemas import SessionCreate, SessionUpdate
from app.services.settings import current_stage
from app.services.stage import STAGE_TO_SESSION
from app.services.training import next_daily_streak


def _reset_monitor_hit():
    """会话开始/结束时同步重置监控命中状态，避免残留旧状态影响新会话（Windows 外静默跳过）。"""
    try:
        from app.monitor.win_monitor import reset_hit_state

        reset_hit_state()
    except Exception:
        pass

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.post("", response_model=FocusSession)
def start_session(body: SessionCreate, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """开始专注；同用户已有进行中会话时自动结束旧会话（每人同时最多一场）。"""
    _reset_monitor_hit()
    running = db.exec(select(FocusSession).where(FocusSession.status == "running", FocusSession.user_id == user.id)).first()
    if running:
        running.ended_at = datetime.now()
        running.actual_minutes = max(0, int((running.ended_at - running.started_at).total_seconds() // 60))
        running.status = "abandoned"
        running.updated_at = datetime.now()  # 放弃旧会话也是变更，需进云同步
        db.add(running)
    stage_int = current_stage(db, user.id)
    session = FocusSession(**body.model_dump(), user_id=user.id)
    session.stage = STAGE_TO_SESSION.get(stage_int, "training")
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.get("/current")
def current_session(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """返回当前用户的进行中会话（页面刷新后恢复计时用），没有则 null。"""
    return db.exec(select(FocusSession).where(FocusSession.status == "running", FocusSession.user_id == user.id)).first()


@router.patch("/{session_id}")
def end_session(session_id: str, body: SessionUpdate, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """结束会话：complete 或 abandon，附带质量自评；返回本场是否有黑名单自动检测分心。"""
    _reset_monitor_hit()
    session = db.get(FocusSession, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(404, "会话不存在")
    if session.status != "running":
        raise HTTPException(400, "会话已结束")
    session.ended_at = datetime.now()
    if body.actual_minutes is not None:
        session.actual_minutes = max(0, body.actual_minutes)
    else:
        session.actual_minutes = max(0, int((session.ended_at - session.started_at).total_seconds() // 60))
    session.status = "completed" if body.action == "complete" else "abandoned"
    session.completion_score = body.completion_score
    session.flow_score = body.flow_score
    session.reliance = body.reliance
    session.reflection = body.reflection
    session.updated_at = datetime.now()
    # 正常完成 → 联动标记来源待办完成
    if session.status == "completed" and session.todo_id:
        todo = db.get(Todo, session.todo_id)
        if todo and todo.user_id == user.id and not todo.done and not todo.deleted:
            today = datetime.now().strftime("%Y-%m-%d")
            todo.done = True
            todo.done_date = today
            if todo.is_daily:
                todo.streak = next_daily_streak(todo.last_checkin, todo.streak, today)
                todo.last_checkin = today
            todo.updated_at = datetime.now()  # 联动完成待办也是变更，需进云同步
            db.add(todo)
    db.add(session)
    db.commit()
    db.refresh(session)
    auto_hit = bool(db.exec(
        select(Distraction).where(Distraction.session_id == session.id, Distraction.source == "auto_detect")
    ).first())
    return {"session": session, "auto_distracted": auto_hit}
