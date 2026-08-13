# 复盘与自我觉察设计（2026-08-08）

- 状态：已获用户口头批准（2026-08-08：专注结束触发、可选填写、并入自评弹窗、统计页回看）
- 依据：brainstorming 结论（产品缺洞察层：分心原因"选了就没了"，没有沉淀与回看）

## 1. 背景与目标

目前分心的原因只在回神仪式里选一下（有点累 / 有点烦 / 就是走神了），选择后没有沉淀，用户也无法回看自己的模式。本轮补上「自我觉察」：在专注结束时，用 30 秒可选复盘，让用户写下这一场具体为什么分心；写下的内容沉淀下来，可在统计页回看。

## 2. 触发时机与形态

- **完成场次**：本场有分心记录（手动破功 / 命中黑名单 / 手机归因）时，在**现有质量自评弹窗**内追加一行「这一场为什么分心？（可选）」——不新弹窗，避免连弹两个。
- **放弃场次**：无自评弹窗，单独弹一个简短复盘窗「为什么放弃？（可选）」。
- 两者都可跳过（放弃场次的复盘窗提供「不用了」）；不写原因不影响结束流程。

## 3. 复盘内容

- 4 个快捷选项：有点累 / 有点烦 / 被打断 / 就是想刷会儿——点击填入输入框（可再编辑）。
- 自由输入框（placeholder 引导，如「抖音推送太诱人 / 突然有事被叫走」）。
- 提交时随会话一起保存；不写则留空。

## 4. 存储

- `FocusSession` 新增字段 `reflection: Optional[str]`（nullable，默认 None）。
- 用现有 `app/db.py::_migrate` 机制加列（参照 reliance 列迁移先例），幂等。

## 5. 回看（统计页「复盘」区块）

- 新增 GET `/api/stats/reflections`：最近 20 条写了复盘的会话（日期、任务名、复盘文本、状态 completed/abandoned、放弃标记），按时间倒序。
- 统计页在「洞察」下方新增「复盘」panel：无数据时显示引导文案；有数据时列出条目（日期 + 任务 + 文本），放弃的条目标注「放弃」。

## 6. 技术实现

### 后端
- `app/models.py`：`FocusSession.reflection: Optional[str]`
- `app/db.py`：`_migrate` 增加 reflection 列（幂等）
- `app/schemas.py`：`SessionUpdate` 增加 `reflection: Optional[str]`
- `app/routers/sessions.py`：PATCH 接受并保存 reflection
- `app/routers/stats.py` + `app/services/insights.py`：新增 `reflections(sessions)` 聚合（按日期倒序，取 reflection 非空的已完成/放弃会话）

### 前端
- `static/index.html`：
  - 自评弹窗（`overlay-review`）内新增「这一场为什么分心？（可选）」区块：4 快捷选项 + 输入框，`hidden` 默认隐藏，本场有分心才显示
  - 新增放弃复盘弹窗 `overlay-reflect`：标题「为什么放弃这场？」，4 快捷选项 + 输入框 + 「保存」/「不用了」
  - 统计页新增「复盘」panel
- `static/app.js`：
  - `state.sessionDistractions = 0`（本场分心计数），`recordDistraction` 成功后 +1，会话结束重置
  - `showReview()`：本场有分心时显示复盘输入区；快捷选项点击填入
  - `endSession("complete")`：payload 带 `reflection`（自评弹窗输入值）
  - 放弃流程：`endSession("abandon")` 前先显示 `overlay-reflect`；「保存」带 reflection 提交，「不用了」留空提交
  - `refreshStats()`：拉取 `/api/stats/reflections` 渲染复盘 panel
- `static/style.css`：复盘输入区/快捷选项样式（复用 chip / input 样式）
- 版本 v58 → v59

## 7. 测试

- `tests/test_sessions.py`：PATCH 保存 reflection；`_migrate` 加列幂等
- `tests/test_stats.py`：`/api/stats/reflections` 聚合与排序
- `tests/frontend_smoke.cjs`：
  - 完成场次（有分心）→ 自评弹窗显示复盘输入区，填写提交后 PATCH 带 reflection
  - 完成场次（无分心）→ 复盘输入区不显示
  - 放弃场次 → overlay-reflect 弹出，保存/跳过两条路径
  - 统计页复盘 panel 渲染
- 三套全量回归：pytest、frontend_smoke、e2e_smoke
