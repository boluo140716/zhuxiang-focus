"""分心记录 API：手动 + 自动检测双通道（设计 5.4）。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session as DBSession

from app.db import get_session
from app.models import Distraction, FocusSession
from app.schemas import DistractionCreate

router = APIRouter(prefix="/api", tags=["distractions"])


@router.post("/sessions/{session_id}/distractions", response_model=Distraction)
def add_session_distraction(session_id: int, body: DistractionCreate, db: DBSession = Depends(get_session)):
    """会话内的分心记录（手动破功 / 自动检测 / 手机拿起）。"""
    session = db.get(FocusSession, session_id)
    if not session:
        raise HTTPException(404, "会话不存在")
    payload = body.model_dump()
    payload["session_id"] = session_id
    record = Distraction(**payload)
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


@router.post("/distractions", response_model=Distraction)
def add_standalone_distraction(body: DistractionCreate, db: DBSession = Depends(get_session)):
    """会话外的独立分心记录（如随手刷手机）。"""
    record = Distraction(**body.model_dump())
    db.add(record)
    db.commit()
    db.refresh(record)
    return record
