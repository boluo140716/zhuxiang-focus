"""分心黑名单匹配（进程名/窗口标题子串，大小写不敏感）。

支持关键词自动扩展（如"抖音" → 抖音/douyin/tiktok），
并排除浏览器搜索结果页，避免误触发。
"""

# 常见应用关键词扩展：用户填左侧，右侧为自动扩展的匹配词
KEYWORD_EXPANSIONS = {
    "抖音": ["抖音", "douyin", "tiktok"],
    "微博": ["微博", "weibo", "sina"],
    "小红书": ["小红书", "xiaohongshu", "red"],
    "bilibili": ["bilibili", "b站", "哔哩哔哩", "bili"],
    "微信": ["微信", "wechat", "weixin"],
    "知乎": ["知乎", "zhihu"],
    "豆瓣": ["豆瓣", "douban"],
    "快手": ["快手", "kuaishou"],
    "今日头条": ["今日头条", "toutiao"],
    "百度贴吧": ["贴吧", "tieba"],
    "优酷": ["优酷", "youku"],
    "芒果TV": ["芒果tv", "mgtv", "mangotv"],
    "QQ音乐": ["qq音乐", "qqmusic"],
    "酷狗音乐": ["酷狗", "kugou"],
    "虎扑": ["虎扑", "hupu"],
    "4399": ["4399", "4399游戏"],
    "淘宝": ["淘宝", "taobao"],
    "京东": ["京东", "jd.com", "jingdong"],
    "爱奇艺": ["爱奇艺", "iqiyi"],
    "腾讯视频": ["腾讯视频", "tencent video", "qq video", "v.qq.com"],
    "网易云": ["网易云", "netease", "cloudmusic", "music.163.com"],
    "steam": ["steam"],
    "原神": ["原神", "genshin"],
    "英雄联盟": ["英雄联盟", "league of legends", "lol"],
    "斗鱼": ["斗鱼", "douyu"],
    "虎牙": ["虎牙", "huya"],
    "拼多多": ["拼多多", "pinduoduo", "pdd"],
    "美团": ["美团", "meituan"],
    "饿了么": ["饿了么", "eleme", "ele.me"],
    "抖音火山版": ["抖音火山", "huoshan"],
    "西瓜视频": ["西瓜视频", "ixigua"],
    "qq": ["qq", "tencent qq"],
    "钉钉": ["钉钉", "dingtalk"],
    "飞书": ["飞书", "feishu", "lark"],
    "telegram": ["telegram", "telegra"],
    "discord": ["discord"],
    "twitter": ["twitter", "x.com"],
    "facebook": ["facebook", "fb"],
    "instagram": ["instagram", "insta"],
    "youtube": ["youtube", "youtu"],
    "netflix": ["netflix"],
    "twitch": ["twitch"],
    "reddit": ["reddit"],
}

# 搜索引擎特征词：窗口标题包含这些词时判定为搜索结果页，不触发分心
SEARCH_ENGINE_PATTERNS = [
    "搜索", "搜索结果", "网页搜索", "search", "search results", "result", "google", "bing", "百度", "必应",
    "yahoo", "duckduckgo", "yandex", "sogou", "搜狗",
    "360搜索", "神马", "so.com", "baidu.com", "google.com",
    "bing.com", "sogou.com",
]

# 浏览器进程名
BROWSER_PROCESSES = {"chrome.exe", "msedge.exe", "firefox.exe", "browser.exe", "iexplore.exe"}

# 浏览器窗口标题统一后缀（如 "xxx - Google Chrome"），判定搜索页前先剥掉，
# 否则 Chrome 的任何页面都会因含 "google" 被误判为搜索结果页。
BROWSER_TITLE_SUFFIXES = [
    " - google chrome",
    " - microsoft edge",
    " - mozilla firefox",
    " - edge",
    " - chrome",
    " - firefox",
]

DEFAULT_BLACKLIST: list = []  # 默认空，由用户在设置页自行添加关键词


def _clean_browser_title(title: str) -> str:
    """去掉浏览器窗口标题的统一后缀，得到页面自身标题。"""
    t = (title or "").lower()
    for suffix in BROWSER_TITLE_SUFFIXES:
        if t.endswith(suffix):
            return t[: -len(suffix)]
    return t


def _is_search_result(title: str) -> bool:
    """判断窗口标题是否像搜索引擎结果页（先剥浏览器后缀）。"""
    t = _clean_browser_title(title)
    return any(p in t for p in SEARCH_ENGINE_PATTERNS)


def _expand_keyword(keyword: str) -> list[str]:
    """将用户填写的关键词展开为一整组匹配词（双向：填组内任意别名都返回整组）。"""
    k = keyword.strip().lower()
    for group in KEYWORD_EXPANSIONS.values():
        if any(k == a.lower() for a in group):
            return group
    return [keyword.strip()]


def match(window_title: str, process_name: str, blacklist) -> str | None:
    """命中返回黑名单条目，否则 None。

    规则：
    1. 关键词自动扩展（如"抖音" → 抖音/douyin/tiktok）
    2. 浏览器搜索结果页排除（标题含"搜索"等特征词）
    3. 进程名 + 窗口标题合并匹配
    """
    title_lower = (window_title or "").lower()
    proc_lower = (process_name or "").lower()
    is_browser = proc_lower in BROWSER_PROCESSES

    # 浏览器且像搜索结果页 → 跳过
    if is_browser and _is_search_result(window_title):
        return None

    haystack = f"{window_title or ''} {process_name or ''}".lower()

    for item in blacklist:
        if not item:
            continue
        expanded = _expand_keyword(item)
        for kw in expanded:
            if kw.lower() in haystack:
                return item
    return None
