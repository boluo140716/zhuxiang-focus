"""成长算法纯函数测试（完成率规则）。"""
from datetime import date, timedelta

from app.services import training


class FakeSession:
    def __init__(self, status, day, actual_minutes, score, flow_score=3):
        self.status = status
        self.started_at = datetime_combine(day)
        self.actual_minutes = actual_minutes
        self.completion_score = score
        self.flow_score = flow_score


def datetime_combine(day: date):
    from datetime import datetime

    return datetime(day.year, day.month, day.day, 10, 0)


def test_qualified_ok():
    s = FakeSession("completed", date(2026, 8, 3), 20, 70)
    assert training.is_qualified_day([s], date(2026, 8, 3))


def test_requires_score():
    s = FakeSession("completed", date(2026, 8, 3), 20, None)
    assert not training.is_qualified_day([s], date(2026, 8, 3))


def test_requires_flow():
    s = FakeSession("completed", date(2026, 8, 3), 20, 90, flow_score=2)
    assert not training.is_qualified_day([s], date(2026, 8, 3))


def test_avg_completion_below_60():
    a = FakeSession("completed", date(2026, 8, 3), 10, 70)
    b = FakeSession("completed", date(2026, 8, 3), 10, 40)
    assert not training.is_qualified_day([a, b], date(2026, 8, 3))  # 平均 55 < 60


def test_abandoned_over_40_percent_not_qualified():
    """放弃超过总投入 40% → 完成率 < 60% → 不达标（放弃仍计入投入）。"""
    done = FakeSession("completed", date(2026, 8, 3), 30, 80)
    ab = FakeSession("abandoned", date(2026, 8, 3), 30, None)
    assert not training.is_qualified_day([done, ab], date(2026, 8, 3))  # 30/60 = 50%


def test_abandoned_within_40_percent_qualified():
    """放弃不超过总投入 40% → 完成率 >= 60% → 达标。"""
    done = FakeSession("completed", date(2026, 8, 3), 40, 80)
    ab = FakeSession("abandoned", date(2026, 8, 3), 20, None)
    assert training.is_qualified_day([done, ab], date(2026, 8, 3))  # 40/60 = 66.7%


def test_minimum_floor():
    """完成时长不足 15 分钟 → 即使完成率 100% 也不达标（防刷）。"""
    s = FakeSession("completed", date(2026, 8, 3), 10, 90)
    assert not training.is_qualified_day([s], date(2026, 8, 3))


def test_early_high_quality_finish_ok():
    """提前高质量完成（无放弃）→ 完成率 100% 达标。"""
    s = FakeSession("completed", date(2026, 8, 3), 40, 90, flow_score=4)
    assert training.is_qualified_day([s], date(2026, 8, 3))


def test_qualified_days_set():
    ok = FakeSession("completed", date(2026, 8, 3), 20, 70)
    no = FakeSession("completed", date(2026, 8, 4), 10, 90)  # 低于 15 分钟下限
    assert training.qualified_days([ok, no]) == {date(2026, 8, 3)}


def _sessions_for(days):
    """为给定日期列表构造完成场次（score=70, flow=3，均达标）。"""
    return [FakeSession("completed", d, 20, 70) for d in days]


def test_streak():
    today = date(2026, 8, 3)
    days = [today - timedelta(days=i) for i in range(4)]  # 连续 4 天
    qualified = set(days)
    assert training.compute_streak(qualified, _sessions_for(days), today) == 4


def test_streak_today_not_done_yet():
    today = date(2026, 8, 3)
    days = [today - timedelta(days=i) for i in range(1, 5)]  # 今天未达标，从昨天起算
    qualified = set(days)
    assert training.compute_streak(qualified, _sessions_for(days), today) == 4


def test_streak_broken_restarts():
    today = date(2026, 8, 3)
    qualified = {today, today - timedelta(days=1), today - timedelta(days=3)}  # 前天(8/1)用了未达标
    sessions = _sessions_for([today, today - timedelta(days=1), today - timedelta(days=3)])
    sessions.append(FakeSession("abandoned", today - timedelta(days=2), 10, None))  # 断点
    assert training.compute_streak(qualified, sessions, today) == 2


def test_streak_skips_rest_days():
    """休息日（无会话记录）跳过：8/5、8/7 达标，8/6 休息 -> streak=2。"""
    today = date(2026, 8, 7)
    days = [date(2026, 8, 5), today]
    qualified = set(days)
    assert training.compute_streak(qualified, _sessions_for(days), today) == 2


def test_streak_fail_day_stops():
    """用了但未达标的天停止：8/6 未达标 -> streak 只数 8/7。"""
    today = date(2026, 8, 7)
    qualified = {today}
    sessions = _sessions_for([today, date(2026, 8, 5)])
    sessions.append(FakeSession("abandoned", date(2026, 8, 6), 10, None))
    assert training.compute_streak(qualified, sessions, today) == 1


def test_streak_no_records_zero():
    assert training.compute_streak(set(), [], date(2026, 8, 7)) == 0


def test_graduation_eligible():
    """近 28 天 17 天达标（>=60%）且全选靠自己 -> 可毕业。"""
    today = date(2026, 8, 7)
    days = [today - timedelta(days=i) for i in range(17)]
    sessions = _sessions_for(days)
    for s in sessions:
        s.reliance = "self"
    g = training.graduation_status(sessions, today)
    assert g["rate_28d"] >= 0.6
    assert g["self_rate_28d"] >= 0.5
    assert g["eligible"] is True


def test_graduation_not_eligible_low_rate():
    """达标率不足 -> 不可毕业。"""
    today = date(2026, 8, 7)
    days = [today - timedelta(days=i) for i in range(10)]
    sessions = _sessions_for(days)
    for s in sessions:
        s.reliance = "self"
    g = training.graduation_status(sessions, today)
    assert g["eligible"] is False


def test_graduation_not_eligible_low_self():
    """靠自己比例不足 -> 不可毕业。"""
    today = date(2026, 8, 7)
    days = [today - timedelta(days=i) for i in range(17)]
    sessions = _sessions_for(days)
    for s in sessions:
        s.reliance = "product"
    g = training.graduation_status(sessions, today)
    assert g["eligible"] is False


def test_graduation_no_completed_sessions():
    """近 28 天无完成场次 -> 靠自己为 None，不可毕业。"""
    today = date(2026, 8, 7)
    g = training.graduation_status([], today)
    assert g["self_rate_28d"] is None
    assert g["eligible"] is False

def test_stage_timeline():
    """按时间返回经历过的档位名称序列（去重保留首次顺序）。"""
    a = FakeSession("completed", date(2026, 8, 1), 20, 70)
    a.stage = "awareness"
    b = FakeSession("completed", date(2026, 8, 3), 20, 70)
    b.stage = "training"
    c = FakeSession("completed", date(2026, 8, 5), 20, 70)
    c.stage = "habit"
    assert training.stage_timeline([b, c, a]) == ["受训期", "过渡期", "预备毕业"]