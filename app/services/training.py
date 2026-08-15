"""成长算法：达标日、连续天数、下周建议（设计 4.3 / 6）。"""
from datetime import date, timedelta


MIN_QUALIFY_MINUTES = 15  # 达标下限：当天完成时长至少 15 分钟（防止一分钟打卡刷达标）


def is_qualified_day(sessions, day: date) -> bool:
    """达标日：与 qualified_days 同一套规则（完成率/时长/完成度/心流）。"""
    return day in qualified_days(sessions)


def qualified_days(sessions) -> set:
    """返回所有达标日集合（完成率规则：放弃计入总投入，完成率>=60% 且 >=15 分钟）。"""
    by_day = {}
    for s in sessions:
        day = s.started_at.date()
        b = by_day.setdefault(day, {"done": 0, "invest": 0, "scores": [], "flow_ok": False})
        if s.status == "completed":
            b["done"] += s.actual_minutes
            b["invest"] += s.actual_minutes
            if s.completion_score is not None:
                b["scores"].append(s.completion_score)
            if s.flow_score is not None and s.flow_score >= 3:
                b["flow_ok"] = True
        elif s.status == "abandoned":
            b["invest"] += s.actual_minutes
    result = set()
    for d, b in by_day.items():
        if not b["scores"] or b["invest"] <= 0:
            continue
        avg = sum(b["scores"]) / len(b["scores"])
        if b["flow_ok"] and avg >= 60 and b["done"] >= MIN_QUALIFY_MINUTES and b["done"] >= b["invest"] * 0.6:
            result.add(d)
    return result


def compute_streak(qualified: set, sessions, today: date) -> int:
    """连续达标天数（激励信号）：无会话记录的天跳过（休息不断），有会话记录但未达标的天停止。"""
    recorded = {s.started_at.date() for s in sessions}
    if not recorded:
        return 0
    used_but_failed = {d for d in recorded if d not in qualified}
    d = today if today in qualified else today - timedelta(days=1)
    streak = 0
    while d not in used_but_failed and d >= min(recorded):
        if d in qualified:
            streak += 1
        d -= timedelta(days=1)
    return streak


def graduation_status(sessions, today: date) -> dict:
    """近 28 天毕业状态：达标率 >= 60% 且 靠自己比例 >= 50% 即可毕业。"""
    since = today - timedelta(days=27)
    qualified = qualified_days(sessions)
    day_count = 28
    days = {since + timedelta(days=i) for i in range(day_count)}
    rate = len(days & qualified) / day_count
    completed = [s for s in sessions if s.status == "completed" and since <= s.started_at.date() <= today]
    self_count = sum(1 for s in completed if s.reliance == "self")
    self_rate = self_count / len(completed) if completed else None
    eligible = rate >= 0.6 and self_rate is not None and self_rate >= 0.5
    return {"rate_28d": rate, "self_rate_28d": self_rate, "eligible": eligible}


def week_completion_rate(qualified: set, today: date) -> float:
    """最近 7 天达标率（达标日数 / 7）。"""
    days = {today - timedelta(days=i) for i in range(7)}
    hit = len(days & qualified)
    return hit / 7


def next_daily_streak(last_checkin: str | None, streak: int, today: str) -> int:
    """每日待办连续打卡：昨天打过则 +1，否则从 1 重新开始。"""
    yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    return streak + 1 if last_checkin == yesterday else 1




STAGE_NAMES = {"awareness": "受训期", "training": "过渡期", "habit": "预备毕业"}


def stage_timeline(sessions) -> list:
    """按时间返回用户经历过的档位名称序列（首次出现顺序，去重）。"""
    seen = []
    for s in sorted(sessions, key=lambda x: x.started_at):
        name = STAGE_NAMES.get(s.stage or "")
        if name and name not in seen:
            seen.append(name)
    return seen
