"""统计与洞察 API（设计 5.4）。"""
from datetime import date

from fastapi import APIRouter, Depends
from sqlmodel import Session as DBSession, select

from app.db import get_session
from app.deps import get_current_user
from app.models import Distraction, FocusSession, User
from app.services import insights as insights_service
from app.services import training as training_service

router = APIRouter(prefix="/api/stats", tags=["stats"])


def _load_data(db: DBSession, user_id: str):
    sessions = db.exec(select(FocusSession).where(FocusSession.user_id == user_id)).all()
    distractions = db.exec(select(Distraction).where(Distraction.user_id == user_id)).all()
    return sessions, distractions


@router.get("/daily")
def daily_stats(date_str: str | None = None, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    day = date.fromisoformat(date_str) if date_str else date.today()
    sessions, distractions = _load_data(db, user.id)
    result = insights_service.daily(sessions, distractions, day)
    result["qualified"] = training_service.is_qualified_day(sessions, day)
    return result


@router.get("/weekly")
def weekly_stats(date_str: str | None = None, db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    today = date.fromisoformat(date_str) if date_str else date.today()
    sessions, distractions = _load_data(db, user.id)
    data = insights_service.weekly(sessions, distractions, today)
    for day_item in data["days"]:
        day_item["qualified"] = training_service.is_qualified_day(sessions, date.fromisoformat(day_item["date"]))
    qualified = training_service.qualified_days(sessions)
    data["completion_rate"] = training_service.week_completion_rate(qualified, today)
    data["streak"] = training_service.compute_streak(qualified, sessions, today)
    data["graduation"] = training_service.graduation_status(sessions, today)
    data.update(insights_service.reliance_stats(sessions, 7, today))
    return data


@router.get("/insights")
def stats_insights(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    sessions, distractions = _load_data(db, user.id)
    return insights_service.insights(sessions, distractions)


@router.get("/reflections")
def stats_reflections(db: DBSession = Depends(get_session), user: User = Depends(get_current_user)):
    sessions, distractions = _load_data(db, user.id)
    return insights_service.reflections(sessions, distractions)
