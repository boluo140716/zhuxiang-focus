"""FastAPI 依赖：从 Authorization 头解析当前登录用户。"""
from fastapi import Depends, Header, HTTPException
from sqlmodel import Session as DBSession

from app.db import get_session
from app.models import User
from app.services.auth import verify_token


def get_current_user(
    authorization: str = Header(default=""),
    db: DBSession = Depends(get_session),
) -> User:
    """业务路由统一挂载：无 token / 失效 / 用户不存在 → 401。"""
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, "未登录")
    uid = verify_token(authorization.removeprefix("Bearer ").strip())
    if uid is None:
        raise HTTPException(401, "登录已过期，请重新登录")
    user = db.get(User, uid)
    if not user:
        raise HTTPException(401, "用户不存在")
    return user
