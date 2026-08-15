"""统计聚合（纯函数，便于单测）。"""
from collections import Counter
from datetime import date, timedelta


def daily(sessions, distractions, day: date):
    day_sessions = [s for s in sessions if s.started_at.date() == day]
    day_distractions = [d for d in distractions if d.occurred_at.date() == day]
    completed = [s for s in day_sessions if s.status == "completed"]
    abandoned = [s for s in day_sessions if s.status == "abandoned"]
    focus_minutes = sum(s.actual_minutes for s in completed)
    distraction_minutes = sum(d.duration_minutes for d in day_distractions)
    by_hour = Counter(d.occurred_at.hour for d in day_distractions)
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
def weekly(sessions, distractions, today: date):
    days = [today - timedelta(days=i) for i in range(6, -1, -1)]
    prev = [today - timedelta(days=i) for i in range(13, 6, -1)]  # 上周 7 天
    return {
        "days": [daily(sessions, distractions, d) for d in days],
        "prev_week_days": [daily(sessions, distractions, d) for d in prev],
    }


def reliance_stats(sessions, days: int = 7, today=None):
    """最近 N 天完成场次中「靠自己」的比例（毕业机制/裸专注日的成长信号）。"""
    today = today or date.today()
    since = today - timedelta(days=days - 1)
    completed = [s for s in sessions if s.status == "completed" and s.started_at.date() >= since]
    self_count = sum(1 for s in completed if s.reliance == "self")
    product_count = sum(1 for s in completed if s.reliance == "product")
    rate = self_count / len(completed) if completed else None
    return {"self_sessions": self_count, "product_sessions": product_count, "self_rate": rate}


def insights(sessions, distractions, days: int = 14):
    """最近 N 天洞察：几点最容易破功。"""
    since = date.today() - timedelta(days=days)
    recent = [d for d in distractions if d.occurred_at.date() >= since]
    by_hour = Counter(d.occurred_at.hour for d in recent)
    worst = sorted(by_hour.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    return {
        "total_distractions": len(recent),
        "worst_hours": [{"hour": h, "count": c} for h, c in worst],
        "phone_pickups": len([d for d in recent if d.source == "phone_pickup"]),
        "auto_detected": len([d for d in recent if d.source == "auto_detect"]),
    }


def reflections(sessions, distractions=None, limit: int = 100):
    """最近写下复盘的会话：最近 7 天摘要 + 明细（按结束时间倒序）。"""
    QUICK = {"有点累", "有点烦", "被打断", "就是想刷会儿", "临时有事", "太难了", "静不下心", "本来就不想做"}
    written = [s for s in sessions if s.reflection and s.status in ("completed", "abandoned")]
    written.sort(key=lambda s: s.ended_at or s.started_at, reverse=True)
    recent = written[:limit]
    distracted_ids = {d.session_id for d in (distractions or []) if d.session_id}
    since7 = date.today() - timedelta(days=6)
    last7 = [s for s in recent if (s.ended_at or s.started_at).date() >= since7]
    top = Counter(s.reflection for s in last7 if s.reflection in QUICK).most_common(1)
    return {
        "summary": {
            "last7d_count": len(last7),
            "top_reason": {"text": top[0][0], "count": top[0][1]} if top else None,
        },
        "items": [
            {
                "date": (s.ended_at or s.started_at).strftime("%Y-%m-%d"),
                "task_name": s.task_name,
                "reflection": s.reflection,
                "status": s.status,
                "distracted": s.id in distracted_ids,
            }
            for s in recent
        ],
    }
