"""云同步 API：绑定账号 / 同步状态 / 立即同步 / 解绑。"""
import json

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session as DBSession, select

from app.db import get_session
from app.deps import get_current_user
from app.models import Setting, User
from app.services.settings import upsert_setting
from app.services.sync import CLOUD_BIND_KEY, CLOUD_CURSOR_KEY, _SYNC_PROXY, get_bind, run_sync

router = APIRouter(prefix="/api/sync", tags=["sync"])


class BindBody(BaseModel):
    url: str
    username: str
    password: str


def _cloud(url: str, path: str, body: dict, token: str = "") -> tuple[int, object]:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        r = httpx.post(url + path, json=body, headers=headers, timeout=120, proxy=_SYNC_PROXY)
    except Exception:
        return 0, "云端连接失败（需联网或开启代理）"
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, r.text


def _save_bind(db: DBSession, user_id: str, bind: dict) -> None:
    upsert_setting(db, user_id, CLOUD_BIND_KEY, json.dumps(bind, ensure_ascii=False))
    db.commit()


def _remove_bind(db: DBSession, user_id: str) -> None:
    row = db.exec(select(Setting).where(Setting.key == CLOUD_BIND_KEY, Setting.user_id == user_id)).first()
    if row:
        db.delete(row)
        db.commit()


@router.get("/status")
def sync_status(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    bind = get_bind(db, user.id)
    if not bind:
        return {"bound": False}
    cursor = db.exec(select(Setting).where(Setting.key == CLOUD_CURSOR_KEY, Setting.user_id == user.id)).first()
    return {
        "bound": True,
        "username": bind.get("username"),
        "url": bind.get("url"),
        "last_sync_at": cursor.value if cursor else None,
    }


@router.post("/bind")
def bind(body: BindBody, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    url = body.url.strip().rstrip("/")
    if not url.startswith("https://"):
        raise HTTPException(400, "云端地址需以 https:// 开头")
    status, data = _cloud(url, "/login", {"username": body.username, "password": body.password})
    if status == 401:
        _cloud(url, "/register", {"username": body.username, "password": body.password})
        status, data = _cloud(url, "/login", {"username": body.username, "password": body.password})
    if status != 200:
        raise HTTPException(400, f"云端登录失败：{data}")
    _save_bind(db, user.id, {"url": url, "username": body.username, "token": data.get("token", "")})
    result = run_sync(db, user.id)  # 绑定后立即全量同步
    return {"bound": True, "username": body.username, "sync": result}


@router.post("/unbind")
def unbind(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    _remove_bind(db, user.id)
    return {"ok": True}


@router.post("/now")
def sync_now(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    return run_sync(db, user.id)
