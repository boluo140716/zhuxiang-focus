"""设置 API（设计 4.4 / 5.4）。"""
import json

from fastapi import APIRouter, Depends
from sqlmodel import Session as DBSession, select

from app.db import get_session
from app.models import Setting
from app.services.blacklist import DEFAULT_BLACKLIST

router = APIRouter(prefix="/api/settings", tags=["settings"])

DEFAULTS = {
    "blacklist": DEFAULT_BLACKLIST,
    "target_minutes": 15,
    "deep_start": "09:00",
    "deep_end": "11:00",
    "reminder_enabled": True,
}


def _dump(value) -> str:
    return json.dumps(value, ensure_ascii=False)


def _load(text: str):
    try:
        return json.loads(text)
    except Exception:
        return text


def get_settings(db: DBSession) -> dict:
    """默认值 + 已存储值合并。"""
    result = dict(DEFAULTS)
    for row in db.exec(select(Setting)).all():
        result[row.key] = _load(row.value)
    return result


def set_settings(db: DBSession, values: dict) -> dict:
    """部分更新，返回合并后的完整设置。"""
    for key, value in values.items():
        if key not in DEFAULTS:
            continue
        row = db.get(Setting, key)
        if row:
            row.value = _dump(value)
        else:
            db.add(Setting(key=key, value=_dump(value)))
    db.commit()
    return get_settings(db)


@router.get("")
def read_settings(db: DBSession = Depends(get_session)):
    return get_settings(db)


@router.put("")
def write_settings(body: dict, db: DBSession = Depends(get_session)):
    return set_settings(db, body)
