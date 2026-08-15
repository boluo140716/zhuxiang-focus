"""云同步引擎：本地 SQLite 为真源，Cloudflare Worker 为副本（多端同步阶段 4）。

每轮同步：推送本地 `updated_at > 游标` 的改动 → 拉取云端更新 → 后写覆盖 → 推进游标。
"""
import json
import os
from datetime import datetime, timezone

import httpx
from sqlmodel import Session as DBSession, select

from app.models import Diary, Distraction, FocusSession, Setting, Todo

CLOUD_BIND_KEY = "cloud_bind"      # { url, username, token }
CLOUD_CURSOR_KEY = "cloud_cursor"  # 上次同步游标（UTC ISO 字符串）
SYNC_EXCLUDED_KEYS = {CLOUD_BIND_KEY, CLOUD_CURSOR_KEY}

# 云端 workers.dev 国内直连不通，默认走本机 Clash 代理；可用环境变量 SYNC_PROXY 覆盖。
_SYNC_PROXY = os.environ.get("SYNC_PROXY", "http://127.0.0.1:7897")

SESSION_FIELDS = [
    "task_name", "planned_minutes", "actual_minutes", "started_at", "ended_at",
    "status", "todo_id", "device", "stage", "completion_score", "flow_score",
    "reliance", "reflection",
]
DISTRACTION_FIELDS = ["session_id", "occurred_at", "source", "app_name", "resolved_reason", "duration_minutes"]
TODO_FIELDS = ["text", "sort_order", "done", "done_date", "is_daily", "streak", "last_checkin", "created_at"]
DIARY_FIELDS = ["date", "content"]

MODELS = {
    "session": (FocusSession, SESSION_FIELDS),
    "distraction": (Distraction, DISTRACTION_FIELDS),
    "todo": (Todo, TODO_FIELDS),
    "diary": (Diary, DIARY_FIELDS),
}
DATETIME_FIELDS = {"started_at", "ended_at", "occurred_at", "created_at"}


