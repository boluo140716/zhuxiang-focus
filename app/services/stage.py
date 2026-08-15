"""回神仪式自适应档位（纯函数，便于单测）。"""
from datetime import date

CLUSTER_WINDOW_MINUTES = 10  # 同一天内两次破功间隔 <= 10 分钟 = 连续破功
STAGE_L1, STAGE_L2, STAGE_L3 = 1, 2, 3
STAGE_TO_SESSION = {1: "awareness", 2: "training", 3: "habit"}


def _day_has_cluster(day_distractions) -> bool:
    """当天是否有两次破功时间差 <= 10 分钟。"""
    times = sorted(d.occurred_at for d in day_distractions)
    for a, b in zip(times, times[1:]):
        if (b - a).total_seconds() <= CLUSTER_WINDOW_MINUTES * 60:
            return True
    return False


def settle_stage(stage: int, distractions, today: date) -> int:
    """按近 7 天表现结算档位（每日调用一次，惰性）。

    - 无任何分心记录 -> 保持当前档位（新用户默认 L1）
    - 今天有连续破功 -> 升回 L1
    - L1 且距上次连续破功 >= 3 天 -> 降 L2
    - L2 且距上次破功 >= 7 天 -> 降 L3
    - 否则保持当前档位
    """
    if not distractions:
        return stage
    by_day = {}
    for d in distractions:
        by_day.setdefault(d.occurred_at.date(), []).append(d)
    if _day_has_cluster(by_day.get(today, [])):
        return STAGE_L1
    first_day = min(by_day)
    last_cluster = max((day for day, ds in by_day.items() if _day_has_cluster(ds)), default=None)
    # 从未连续破功 -> 从首次有记录那天起算观察期，避免新用户过早降档
    anchor = last_cluster if last_cluster is not None else first_day
    last_distraction = max(by_day)
    if stage == STAGE_L1 and (today - anchor).days >= 3:
        return STAGE_L2
    if stage == STAGE_L2 and (today - last_distraction).days >= 7:
        return STAGE_L3
    return stage
