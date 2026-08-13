"""桌面监控纯逻辑测试。"""
import pytest

from datetime import date

from app.monitor.win_monitor import (
    desktop_context,
    hit_snapshot,
    is_naked_day,
    reset_hit_state,
    should_report,
    update_hit_state,
)


@pytest.fixture(autouse=True)
def clean_hit_state():
    """HIT_STATE 为模块级全局，每个测试前后直接重置避免累计污染。"""
    reset_hit_state()
    yield
    reset_hit_state()


def test_is_naked_day_match():
    # 2026-08-05 是周三（isoweekday=3）
    assert is_naked_day({"naked_day": 3}, date(2026, 8, 5)) is True
    assert is_naked_day({"naked_day": 4}, date(2026, 8, 5)) is False
    assert is_naked_day({"naked_day": None}, date(2026, 8, 5)) is False
    assert is_naked_day({}, date(2026, 8, 5)) is False
    assert is_naked_day({"naked_day": 0}, date(2026, 8, 5)) is False  # 0 视为未启用
    assert is_naked_day({"naked_day": "abc"}, date(2026, 8, 5)) is False  # 非法值不抛错


def test_report_on_window_change():
    assert should_report("a|a", "b|b", 0.0, 10.0) is True


def test_cooldown_same_window():
    assert should_report("douyin|抖音", "douyin|抖音", 100.0, 110.0) is False
    assert should_report("douyin|抖音", "douyin|抖音", 100.0, 400.0) is True


def test_no_previous_window():
    assert should_report(None, "x|x", 0.0, 1.0) is True


def test_monitor_status_endpoint(client):
    r = client.get("/api/monitor/status")
    assert r.status_code == 200
    data = r.json()
    for key in ("alive", "desktop", "foreground_seen", "last_tick_at"):
        assert key in data
    # 测试环境未启动监控线程，alive 应为 False
    assert data["alive"] is False


def test_desktop_context_shape():
    # Windows 上应返回 (窗口站, 桌面) 二元组；取不到时返回 None 元素
    ws, desk = desktop_context()
    assert ws is None or isinstance(ws, str)
    assert desk is None or isinstance(desk, str)


def test_hit_state_first_hit_starts_timer():
    update_hit_state(True, "抖音", 100.0)
    s = hit_snapshot()
    assert s["hit"] is True and s["app"] == "抖音" and s["since"] == 100.0
    assert s["total"] == 0 and s["miss_since"] is None


def test_hit_state_keeps_since_and_accumulates_total():
    update_hit_state(True, "抖音", 100.0)
    update_hit_state(True, "抖音", 160.0)
    s = hit_snapshot()
    assert s["since"] == 100.0          # 连续命中不重置计时
    assert s["total"] == 60.0           # 累计 60 秒


def test_hit_state_short_miss_is_noise():
    # 短暂未命中（<=30s）视为检测噪声：保持连续计时并继续累计
    update_hit_state(True, "抖音", 100.0)
    update_hit_state(False, None, 130.0)
    s = hit_snapshot()
    assert s["hit"] is True and s["since"] == 100.0 and s["total"] == 30.0
    assert s["miss_since"] == 130.0
    update_hit_state(True, "抖音", 160.0)
    s = hit_snapshot()
    assert s["since"] == 100.0 and s["total"] == 60.0 and s["miss_since"] is None


def test_hit_state_long_miss_resets_keeps_total():
    # 未命中超过 30 秒（以首次 miss 为基准）视为切走：重置连续计时，累计保留
    update_hit_state(True, "抖音", 100.0)
    update_hit_state(True, "抖音", 160.0)
    update_hit_state(False, None, 200.0)  # miss 开始
    assert hit_snapshot()["hit"] is True  # 30 秒内仍是噪声
    update_hit_state(False, None, 250.0)  # miss 已 50 秒 > 30
    s = hit_snapshot()
    assert s["hit"] is False and s["since"] is None
    assert s["total"] == 100.0          # 60s 命中 + 40s 噪声窗口内累计
    update_hit_state(True, "抖音", 300.0)  # 切走后重新命中
    s = hit_snapshot()
    assert s["since"] == 300.0 and s["total"] == 100.0


def test_hit_state_force_reset_skips_noise_grace():
    # force=True 跳过噪声容忍，未命中立即重置（无会话/新会话时使用）
    update_hit_state(True, "抖音", 100.0)
    update_hit_state(False, None, 110.0, force=True)
    s = hit_snapshot()
    assert s["hit"] is False and s["since"] is None and s["miss_since"] is None


def test_hit_state_reset_total_on_session_end():
    update_hit_state(True, "抖音", 100.0)
    update_hit_state(True, "抖音", 160.0)
    update_hit_state(False, None, 200.0, reset_total=True, force=True)
    s = hit_snapshot()
    assert s["total"] == 0 and s["hit"] is False


def test_hit_endpoint(client):
    r = client.get("/api/monitor/hit")
    assert r.status_code == 200
    for key in ("hit", "app", "since"):
        assert key in r.json()
