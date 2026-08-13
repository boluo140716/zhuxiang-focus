"""设置 API（设计 4.4 / 5.4）。"""
import json

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from datetime import datetime
from sqlmodel import Session as DBSession, select

from app.db import get_session
from app.deps import get_current_user
from app.models import Distraction, FocusSession, Setting, User
from app.services.blacklist import DEFAULT_BLACKLIST

router = APIRouter(prefix="/api/settings", tags=["settings"])

DEFAULTS = {
    "blacklist": DEFAULT_BLACKLIST,
    "deep_start": "09:00",
    "deep_end": "11:00",
    "reminder_enabled": True,
    "naked_day": None,  # 裸专注日：1-7=周一至周日，None=不启用
    "ritual_stage": 1,  # 回神仪式档位：1 受训 / 2 过渡 / 3 预备毕业
    "graduated_at": None,  # 毕业日期（None=未毕业）
    # 设置入表（原浏览器 localStorage 键，随账号同步）：多端同步阶段 2
    "theme": "dark",
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
        row = db.exec(select(Setting).where(Setting.key == key, Setting.user_id == user_id)).first()
        if row:
            row.value = _dump(value)
            row.updated_at = datetime.now()
        else:
            db.add(Setting(key=key, value=_dump(value), user_id=user_id))
    db.commit()
    return get_settings(db, user_id)


def current_stage(db: DBSession, user_id: str | None) -> int:
    """当前干预档位：已毕业恒为 3（保持模式），否则读 ritual_stage。"""
    s = get_settings(db, user_id)
    if s.get("graduated_at"):
        return 3
    return int(s.get("ritual_stage", 1))


@router.get("")
def read_settings(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    return get_settings(db, user.id)


@router.put("")
def write_settings(body: dict, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    return set_settings(db, body, user.id)


@router.get("/ritual-stage")
def ritual_stage(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """回神仪式档位（惰性结算，已毕业恒为 3）+ 今天分心次数。"""
    from app.services.stage import settle_stage

    s = get_settings(db, user.id)
    current = int(s.get("ritual_stage", 1))
    distractions = db.exec(select(Distraction).where(Distraction.user_id == user.id)).all()
    if s.get("graduated_at"):
        stage = 3
    else:
        stage = settle_stage(current, distractions, date.today())
        if stage != current:
            set_settings(db, {"ritual_stage": stage}, user.id)
    today_count = sum(1 for d in distractions if d.occurred_at.date() == date.today())
    return {"stage": stage, "today_count": today_count}


@router.get("/graduation")
def graduation(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """毕业状态：是否达标、是否已毕业、档案数据。"""
    from app.services.training import graduation_status, stage_timeline

    sessions = db.exec(select(FocusSession).where(FocusSession.user_id == user.id)).all()
    g = graduation_status(sessions, date.today())
    s = get_settings(db, user.id)
    return {
        "eligible": g["eligible"],
        "graduated_at": s.get("graduated_at"),
        "rate_28d": g["rate_28d"],
        "self_rate_28d": g["self_rate_28d"],
        "stages": stage_timeline(sessions),
    }


@router.post("/graduation/claim")
def claim_graduation(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """领取毕业：达标且未毕业时记录毕业日期。"""
    from app.services.training import graduation_status

    sessions = db.exec(select(FocusSession).where(FocusSession.user_id == user.id)).all()
    if not graduation_status(sessions, date.today())["eligible"]:
        raise HTTPException(400, "尚未达到毕业条件")
    s = get_settings(db, user.id)
    if s.get("graduated_at"):
        return {"graduated_at": s["graduated_at"]}
    set_settings(db, {"graduated_at": date.today().isoformat()}, user.id)
    return {"graduated_at": date.today().isoformat()}


@router.post("/graduation/retrain")
def retrain(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    """重新训练：清空毕业记录，档位回受训期。"""
    set_settings(db, {"graduated_at": None, "ritual_stage": 1}, user.id)
    return {"ok": True}
