"""黑名单匹配测试。"""
from app.services.blacklist import match


def test_match_window_title():
    assert match("抖音 - 直播", "chrome", ["抖音", "douyin"]) == "抖音"


def test_match_process_case_insensitive():
    assert match("", "DouyinApp", ["douyin"]) == "douyin"


def test_no_match():
    assert match("Visual Studio Code", "Code.exe", ["抖音"]) is None


def test_empty_inputs_safe():
    assert match("", "", ["抖音"]) is None
