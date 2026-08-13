"""SQLite 数据库初始化。"""
import os
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from sqlmodel import Session, SQLModel, create_engine


def _db_path() -> Path:
    """数据库文件路径，测试时可用 FOCUS_DB_PATH 覆盖。"""
    env = os.environ.get("FOCUS_DB_PATH")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "data" / "focus.db"


DB_PATH = _db_path()
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
AVATAR_DIR = DB_PATH.parent / "avatars"
AVATAR_DIR.mkdir(parents=True, exist_ok=True)
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})

_uuid_data = None  # 旧库 UUID 迁移的暂存数据（drop 表后、create_all 重建前驻留内存）


def _dt(value):
    """SQLite 读出的 datetime 文本 → datetime（兼容 None / 原样值）。"""
    if value is None:
        return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return value
    return value


def _read_table(conn, table):
    cols = [d[0] for d in conn.exec_driver_sql(f"SELECT * FROM {table} LIMIT 0").cursor.description]
    rows = conn.exec_driver_sql(f"SELECT * FROM {table}").fetchall()
    return cols, rows


def _migrate_uuid(conn) -> None:
    """旧库（int 自增主键）→ 新库（UUID 主键）：读数据到内存 → 删旧表。

    create_all 建好新结构后由 _restore_uuid_data 写回。多端同步阶段 2。
    """
    global _uuid_data
    tables = {row[0] for row in conn.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'")}
    if "user" not in tables:
        return
    user_meta = conn.exec_driver_sql("PRAGMA table_info(user)").fetchall()
    id_type = next((r[2] for r in user_meta if r[1] == "id"), "")
    if id_type.upper() != "INTEGER":
        return  # 已是 UUID 结构

    # 迁移前备份原库（防中途异常丢数据；只备份一次）
    import shutil

    backup = DB_PATH.with_suffix(".pre-uuid.bak")
    if not backup.exists():
        shutil.copy2(DB_PATH, backup)

    def rowdict(cols, row):
        return dict(zip(cols, row))

    user_cols, user_rows = _read_table(conn, "user")
    session_cols, session_rows = _read_table(conn, "session")
    dist_cols, dist_rows = _read_table(conn, "distraction")
    setting_cols, setting_rows = _read_table(conn, "setting")
    todo_cols, todo_rows = _read_table(conn, "todo")
    diary_cols, diary_rows = _read_table(conn, "diary")

    now = datetime.now()
    uid_map = {}
    users = []
    for row in user_rows:
        d = rowdict(user_cols, row)
        old = d["id"]
        new = str(uuid4())
        uid_map[old] = new
        users.append(dict(
            id=new, username=d["username"], nickname=d.get("nickname") or "",
            password_hash=d["password_hash"],
            security_question=d.get("security_question"), security_answer_hash=d.get("security_answer_hash"),
            created_at=_dt(d.get("created_at")) or now,
        ))

    todo_map = {}
    todos = []
    for row in todo_rows:
        d = rowdict(todo_cols, row)
        old = d["id"]
        new = str(uuid4())
        todo_map[old] = new
        todos.append(dict(
            id=new, text=d["text"], sort_order=d.get("sort_order") or 0,
            done=bool(d.get("done")), done_date=d.get("done_date"),
            is_daily=bool(d.get("is_daily")), streak=d.get("streak") or 0,
            last_checkin=d.get("last_checkin"),
            created_at=_dt(d.get("created_at")) or now,
            user_id=uid_map.get(d.get("user_id")),
        ))

    session_map = {}
    sessions = []
    for row in session_rows:
        d = rowdict(session_cols, row)
        old = d["id"]
        new = str(uuid4())
        session_map[old] = new
        sessions.append(dict(
            id=new, task_name=d.get("task_name") or "", planned_minutes=d.get("planned_minutes") or 15,
            actual_minutes=d.get("actual_minutes") or 0,
            started_at=_dt(d.get("started_at")) or now,
            ended_at=_dt(d.get("ended_at")),
            status=d.get("status") or "completed",
            user_id=uid_map.get(d.get("user_id")),
            todo_id=todo_map.get(d.get("todo_id")),
            device=d.get("device") or "desktop",
            stage=d.get("stage") or "training",
            completion_score=d.get("completion_score"),
            flow_score=d.get("flow_score"),
            reliance=d.get("reliance"),
            reflection=d.get("reflection"),
        ))

    distractions = []
    for row in dist_rows:
        d = rowdict(dist_cols, row)
        distractions.append(dict(
            id=str(uuid4()),
            session_id=session_map.get(d.get("session_id")),
            occurred_at=_dt(d.get("occurred_at")) or now,
            source=d.get("source") or "manual",
            app_name=d.get("app_name") or "",
            resolved_reason=d.get("resolved_reason"),
            duration_minutes=d.get("duration_minutes") or 0,
            user_id=uid_map.get(d.get("user_id")),
        ))

    settings = []
    for row in setting_rows:
        d = rowdict(setting_cols, row)
        settings.append(dict(
            id=str(uuid4()), key=d["key"], value=d.get("value") or "",
            user_id=uid_map.get(d.get("user_id")),
        ))

    diaries = []
    for row in diary_rows:
        d = rowdict(diary_cols, row)
        diaries.append(dict(
            id=str(uuid4()), date=d["date"], content=d.get("content") or "",
            user_id=uid_map.get(d.get("user_id")),
        ))

    for t in ("diary", "distraction", "setting", "todo", "session", "user"):
        conn.exec_driver_sql(f"DROP TABLE IF EXISTS {t}")

    _uuid_data = {
        "users": users, "sessions": sessions, "distractions": distractions,
        "settings": settings, "todos": todos, "diaries": diaries,
    }


def _restore_uuid_data() -> None:
    """把迁移暂存数据写回新结构表（create_all 之后调用）。"""
    global _uuid_data
    data = _uuid_data
    if not data:
        return
    from app.models import Diary, Distraction, FocusSession, Setting, Todo, User

    with Session(engine) as db:
        for d in data["users"]:
            db.add(User(**d))
        for d in data["todos"]:
            db.add(Todo(**d))
        for d in data["sessions"]:
            db.add(FocusSession(**d))
        for d in data["distractions"]:
            db.add(Distraction(**d))
        for d in data["settings"]:
            db.add(Setting(**d))
        for d in data["diaries"]:
            db.add(Diary(**d))
        db.commit()
    _uuid_data = None


def _migrate(target_engine=None) -> None:
    """轻量迁移：为已存在的旧库补新列/重建表（create_all 不会修改已存在表）。"""
    eng = target_engine or engine
    try:
        with eng.begin() as conn:
            tables = {row[0] for row in conn.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'")}
            # 1) 旧表补 user_id 列（先查 sqlite_master，避免对不存在表执行 PRAGMA 抛错）
            for table in ("session", "distraction", "setting"):
                if table not in tables:
                    continue
                cols = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
                if "user_id" not in cols:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN user_id INTEGER")
            if "user" in tables:
                cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(user)")}
                if "security_question" not in cols:
                    conn.exec_driver_sql("ALTER TABLE user ADD COLUMN security_question VARCHAR(100)")
                if "security_answer_hash" not in cols:
                    conn.exec_driver_sql("ALTER TABLE user ADD COLUMN security_answer_hash VARCHAR(200)")
            # 2) setting 旧结构（key 主键）→ 新结构（id 主键 + (key,user_id) 唯一）：
            #    SQLite 无法改主键，采用「建新表-复制-删旧-改名」，数据完整迁移
            if "setting" in tables:
                setting_cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(setting)")}
                if "id" not in setting_cols:
                    conn.exec_driver_sql(
                        "CREATE TABLE setting_new (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                        "key VARCHAR(50) NOT NULL, value VARCHAR NOT NULL, user_id INTEGER, "
                        "UNIQUE (key, user_id))"
                    )
                    conn.exec_driver_sql(
                        "INSERT INTO setting_new (key, value, user_id) SELECT key, value, user_id FROM setting"
                    )
                    conn.exec_driver_sql("DROP TABLE setting")
                    conn.exec_driver_sql("ALTER TABLE setting_new RENAME TO setting")
            # 3.5) 老库补 todo_id 列（待办来源）
            if "session" in tables:
                cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(session)")}
                if "todo_id" not in cols:
                    conn.exec_driver_sql("ALTER TABLE session ADD COLUMN todo_id INTEGER")
            # 3) 老库补 reliance 列（历史遗留）
            if "session" in tables:
                cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(session)")}
                if "reliance" not in cols:
                    conn.exec_driver_sql("ALTER TABLE session ADD COLUMN reliance VARCHAR(10)")
                if "reflection" not in cols:
                    conn.exec_driver_sql("ALTER TABLE session ADD COLUMN reflection VARCHAR(500)")
            # 4) 老库补 todo 打卡列
            if "todo" in tables:
                cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(todo)")}
                if "is_daily" not in cols:
                    conn.exec_driver_sql("ALTER TABLE todo ADD COLUMN is_daily INTEGER DEFAULT 0")
                if "done_date" not in cols:
                    conn.exec_driver_sql("ALTER TABLE todo ADD COLUMN done_date VARCHAR")
                if "streak" not in cols:
                    conn.exec_driver_sql("ALTER TABLE todo ADD COLUMN streak INTEGER DEFAULT 0")
                if "last_checkin" not in cols:
                    conn.exec_driver_sql("ALTER TABLE todo ADD COLUMN last_checkin VARCHAR")
    except Exception:
        pass  # 表不存在或无权限：由 create_all 或后续轮次处理


def init_db() -> None:
    """建表（幂等）+ 旧库 UUID 升级 + 轻量迁移。"""
    from app import models  # noqa: F401

    with engine.begin() as conn:
        _migrate_uuid(conn)
    SQLModel.metadata.create_all(engine)
    _restore_uuid_data()
    _migrate()


def get_session():
    """FastAPI 依赖：请求级数据库会话。"""
    with Session(engine) as session:
        yield session
