"""专注会话 API：开始 / 结束（设计 5.4）。"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session as DBSession, select

from app.db import get_session
from app.models import FocusSession
from app.schemas import SessionCreate, SessionUpdate

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.post("", response_model=FocusSession)
def start_session(body: SessionCreate, db: DBSession = Depends(get_session)):
    """开始专注；若已有进行中会话，自动结束并标记 abandoned（唯一会话约束）。"""
    running = db.exec(select(FocusSession).where(FocusSession.status == "running")).first()
    if running:
        running.ended_at = datetime.now()
        running.actual_minutes = max(0, int((running.ended_at - running.started_at).total_seconds() // 60))
        running.status = "abandoned"
        db.add(running)
    session = FocusSession(**body.model_dump())
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.patch("/{session_id}", response_model=FocusSession)
def end_session(session_id: int, body: SessionUpdate, db: DBSession = Depends(get_session)):
    """结束会话：complete 或 abandon，附带质量自评。"""
    session = db.get(FocusSession, session_id)
    if not session:
        raise HTTPException(404, "会话不存在")
    if session.status != "running":
        raise HTTPException(400, "会话已结束")
    session.ended_at = datetime.now()
    session.actual_minutes = max(0, int((session.ended_at - session.started_at).total_seconds() // 60))
    session.status = "completed" if body.action == "complete" else "abandoned"
    session.completion_score = body.completion_score
    session.flow_score = body.flow_score
    db.add(session)
    db.commit()
    db.refresh(session)
    return session
