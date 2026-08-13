"""数据导出/导入 API（多端同步阶段 1：JSON 备份与数据搬家）。"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session as DBSession

from app.db import get_session
from app.deps import get_current_user
from app.models import User
from app.services.backup import deserialize_and_merge, serialize

router = APIRouter(prefix="/api/data", tags=["data"])


@router.get("/export")
def export_data(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """导出当前用户的全部数据（JSON，前端下载为备份文件）。"""
    return serialize(db, user.id)


class ImportBody(BaseModel):
    app: str = ""
    schema_version: int = 0
    data: dict = Field(default_factory=dict)


@router.post("/import")
def import_data(body: ImportBody, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """导入备份 JSON，合并进当前用户数据。"""
    try:
        return deserialize_and_merge(db, user.id, body.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e))
