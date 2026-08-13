"""数据导出/导入：JSON 备份与数据搬家（多端同步阶段 1）。"""
from datetime import datetime

from sqlmodel import Session as DBSession, select

from app.models import Diary, Distraction, FocusSession, Todo
from app.routers.settings import get_settings, set_settings

SCHEMA_VERSION = 1

# 各表导出字段白名单（不含 user_id：导入时强制归属导入者）
SESSION_FIELDS = [
    "id", "task_name", "planned_minutes", "actual_minutes", "started_at", "ended_at",
    "status", "todo_id", "device", "stage", "completion_score", "flow_score",
    "reliance", "reflection",
]
DISTRACTION_FIELDS = [
    "id", "session_id", "occurred_at", "source", "app_name", "resolved_reason", "duration_minutes",
]
TODO_FIELDS = ["id", "text", "sort_order", "done", "done_date", "is_daily", "streak", "last_checkin", "created_at"]
DIARY_FIELDS = ["id", "date", "content", "updated_at"]


def _iso(value):
    """datetime → ISO 字符串（JSON 可序列化）。"""
    return value.isoformat() if isinstance(value, datetime) else value


def _parse(value):
    """ISO 字符串 → datetime（仅当能解析且是时间字段时）。"""
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return value
    return value


def _rows(model, fields, rows):
    return [{f: _iso(getattr(row, f)) for f in fields} for row in rows]


def serialize(db: DBSession, user_id: str) -> dict:
    """导出指定用户的全部数据（不含密码哈希/头像）。"""
    def all_rows(model):
        return db.exec(select(model).where(model.user_id == user_id)).all()

    todos = [t for t in all_rows(Todo) if not t.deleted]

    return {
        "app": "篆香",
        "schema_version": SCHEMA_VERSION,
        "exported_at": datetime.now().isoformat(),
        "data": {
            "sessions": _rows(FocusSession, SESSION_FIELDS, all_rows(FocusSession)),
            "distractions": _rows(Distraction, DISTRACTION_FIELDS, all_rows(Distraction)),
            "todos": _rows(Todo, TODO_FIELDS, todos),
            "diaries": _rows(Diary, DIARY_FIELDS, all_rows(Diary)),
            "settings": get_settings(db, user_id),
        },
    }


def deserialize_and_merge(db: DBSession, user_id: str, payload: dict) -> dict:
    """把备份 JSON 合并进指定用户的数据；返回导入统计。"""
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("备份文件版本不兼容，请用同版本应用导出的文件")
    data = payload.get("data") or {}
    imported = {"sessions": 0, "distractions": 0, "todos": 0, "diaries": 0, "settings": 0}
    skipped = 0

    # 1. 待办：同用户下标题相同视为重复跳过；id 未占用则保留，否则重分配
    todo_id_map = {}
    for row in data.get("todos", []):
        text = (row.get("text") or "").strip()
        if not text:
            skipped += 1
            continue
        exists = db.exec(select(Todo).where(Todo.user_id == user_id, Todo.text == text)).first()
        if exists:
            skipped += 1
            todo_id_map[row.get("id")] = exists.id
            continue
        fields = {f: _parse(row[f]) for f in TODO_FIELDS}
        if fields.get("id") and not db.get(Todo, fields["id"]):
            todo = Todo(**fields, user_id=user_id)
        else:
            fields.pop("id", None)
            todo = Todo(**fields, user_id=user_id)
        db.add(todo)
        db.flush()
        todo_id_map[row.get("id")] = todo.id
        imported["todos"] += 1

    # 2. 专注会话：id 冲突重分配；todo_id 通过映射对齐，映射不到则置空
    session_id_map = {}
    for row in data.get("sessions", []):
        fields = {f: _parse(row[f]) for f in SESSION_FIELDS}
        old_id = fields.get("id")
        old_todo_id = fields.get("todo_id")
        fields["todo_id"] = todo_id_map.get(old_todo_id) if old_todo_id is not None else None
        if old_id and not db.get(FocusSession, old_id):
            session = FocusSession(**fields, user_id=user_id)
        else:
            fields.pop("id", None)
            session = FocusSession(**fields, user_id=user_id)
        db.add(session)
        db.flush()
        session_id_map[old_id] = session.id
        imported["sessions"] += 1

    # 3. 分心记录：跟随会话映射；id 冲突重分配
    for row in data.get("distractions", []):
        fields = {f: _parse(row[f]) for f in DISTRACTION_FIELDS}
        old_id = fields.get("id")
        old_session_id = fields.get("session_id")
        fields["session_id"] = session_id_map.get(old_session_id) if old_session_id is not None else None
        if old_id and not db.get(Distraction, old_id):
            record = Distraction(**fields, user_id=user_id)
        else:
            fields.pop("id", None)
            record = Distraction(**fields, user_id=user_id)
        db.add(record)
        db.flush()
        imported["distractions"] += 1

    # 4. 日记：按 (date, user_id) 覆盖（备份还原语义）
    for row in data.get("diaries", []):
        date = row.get("date")
        content = row.get("content", "")
        if not date:
            skipped += 1
            continue
        exists = db.exec(select(Diary).where(Diary.user_id == user_id, Diary.date == date)).first()
        if exists:
            exists.content = content
            exists.updated_at = datetime.now()
            db.add(exists)
        else:
            db.add(Diary(date=date, content=content, user_id=user_id, updated_at=datetime.now()))
        imported["diaries"] += 1

    # 5. 设置：白名单内覆盖（set_settings 内部已过滤未知键）
    settings = data.get("settings") or {}
    known = {k: v for k, v in settings.items()}
    if known:
        set_settings(db, known, user_id)
        imported["settings"] = len(known)

    db.commit()
    return {"imported": imported, "skipped": skipped}
