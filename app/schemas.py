"""API 请求/响应模型。"""
from typing import Optional

from sqlmodel import SQLModel


class SessionCreate(SQLModel):
    task_name: str = ""
    planned_minutes: int = 15
    device: str = "desktop"
    stage: str = "training"


class SessionUpdate(SQLModel):
    action: str = "complete"  # complete / abandon
    completion_score: Optional[int] = None
    flow_score: Optional[int] = None
    actual_minutes: Optional[int] = None  # 客户端实测时长（离线补交用）


class DistractionCreate(SQLModel):
    session_id: Optional[int] = None
    source: str = "manual"
    app_name: str = ""
    resolved_reason: Optional[str] = None
    duration_minutes: int = 0
