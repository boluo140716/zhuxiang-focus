"""分心黑名单匹配（进程名/窗口标题子串，大小写不敏感）。"""
DEFAULT_BLACKLIST = ["抖音", "douyin", "抖音短视频", "抖音直播"]


def match(window_title: str, process_name: str, blacklist) -> str | None:
    """命中返回黑名单条目，否则 None。"""
    haystack = f"{window_title or ''} {process_name or ''}".lower()
    for item in blacklist:
        if item and item.lower() in haystack:
            return item
    return None
