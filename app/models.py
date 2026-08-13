"""数据模型（设计文档 5.3）。"""
from datetime import datetime
from typing import Optional
from uuid import uuid4

from sqlmodel import Field, SQLModel, UniqueConstraint


def now_local() -> datetime:
    """本地时间（单机自用产品，日统计按本地日界更直观）。"""
    return datetime.now()


def new_id() -> str:
    """全局唯一主键（多端同步：避免各设备自增 ID 撞车）。"""
    return str(uuid4())


class User(SQLModel, table=True):
    """用户账号（登录凭证 + 展示昵称）。"""

    __tablename__ = "user"

    id: str = Field(default_factory=new_id, primary_key=True)
    username: str = Field(index=True, unique=True, max_length=50)
    nickname: str = Field(default="", max_length=50)
    password_hash: str = Field(max_length=200)
    security_question: Optional[str] = Field(default=None, max_length=100)  # 安全问题（忘记密码重置用）
    security_answer_hash: Optional[str] = Field(default=None, max_length=200)
    created_at: datetime = Field(default_factory=now_local)


class FocusSession(SQLModel, table=True):
    """专注会话。"""

    __tablename__ = "session"

    id: str = Field(default_factory=new_id, primary_key=True)
    task_name: str = Field(default="", max_length=200)
    planned_minutes: int = Field(default=15, ge=1, le=180)
    actual_minutes: int = Field(default=0)
    started_at: datetime = Field(default_factory=now_local)
    ended_at: Optional[datetime] = None
    status: str = Field(default="running")  # running / completed / abandoned
    user_id: Optional[str] = Field(default=None, index=True)  # 数据归属用户（NULL=待首账号继承的旧数据）
    todo_id: Optional[str] = Field(default=None)  # 来源待办（从待办开始专注时关联，完成后联动）
    device: str = Field(default="desktop")  # phone / desktop
    stage: str = Field(default="training")  # awareness / training / habit
    completion_score: Optional[int] = Field(default=None, ge=0, le=100)  # 结束自评完成度
    flow_score: Optional[int] = Field(default=None, ge=1, le=5)  # 结束自评心流感
    reliance: Optional[str] = Field(default=None, max_length=10)  # 结束自评：self 靠自己 / product 靠产品
    reflection: Optional[str] = Field(default=None, max_length=500)  # 结束复盘：这一场为什么分心/放弃（可选）
    updated_at: Optional[datetime] = Field(default_factory=now_local)  # 同步基线：最近修改时间
    deleted: bool = Field(default=False)  # 软删除墓碑（同步删除用）


class Distraction(SQLModel, table=True):
    """分心记录（手动 / 自动检测 / 手机拿起）。"""

    __tablename__ = "distraction"

    id: str = Field(default_factory=new_id, primary_key=True)
    session_id: Optional[str] = Field(default=None, foreign_key="session.id")
    occurred_at: datetime = Field(default_factory=now_local)
    source: str = Field(default="manual")  # manual / auto_detect / phone_pickup
    app_name: str = Field(default="")
    resolved_reason: Optional[str] = None  # 刷手机 / 工作 / 喝水 / 上厕所 / 走神
    duration_minutes: int = Field(default=0)
    user_id: Optional[str] = Field(default=None, index=True)  # 数据归属用户
    updated_at: Optional[datetime] = Field(default_factory=now_local)
    deleted: bool = Field(default=False)


class Setting(SQLModel, table=True):
    """键值设置，value 统一存 JSON 字符串。"""

    __tablename__ = "setting"
    __table_args__ = (UniqueConstraint("key", "user_id"),)

    id: str = Field(default_factory=new_id, primary_key=True)
    key: str = Field(index=True, max_length=50)
    value: str = Field(default="")
    user_id: Optional[str] = Field(default=None, index=True)  # 数据归属用户
    updated_at: Optional[datetime] = Field(default_factory=now_local)


class Todo(SQLModel, table=True):
    """待办：提前列好的专注事项，可从待办页直接开始。"""

    __tablename__ = "todo"

    id: str = Field(default_factory=new_id, primary_key=True)
    text: str = Field(max_length=100)
    sort_order: int = Field(default=0)  # 越小越靠前（新增排最前）
    done: bool = Field(default=False)
    done_date: Optional[str] = Field(default=None)  # 完成日期（打卡项目据此每日重置）
    is_daily: bool = Field(default=False)  # 打卡项目：每天重复，完成不消失
    streak: int = Field(default=0)  # 连续打卡天数
    last_checkin: Optional[str] = Field(default=None)  # 最近一次打卡日期
    created_at: datetime = Field(default_factory=now_local)
    user_id: Optional[str] = Field(default=None, index=True)  # 数据归属用户
    updated_at: Optional[datetime] = Field(default_factory=now_local)
    deleted: bool = Field(default=False)


class Diary(SQLModel, table=True):
    """日记：每人每天一篇，按日期存档。"""

    __tablename__ = "diary"
    __table_args__ = (UniqueConstraint("date", "user_id"),)

    id: str = Field(default_factory=new_id, primary_key=True)
    date: str = Field(index=True, max_length=10)  # YYYY-MM-DD
    content: str = Field(default="")
    user_id: Optional[str] = Field(default=None, index=True)  # 数据归属用户
    updated_at: Optional[datetime] = Field(default_factory=now_local)
