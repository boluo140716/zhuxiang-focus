"""统计与洞察 API（设计 5.4）。"""
from datetime import date

from fastapi import APIRouter, Depends
from sqlmodel import Session as DBSession, select

from app.db import get_session
from app.models import Distraction, FocusSession
from app.routers.settings import get_settings
from app.services import insights as insights_service
from app.services import training as training_service

router = APIRouter(prefix="/api/stats", tags=["stats"])


def _load_data(db: DBSession):
    sessions = db.exec(select(FocusSession)).all()
    distractions = db.exec(select(Distraction)).all()
    return sessions, distractions


@router.get("/daily")
def daily_stats(date_str: str | None = None, db: DBSession = Depends(get_session)):
    day = date.fromisoformat(date_str) if date_str else date.today()
    sessions, distractions = _load_data(db)
    result = insights_service.daily(sessions, distractions, day)
    target = get_settings(db)["target_minutes"]
    result["qualified"] = training_service.is_qualified_day(sessions, target, day)
    return result


@router.get("/weekly")
def weekly_stats(date_str: str | None = None, db: DBSession = Depends(get_session)):
    today = date.fromisoformat(date_str) if date_str else date.today()
    sessions, distractions = _load_data(db)
    data = insights_service.weekly(sessions, distractions, today)
    target = get_settings(db)["target_minutes"]
    qualified = training_service.qualified_days(sessions, target)
    data["completion_rate"] = training_service.week_completion_rate(qualified, today)
    data["streak"] = training_service.compute_streak(qualified, today)
    return data


@router.get("/insights")
def stats_insights(db: DBSession = Depends(get_session)):
    sessions, distractions = _load_data(db)
    return insights_service.insights(sessions, distractions)


@router.get("/next_target")
def next_target(db: DBSession = Depends(get_session)):
    sessions, _ = _load_data(db)
    settings = get_settings(db)
    current = int(settings["target_minutes"])
    qualified = training_service.qualified_days(sessions, current)
    rate = training_service.week_completion_rate(qualified, date.today())
    suggested = training_service.next_target(rate, current)
    return {"current_target": current, "completion_rate": round(rate, 2), "suggested_target": suggested}