def _utc_iso(dt) -> str:
    """本地 naive datetime → UTC ISO 字符串（跨端比较统一格式）。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _from_utc_iso(s) -> datetime | None:
    """UTC ISO 字符串 → 本地 naive datetime。"""
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)


def _record_ts(row) -> datetime:
    """记录的统一修改时间（updated_at 缺失时用各实体兜底字段）。"""
    if row.updated_at:
        return row.updated_at
    for f in ("created_at", "started_at", "occurred_at"):
        if hasattr(row, f) and getattr(row, f):
            return getattr(row, f)
    return datetime.now()


def get_bind(db: DBSession, user_id: str) -> dict | None:
    row = db.exec(select(Setting).where(Setting.key == CLOUD_BIND_KEY, Setting.user_id == user_id)).first()
    if not row:
        return None
    try:
        return json.loads(row.value)
    except Exception:
        return None


def get_cursor(db: DBSession, user_id: str) -> str:
    row = db.exec(select(Setting).where(Setting.key == CLOUD_CURSOR_KEY, Setting.user_id == user_id)).first()
    return row.value if row and row.value else "1970-01-01T00:00:00.000Z"


def save_cursor(db: DBSession, user_id: str, cursor: str) -> None:
    row = db.exec(select(Setting).where(Setting.key == CLOUD_CURSOR_KEY, Setting.user_id == user_id)).first()
    if row:
        row.value = cursor
        row.updated_at = datetime.now()
    else:
        db.add(Setting(key=CLOUD_CURSOR_KEY, value=cursor, user_id=user_id))


def _collect_changes(db: DBSession, user_id: str, cursor: str) -> list[dict]:
    changes = []
    for entity_type, (model, fields) in MODELS.items():
        rows = db.exec(
            select(model).where(model.user_id == user_id, model.updated_at != None)  # noqa: E711
        ).all()
        for r in rows:
            ts = _utc_iso(_record_ts(r))
            if cursor and ts <= cursor:
                continue
            item = {f: getattr(r, f) for f in fields}
            for f, v in item.items():
                if isinstance(v, datetime):
                    item[f] = _utc_iso(v)
            item["id"] = r.id
            item["updated_at"] = ts
            item["deleted"] = bool(getattr(r, "deleted", False))
            changes.append({"entity_type": entity_type, "id": r.id, "payload": item, "updated_at": ts, "deleted": item["deleted"]})
    # 设置：按行推送，排除绑定信息与游标自身
    setting_rows = db.exec(select(Setting).where(Setting.user_id == user_id)).all()
    for r in setting_rows:
        if r.key in SYNC_EXCLUDED_KEYS:
            continue
        ts = _utc_iso(_record_ts(r))
        if cursor and ts <= cursor:
            continue
        changes.append({
            "entity_type": "setting",
            "id": r.key,
            "payload": r.value,
            "updated_at": ts,
            "deleted": False,
        })
    return changes


def _apply_changes(db: DBSession, user_id: str, changes: list[dict]) -> int:
    applied = 0
    for c in changes:
        t, cid, ts = c.get("entity_type"), c.get("id"), c.get("updated_at")
        if not t or not cid or not ts:
            continue
        if t == "setting":
            if cid in SYNC_EXCLUDED_KEYS:
                continue
            row = db.exec(select(Setting).where(Setting.key == cid, Setting.user_id == user_id)).first()
            value = c.get("payload")
            if not isinstance(value, str):
                value = json.dumps(value, ensure_ascii=False)
            if row:
                row.value = value
                row.updated_at = _from_utc_iso(ts) or datetime.now()
            else:
                db.add(Setting(key=cid, value=value, user_id=user_id, updated_at=_from_utc_iso(ts)))
            applied += 1
            continue
        if t not in MODELS:
            continue
        model, fields = MODELS[t]
        row = db.get(model, cid)
        if c.get("deleted"):
            if row and not row.deleted:
                row.deleted = True
                row.updated_at = _from_utc_iso(ts)
                db.add(row)
                applied += 1
            continue
        payload = c.get("payload") or {}
        data = {}
        for f in fields:
            if f in payload and payload[f] is not None:
                v = payload[f]
                data[f] = _from_utc_iso(v) if f in DATETIME_FIELDS else v
        data["id"] = cid
        data["updated_at"] = _from_utc_iso(ts)
        if row is None:
            db.add(model(**data, user_id=user_id))
            applied += 1
            continue
        if _utc_iso(_record_ts(row)) and _utc_iso(_record_ts(row)) >= ts:
            continue  # 本地较新或相同，跳过
        for f, v in data.items():
            setattr(row, f, v)
        db.add(row)
        applied += 1
    db.commit()
    return applied


def run_sync(db: DBSession, user_id: str) -> dict:
    """执行一轮完整同步；未绑定或网络失败时返回原因，不影响本地使用。"""
    bind = get_bind(db, user_id)
    if not bind:
        return {"synced": False, "reason": "未绑定云端账号"}
    url = (bind.get("url") or "").rstrip("/")
    if not url:
        return {"synced": False, "reason": "云端地址未配置"}
    cursor = get_cursor(db, user_id)
    changes = _collect_changes(db, user_id, cursor)
    try:
        resp = httpx.post(
            f"{url}/sync",
            json={"last_sync_at": cursor, "changes": changes},
            headers={"Authorization": f"Bearer {bind.get('token', '')}"},
            timeout=120,
            proxy=_SYNC_PROXY,
        )
    except Exception:
        return {"synced": False, "reason": "云端连接失败（需联网或开启代理）"}
    if resp.status_code == 401:
        return {"synced": False, "reason": "云端登录已过期，请重新绑定"}
    if resp.status_code != 200:
        return {"synced": False, "reason": f"云端返回 {resp.status_code}"}
    pulled = resp.json().get("changes") or []
    applied = _apply_changes(db, user_id, pulled)
    ts_list = [c["updated_at"] for c in changes if c.get("updated_at")]
    ts_list += [c["updated_at"] for c in pulled if c.get("updated_at")]
    ts_list.append(cursor)
    save_cursor(db, user_id, max(ts_list))
    db.commit()
    return {"synced": True, "pushed": len(changes), "pulled": len(pulled), "applied": applied}
