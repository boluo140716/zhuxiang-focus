"""成长算法：达标日、连续天数、下周建议（设计 4.3 / 6）。"""
from datetime import date, timedelta


def is_qualified_day(sessions, target_minutes: int, day: date) -> bool:
    """达标日：当天有会话实际时长 >= 目标*80% 且完成度自评 >= 60。"""
    for s in sessions:
        if s.status != "completed" or s.started_at.date() != day:
            continue
        if s.actual_minutes >= int(target_minutes * 0.8) and s.completion_score is not None and s.completion_score >= 60:
            return True
    return False


def qualified_days(sessions, target_minutes: int) -> set:
    """返回所有达标日集合。"""
    result = set()
    for s in sessions:
        if s.status == "completed" and s.completion_score is not None and s.completion_score >= 60:
            if s.actual_minutes >= int(target_minutes * 0.8):
                result.add(s.started_at.date())
    return result


def compute_streak(qualified: set, today: date) -> int:
    """连续达标天数：今天未达标时从昨天起算（不归零的友好语义）。"""
    d = today if today in qualified else today - timedelta(days=1)
    streak = 0
    while d in qualified:
        streak += 1
        d -= timedelta(days=1)
    return streak


def week_completion_rate(qualified: set, today: date) -> float:
    """最近 7 天达标率（达标日数 / 7）。"""
    days = {today - timedelta(days=i) for i in range(7)}
    hit = len(days & qualified)
    return hit / 7


def next_target(rate: float, current_target: int) -> int:
    """下周建议时长：完成率 > 80% 加 5 分钟；< 50% 减 5；否则不变。上限 60，下限 5。"""
    if rate > 0.8:
        return min(60, current_target + 5)
    if rate < 0.5:
        return max(5, current_target - 5)
    return current_target
