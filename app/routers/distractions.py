"""分心记录 API：手动 + 自动检测双通道（设计 5.4）。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session as DBSession

from app.db import get_session
from app.deps import get_current_user
from app.models import Distraction, FocusSession, User
from app.schemas import DistractionCreate

router = APIRouter(prefix="/api", tags=["distractions"])


@router.post("/sessions/{session_id}/distractions", response_model=Distraction)
def add_session_distraction(session_id: str, body: DistractionCreate, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """会话内的分心记录（手动破功 / 手机拿起）；自动检测走内部端点。"""
    session = db.get(FocusSession, session_id)
    if not session or session.user_id != user.id:
        raise HTTPException(404, "会话不存在")
    payload = body.model_dump()
    payload["session_id"] = session_id
    payload["user_id"] = user.id
    record = Distraction(**payload)
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


@router.post("/distractions", response_model=Distraction)
def add_standalone_distraction(body: DistractionCreate, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """会话外的独立分心记录（如随手刷手机）。"""
    payload = body.model_dump()
    payload["user_id"] = user.id
    record = Distraction(**payload)
    db.add(record)
    db.commit()
    db.refresh(record)
    return record

