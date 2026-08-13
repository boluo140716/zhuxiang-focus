"""日记 API：按日期读写（每人每天一篇）。"""
from datetime import datetime

from fastapi import APIRouter, Depends
from sqlmodel import Session as DBSession, select

from app.db import get_session
from app.deps import get_current_user
from app.models import Diary, User
from app.schemas import DiarySave

router = APIRouter(prefix="/api/diary", tags=["diary"])


@router.get("")
def get_diary(date: str, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    row = db.exec(select(Diary).where(Diary.date == date, Diary.user_id == user.id)).first()
    return {"date": date, "content": row.content if row else ""}


@router.put("")
def save_diary(body: DiarySave, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    row = db.exec(select(Diary).where(Diary.date == body.date, Diary.user_id == user.id)).first()
    if row:
        row.content = body.content
        row.updated_at = datetime.now()
        db.add(row)
    else:
        row = Diary(date=body.date, content=body.content, user_id=user.id, updated_at=datetime.now())
        db.add(row)
    db.commit()
    db.refresh(row)
    return {"date": row.date, "content": row.content}


@router.get("/search")
def search_diary(q: str, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """按日记内容全文搜索，支持多关键词（空格分隔，AND 逻辑），按日期倒序。"""
    keywords = [k.strip() for k in q.split() if k.strip()]
    if not keywords:
        return {"items": []}
    conditions = [Diary.content.contains(k) for k in keywords]
    rows = db.exec(
        select(Diary).where(Diary.user_id == user.id, *conditions)
    ).all()
    rows.sort(key=lambda d: d.date, reverse=True)
    return {"items": [{"date": d.date, "content": d.content} for d in rows]}