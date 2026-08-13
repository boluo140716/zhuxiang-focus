"""数据库迁移测试：旧库自动补新列（reliance）。"""
import os
import tempfile
from uuid import UUID

from sqlmodel import create_engine

import app.db as app_db
from app.db import _migrate, _migrate_uuid


def test_migrate_adds_reliance_column():
    """模拟旧 schema（无 user_id/reliance + setting 旧主键）→ 迁移补齐且数据不丢。"""
    tmp = tempfile.mkdtemp(prefix="yizhuxiang_migrate_")
    path = os.path.join(tmp, "old.db")
    old = create_engine(f"sqlite:///{path}")
    with old.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE session (id INTEGER PRIMARY KEY, task_name VARCHAR(200), "
            "planned_minutes INTEGER, actual_minutes INTEGER, started_at DATETIME, "
            "ended_at DATETIME, status VARCHAR(20), device VARCHAR(20), stage VARCHAR(20), "
            "completion_score INTEGER, flow_score INTEGER)"
        )
        conn.exec_driver_sql("CREATE TABLE setting (key VARCHAR PRIMARY KEY, value VARCHAR)")
        conn.exec_driver_sql("INSERT INTO setting (key, value) VALUES ('target_minutes', '25')")
    _migrate(old)
    with old.connect() as conn:
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(session)")]
    assert "user_id" in cols and "reliance" in cols
    with old.connect() as conn:
        setting_cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(setting)")]
        rows = conn.exec_driver_sql("SELECT key, value, user_id FROM setting").all()
    assert "id" in setting_cols  # 重建为新结构（id 主键）
    assert len(rows) == 1 and rows[0][1] == "25" and rows[0][2] is None  # 数据完整迁移
    _migrate(old)  # 幂等：重复迁移不报错


def test_migrate_adds_reflection_column():
    """已有 reliance 的旧库 → 迁移补齐 reflection 列，幂等。"""
    tmp = tempfile.mkdtemp(prefix="yizhuxiang_migrate_")
    path = os.path.join(tmp, "old.db")
    old = create_engine(f"sqlite:///{path}")
    with old.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE session (id INTEGER PRIMARY KEY, task_name VARCHAR(200), "
            "planned_minutes INTEGER, actual_minutes INTEGER, started_at DATETIME, "
            "ended_at DATETIME, status VARCHAR(20), device VARCHAR(20), stage VARCHAR(20), "
            "completion_score INTEGER, flow_score INTEGER, reliance VARCHAR(10))"
        )
    _migrate(old)
    with old.connect() as conn:
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(session)")]
    assert "reflection" in cols
    _migrate(old)  # 幂等


def test_migrate_uuid_converts_data():
    """旧库（int 主键）→ UUID 迁移：数据完整、外键映射正确。"""
    tmp = tempfile.mkdtemp(prefix="yizhuxiang_uuid_")
    path = os.path.join(tmp, "old.db")
    old = create_engine(f"sqlite:///{path}")
    with old.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE user (id INTEGER PRIMARY KEY, username VARCHAR(50) UNIQUE, "
            "nickname VARCHAR(50), password_hash VARCHAR(200), security_question VARCHAR(100), "
            "security_answer_hash VARCHAR(200), created_at DATETIME)"
        )
        conn.exec_driver_sql(
            "CREATE TABLE todo (id INTEGER PRIMARY KEY, text VARCHAR(100), sort_order INTEGER, "
            "done BOOLEAN, done_date VARCHAR, is_daily BOOLEAN, streak INTEGER, "
            "last_checkin VARCHAR, created_at DATETIME, user_id INTEGER)"
        )
        conn.exec_driver_sql(
            "CREATE TABLE session (id INTEGER PRIMARY KEY, task_name VARCHAR(200), "
            "planned_minutes INTEGER, actual_minutes INTEGER, started_at DATETIME, "
            "ended_at DATETIME, status VARCHAR(20), user_id INTEGER, todo_id INTEGER, "
            "device VARCHAR(20), stage VARCHAR(20), completion_score INTEGER, "
            "flow_score INTEGER, reliance VARCHAR(10), reflection VARCHAR(500))"
        )
        conn.exec_driver_sql(
            "CREATE TABLE distraction (id INTEGER PRIMARY KEY, session_id INTEGER, "
            "occurred_at DATETIME, source VARCHAR(20), app_name VARCHAR, "
            "resolved_reason VARCHAR, duration_minutes INTEGER, user_id INTEGER)"
        )
        conn.exec_driver_sql(
            "CREATE TABLE setting (id INTEGER PRIMARY KEY, key VARCHAR(50), value VARCHAR, user_id INTEGER)"
        )
        conn.exec_driver_sql(
            "CREATE TABLE diary (id INTEGER PRIMARY KEY, date VARCHAR(10), content VARCHAR, user_id INTEGER)"
        )
        conn.exec_driver_sql(
            "INSERT INTO user (id, username, nickname, password_hash, created_at) VALUES "
            "(1, 'alice', '小艾', 'x', '2026-08-01T10:00:00')"
        )
        conn.exec_driver_sql(
            "INSERT INTO todo (id, text, sort_order, done, is_daily, streak, created_at, user_id) VALUES "
            "(7, '背单词', 0, 1, 1, 3, '2026-08-01T09:00:00', 1)"
        )
        conn.exec_driver_sql(
            "INSERT INTO session (id, task_name, planned_minutes, actual_minutes, started_at, "
            "status, user_id, todo_id, device, stage) VALUES "
            "(2, '写方案', 25, 20, '2026-08-02T09:00:00', 'completed', 1, 7, 'desktop', 'training')"
        )
        conn.exec_driver_sql(
            "INSERT INTO distraction (id, session_id, occurred_at, source, app_name, user_id) VALUES "
            "(3, 2, '2026-08-02T09:05:00', 'auto_detect', '抖音', 1)"
        )
        conn.exec_driver_sql(
            "INSERT INTO setting (id, key, value, user_id) VALUES (4, 'blacklist', '[\"抖音\"]', 1)"
        )
        conn.exec_driver_sql(
            "INSERT INTO diary (id, date, content, user_id) VALUES (5, '2026-08-02', '写完了', 1)"
        )

    with old.begin() as conn:
        _migrate_uuid(conn)
        tables = {r[0] for r in conn.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    assert not tables  # 旧表已全部删除，等待 create_all 重建

    data = app_db._uuid_data
    assert data is not None
    assert len(data["users"]) == 1 and UUID(data["users"][0]["id"])
    assert len(data["todos"]) == 1
    assert len(data["sessions"]) == 1
    assert len(data["distractions"]) == 1
    assert len(data["settings"]) == 1
    assert len(data["diaries"]) == 1
    uid = data["users"][0]["id"]
    todo_id = data["todos"][0]["id"]
    session_id = data["sessions"][0]["id"]
    assert data["todos"][0]["user_id"] == uid
    assert data["sessions"][0]["user_id"] == uid
    assert data["sessions"][0]["todo_id"] == todo_id  # 待办外键映射到新 uuid
    assert data["distractions"][0]["session_id"] == session_id  # 分心跟随会话
    assert data["settings"][0]["user_id"] == uid
    assert data["diaries"][0]["user_id"] == uid
    assert data["todos"][0]["streak"] == 3
    assert data["diaries"][0]["date"] == "2026-08-02"
    app_db._uuid_data = None  # 清理，避免污染后续测试
