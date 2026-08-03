"""数据模型（设计文档 5.3）。"""
from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


def now_local() -> datetime:
    """本地时间（单机自用产品，日统计按本地日界更直观）。"""
    return datetime.now()


class FocusSession(SQLModel, table=True):
    """专注会话。"""

    __tablename__ = "session"

    id: Optional[int] = Field(default=None, primary_key=True)
    task_name: str = Field(default="", max_length=200)
    planned_minutes: int = Field(default=15, ge=1, le=180)
    actual_minutes: int = Field(default=0)
    started_at: datetime = Field(default_factory=now_local)
    ended_at: Optional[datetime] = None
    status: str = Field(default="running")  # running / completed / abandoned
    device: str = Field(default="desktop")  # phone / desktop
    stage: str = Field(default="training")  # awareness / training / habit
    completion_score: Optional[int] = Field(default=None, ge=0, le=100)  # 结束自评完成度
    flow_score: Optional[int] = Field(default=None, ge=1, le=5)  # 结束自评心流感


class Distraction(SQLModel, table=True):
    """分心记录（手动 / 自动检测 / 手机拿起）。"""

    __tablename__ = "distraction"

    id: Optional[int] = Field(default=None, primary_key=True)
    session_id: Optional[int] = Field(default=None, foreign_key="session.id")
    occurred_at: datetime = Field(default_factory=now_local)
    source: str = Field(default="manual")  # manual / auto_detect / phone_pickup
    app_name: str = Field(default="")
    resolved_reason: Optional[str] = None  # 刷手机 / 工作 / 喝水 / 上厕所 / 走神
    duration_minutes: int = Field(default=0)


class Setting(SQLModel, table=True):
    """键值设置，value 统一存 JSON 字符串。"""

    __tablename__ = "setting"

    key: str = Field(primary_key=True)
    value: str = Field(default="")
