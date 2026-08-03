"""统计聚合（纯函数，便于单测）。"""
from datetime import date, timedelta


def _day(sessions, distractions, day: date):
    day_sessions = [s for s in sessions if s.started_at.date() == day]
    day_distractions = [d for d in distractions if d.occurred_at.date() == day]
    completed = [s for s in day_sessions if s.status == "completed"]
    abandoned = [s for s in day_sessions if s.status == "abandoned"]
    focus_minutes = sum(s.actual_minutes for s in completed)
    distraction_minutes = sum(d.duration_minutes for d in day_distractions)
    by_hour = {}
    for d in day_distractions:
        h = d.occurred_at.hour
        by_hour[h] = by_hour.get(h, 0) + 1
    return {
        "date": day.isoformat(),
        "focus_minutes": focus_minutes,
        "completed_sessions": len(completed),
        "abandoned_sessions": len(abandoned),
        "total_sessions": len(day_sessions),
        "distractions": len(day_distractions),
        "distraction_minutes": distraction_minutes,
        "distraction_by_hour": [{"hour": h, "count": c} for h, c in sorted(by_hour.items())],
    }


def daily(sessions, distractions, day: date):
    return _day(sessions, distractions, day)


def weekly(sessions, distractions, today: date):
    days = [today - timedelta(days=i) for i in range(6, -1, -1)]
    return {"days": [_day(sessions, distractions, d) for d in days]}


def insights(sessions, distractions, days: int = 14):
    """最近 N 天洞察：几点最容易破功。"""
    since = date.today() - timedelta(days=days)
    recent = [d for d in distractions if d.occurred_at.date() >= since]
    by_hour = {}
    for d in recent:
        h = d.occurred_at.hour
        by_hour[h] = by_hour.get(h, 0) + 1
    worst = sorted(by_hour.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    return {
        "total_distractions": len(recent),
        "worst_hours": [{"hour": h, "count": c} for h, c in worst],
        "phone_pickups": len([d for d in recent if d.source == "phone_pickup"]),
        "auto_detected": len([d for d in recent if d.source == "auto_detect"]),
    }
