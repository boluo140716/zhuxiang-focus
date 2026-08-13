"""版本号升级脚本：一次同步全部 5 处缓存版本引用。

用法（在项目根目录）：
    python scripts/bump_version.py            # 当前版本 +1
    python scripts/bump_version.py --to 81    # 指定目标版本
    python scripts/bump_version.py --dry-run  # 只预演，不写文件
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = [
    ROOT / "static" / "index.html",
    ROOT / "static" / "sw.js",
    ROOT / "README.md",
    ROOT / "tests" / "e2e_smoke.cjs",
    ROOT / ".e2e_artifacts" / "incense_qa.cjs",
]


def current_version() -> int:
    text = (ROOT / "static" / "sw.js").read_text(encoding="utf-8")
    m = re.search(r"yizhuxiang-v(\d+)", text)
    if not m:
        sys.exit("未在 static/sw.js 中找到 yizhuxiang-vN 版本号")
    return int(m.group(1))


def main() -> None:
    parser = argparse.ArgumentParser(description="升级缓存版本号（同步 5 处引用）")
    parser.add_argument("--to", type=int, default=0, help="目标版本号（默认当前 +1）")
    parser.add_argument("--dry-run", action="store_true", help="只预演不写文件")
    args = parser.parse_args()

    cur = current_version()
    new = args.to or cur + 1
    if new <= cur:
        sys.exit(f"目标版本 {new} 不大于当前 {cur}，已跳过")

    total = 0
    for path in FILES:
        if not path.exists():
            print(f"[跳过] {path.name}（文件不存在）")
            continue
        text = path.read_text(encoding="utf-8")
        changed = re.sub(rf"v={cur}\b", f"v={new}", text)
        changed = re.sub(rf"v{cur}\b", f"v{new}", changed)
        if changed == text:
            print(f"[跳过] {path.name}（无 v{cur} 引用）")
            continue
        count = text.count(f"v{cur}") + text.count(f"v={cur}")
        total += count
        if args.dry_run:
            print(f"[预演] {path.name}: v{cur} -> v{new}（{count} 处）")
        else:
            path.write_text(changed, encoding="utf-8")
            print(f"[更新] {path.name}: v{cur} -> v{new}（{count} 处）")
    print(f"共 {total} 处引用，v{cur} -> v{new}。跑前端冒烟 + e2e 确认。" if total else "未发现任何 v{cur} 引用")


if __name__ == "__main__":
    main()
