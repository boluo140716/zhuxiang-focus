"""设置 API（设计 4.4 / 5.4）。"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session as DBSession, select

from app.db import get_session
from app.deps import get_current_user
from app.models import Distraction, FocusSession, User
from app.services.settings import get_settings, set_settings

router = APIRouter(prefix="/api/settings", tags=["settings"])


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
