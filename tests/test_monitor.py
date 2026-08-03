"""桌面监控纯逻辑测试。"""
from app.monitor.win_monitor import should_report


def test_report_on_window_change():
    assert should_report("a|a", "b|b", 0.0, 10.0) is True


def test_cooldown_same_window():
    assert should_report("douyin|抖音", "douyin|抖音", 100.0, 110.0) is False
    assert should_report("douyin|抖音", "douyin|抖音", 100.0, 400.0) is True


def test_no_previous_window():
    assert should_report(None, "x|x", 0.0, 1.0) is True
