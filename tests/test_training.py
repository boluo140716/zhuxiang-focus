"""成长算法纯函数测试。"""
from datetime import date, timedelta

from app.services import training


class FakeSession:
    def __init__(self, status, day, actual_minutes, score):
        self.status = status
        self.started_at = datetime_combine(day)
        self.actual_minutes = actual_minutes
        self.completion_score = score


def datetime_combine(day: date):
    from datetime import datetime

    return datetime(day.year, day.month, day.day, 10, 0)


def test_qualified_day_requires_score():
    s = FakeSession("completed", date(2026, 8, 3), 20, None)
    assert not training.is_qualified_day([s], 15, date(2026, 8, 3))


def test_qualified_day_ok():
    s = FakeSession("completed", date(2026, 8, 3), 20, 70)
    assert training.is_qualified_day([s], 15, date(2026, 8, 3))


def test_streak():
    today = date(2026, 8, 3)
    qualified = {today - timedelta(days=i) for i in range(4)}  # 连续 4 天
    assert training.compute_streak(qualified, today) == 4


def test_streak_today_not_done_yet():
    today = date(2026, 8, 3)
    qualified = {today - timedelta(days=i) for i in range(1, 5)}  # 今天未达标
    assert training.compute_streak(qualified, today) == 4


def test_streak_broken_restarts():
    today = date(2026, 8, 3)
    qualified = {today, today - timedelta(days=1), today - timedelta(days=3)}  # 前天断了
    assert training.compute_streak(qualified, today) == 2


def test_next_target_rules():
    assert training.next_target(0.9, 15) == 20
    assert training.next_target(0.4, 15) == 10
    assert training.next_target(0.6, 15) == 15
    assert training.next_target(1.0, 60) == 60  # 上限
    assert training.next_target(0.0, 5) == 5  # 下限
