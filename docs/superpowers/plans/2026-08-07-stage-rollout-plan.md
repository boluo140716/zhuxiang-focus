# 干预递减与毕业机制升级实现计划（2026-08-07）

- 日期：2026-08-07
- 依据设计文档：docs/superpowers/specs/2026-08-07-stage-rollout-design.md

## 后端

### 1. app/services/training.py
- `compute_streak(qualified, sessions, today)`：新增 sessions 参数
  - 无会话记录的天跳过（不设上限），有会话记录但未达标的天停止
  - 终止条件：d 早于最早记录日即停（防无限回溯）；无任何记录直接返回 0
- 新增 `graduation_status(sessions, today) -> dict`：
  - 近 28 个自然日达标率（达标日数 / 28）
  - 近 28 天完成场次中靠自己比例（reliance=self）
  - eligible = rate_28d >= 0.6 且 self_rate >= 0.5

### 2. app/routers/stats.py
- weekly：`compute_streak(qualified, sessions, today)` 传 sessions
- weekly：新增 `data["graduation"] = graduation_status(sessions, today)`

### 3. app/main.py
- `/api/monitor/settings`：档位 >= 3 时返回空 blacklist（监控线程不检测黑名单）

## 前端

### 4. static/app.js
- `pollDistract()`：`state.ritualStage >= 2` 时不弹分心卡片（L2 只记录，L3 无 hit）
- `handleVisibility()`：手机端 L3 不感知（不记录 hiddenAt）；L2 回来自动记默认原因不弹归因弹窗
- 电脑补问：L2/L3 不标记 idleFlag、不弹 overlay-idle
- 结业卷轴：改用 graduation 数据（近 4 周达标 X% · 靠自己 Y%），进度 = min(rate/0.6, self/0.5)；删除 GRAD_DAYS 常量

### 5. static/index.html
- 卷轴默认文案改为「近 4 周达标 0% · 靠自己 —」，hint 改为双条件说明

## 测试

### 6. tests/test_training.py（扩展）
- compute_streak：跳过休息日、用了未达标断、今天宽容、无记录返回 0、跨休息日连续
- graduation_status：达标率阈值、靠自己阈值、eligible 判定、无完成场次

### 7. tests/test_stats.py（扩展）
- weekly 返回 graduation 字段

### 8. tests/frontend_smoke.cjs（扩展）
- L2：黑名单命中不弹卡片、无操作不补问
- L3：手机归因不弹（L3 不感知）
- 卷轴：近 4 周达标文案 + 进度条
- weekly mock 增加 graduation

### 9. tests/e2e_smoke.cjs
- 版本断言 + 视觉

## 版本同步（v36 → v37）
- static/index.html 两处 ?v=、static/sw.js CACHE/ASSETS、README 逃生地址、tests/e2e_smoke.cjs 版本断言

## 验证
- pytest / jsdom / e2e 三套全绿
- 视觉 QA：headless Chrome 截图卷轴与 L2/L3 行为，vision.js 识图