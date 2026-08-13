"""API 请求/响应模型。"""
from typing import Optional

from sqlmodel import SQLModel


class SessionCreate(SQLModel):
    task_name: str = ""
    planned_minutes: int = 15
    device: str = "desktop"
    stage: str = "training"
    todo_id: Optional[str] = None  # 从待办开始专注时的来源待办


class SessionUpdate(SQLModel):
    action: str = "complete"  # complete / abandon
    completion_score: Optional[int] = None
    flow_score: Optional[int] = None
    reliance: Optional[str] = None  # self 靠自己 / product 靠产品
    actual_minutes: Optional[int] = None  # 客户端实测时长（离线补交用）
    reflection: Optional[str] = None  # 结束复盘：这一场为什么分心/放弃（可选）


class DistractionCreate(SQLModel):
    session_id: Optional[str] = None
    source: str = "manual"
    app_name: str = ""
    resolved_reason: Optional[str] = None
    duration_minutes: int = 0


class DiarySave(SQLModel):
    date: str  # YYYY-MM-DD
    content: str = ""


class AuthRegister(SQLModel):
    username: str
    nickname: str = ""
    password: str
    security_question: Optional[str] = None
    security_answer: Optional[str] = None


class AuthLogin(SQLModel):
    username: str
    password: str


class TodoCreate(SQLModel):
    text: str
    is_daily: bool = False  # 每日任务


class TodoUpdate(SQLModel):
    text: Optional[str] = None
    done: Optional[bool] = None
    is_daily: Optional[bool] = None  # 打卡项目开关


class MonitorDistraction(SQLModel):
    """桌面监控内部上报：只带会话 id 与命中应用名。"""
    session_id: str
    app_name: str = ""


class NicknameUpdate(SQLModel):
    nickname: str


class PasswordChange(SQLModel):
    old_password: str
    new_password: str


class SecuritySet(SQLModel):
    question: str
    answer: str


class ResetPassword(SQLModel):
    username: str
    answer: str
    new_password: str
