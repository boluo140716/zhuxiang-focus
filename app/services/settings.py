"""设置读写服务：默认值合并、部分更新、档位读取、Setting 行 upsert（供路由与业务层共用）。"""
import json
from datetime import datetime

from sqlmodel import Session as DBSession, select

from app.models import Setting
from app.services.blacklist import DEFAULT_BLACKLIST

DEFAULTS = {
    "blacklist": DEFAULT_BLACKLIST,
    "deep_start": "09:00",
    "deep_end": "11:00",
    "reminder_enabled": True,
    "naked_day": None,  # 裸专注日：1-7=周一至周日，None=不启用
    "ritual_stage": 1,  # 回神仪式档位：1 受训 / 2 过渡 / 3 预备毕业
    "graduated_at": None,  # 毕业日期（None=未毕业）
    # 设置入表（原浏览器 localStorage 键，随账号同步）：多端同步阶段 2
    "theme": "light",  # 默认白天模式（2026-08-15 起）
    "remind_sound": True,  # 香尽播放提示音
    "remind_notify": False,  # 香尽发送系统通知
    "remind_notify_distract": False,  # 分心时发送系统通知
    "timer_sound": True,  # 计时器结束提示音
}


def _dump(value) -> str:
    return json.dumps(value, ensure_ascii=False)


def _load(text: str):
    try:
        return json.loads(text)
    except Exception:
        return text


def upsert_setting(db: DBSession, user_id: str, key: str, value, updated_at: datetime | None = None) -> Setting:
    """创建或更新一条 Setting（key+user_id 唯一），返回行（未 commit）。"""
    row = db.exec(select(Setting).where(Setting.key == key, Setting.user_id == user_id)).first()
    if row:
        row.value = value
        row.updated_at = updated_at or datetime.now()
        db.add(row)
        return row
    row = Setting(key=key, value=value, user_id=user_id, updated_at=updated_at)
    db.add(row)
    return row


def get_settings(db: DBSession, user_id: str | None = None) -> dict:
    """默认值 + 指定用户的已存储值合并（监控内部读取可传 user_id）。"""
    result = dict(DEFAULTS)
    query = select(Setting).where(Setting.user_id == user_id)
    for row in db.exec(query).all():
        result[row.key] = _load(row.value)
    return result


def set_settings(db: DBSession, values: dict, user_id: str | None = None) -> dict:
    """部分更新，返回合并后的完整设置（按用户键）。"""
    for key, value in values.items():
        if key not in DEFAULTS:
            continue
        upsert_setting(db, user_id, key, _dump(value))
    db.commit()
    return get_settings(db, user_id)


def current_stage(db: DBSession, user_id: str | None) -> int:
    """当前干预档位：已毕业恒为 3（保持模式），否则读 ritual_stage。"""
    s = get_settings(db, user_id)
    if s.get("graduated_at"):
        return 3
    return int(s.get("ritual_stage", 1))
