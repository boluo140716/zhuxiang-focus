"""SQLite 数据库初始化。"""
import os
from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine


def _db_path() -> Path:
    """数据库文件路径，测试时可用 FOCUS_DB_PATH 覆盖。"""
    env = os.environ.get("FOCUS_DB_PATH")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "data" / "focus.db"


DB_PATH = _db_path()
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})


def init_db() -> None:
    """建表（幂等）。"""
    from app import models  # noqa: F401

    SQLModel.metadata.create_all(engine)


def get_session():
    """FastAPI 依赖：请求级数据库会话。"""
    with Session(engine) as session:
        yield session
