# 回神仪式自适应档位实现计划（2026-08-07）

- 日期：2026-08-07
- 依据设计文档：docs/superpowers/specs/2026-08-07-ritual-stage-design.md

## 概览
把回神仪式从固定卡片变成三档（L1 受训期 / L2 过渡期 / L3 预备毕业），随近 7 天表现自动升降；新用户默认 L1；裸专注日当天不弹仪式。

## 后端

### 1. app/services/stage.py（新增，纯函数）
- `settle_stage(stage: int, distractions: list, today: date) -> int`
  - 无任何分心记录 → 保持当前档位（新用户默认 L1）
  - 今天有连续破功（同一天内两次破功时间差 ≤ 10 分钟）→ 返回 1
  - stage == 1 且距上次连续破功 ≥ 3 天 → 返回 2
  - stage == 2 且距上次破功 ≥ 7 天 → 返回 3
  - 否则保持当前档位
- 内部 helper：当天连续破功判定、最近连续破功日、最近破功日
- 连续破功窗口：同一天内两次破功间隔 ≤ 10 分钟（含边界）

### 2. app/routers/settings.py
- 新增 GET /api/settings/ritual-stage → `{ stage: 1|2|3, today_count: int }`
  - 读 Setting（key=ritual_stage，默认 "1"）
  - 惰性结算：用全部分心记录跑 settle_stage，结果变化则写回 Setting
  - today_count = 今天分心记录条数（供 L1 反馈「这是今天第 N 次回来」）

### 3. app/routers/sessions.py
- POST 创建会话时 session.stage 不再硬编码 "training"，改为档位映射：1→awareness / 2→training / 3→habit

## 前端

### 4. static/index.html
- 回神仪式卡片改造（保留标题「分心很正常，回来就好」与「我回来了，继续」按钮）：
  - 新增 #ritual-count：温和反馈行（默认 hidden）
  - 新增三个选项按钮：有点累 / 有点烦 / 就是走神了（默认 hidden）
  - 新增 #ritual-advice：建议行（默认 hidden）

### 5. static/app.js
- 启动时拉取 /api/settings/ritual-stage → state.ritualStage / state.ritualTodayCount
- startRitual() 按档位渲染：
  - stage == 3 或裸专注日 → 不弹卡片，静默继续
  - stage == 1 → 显示反馈 + 三选项 + 建议区，反馈文案「这是今天第 N 次回来，每一次都是练习」
  - stage == 2 → 只显示反馈行
- 选项点击：selected 高亮 + 设置建议文案（tired → 去接杯水，再回来；annoyed → 先做最简单的 5 分钟；zoned → 好，直接继续）
- 建议纯展示不落库；finishRitual 时重置选项选中态

### 6. static/style.css
- 选项按钮样式（贴合现有书道风格，轻量）+ 建议淡入动画

## 测试

### 7. tests/test_stage.py（新增 pytest）
- 连续破功判定：10 分钟窗口边界（≤10 分钟算、>10 分钟不算、跨天不算）
- 降档：L1 → L2（3 天无连续破功）、L2 → L3（7 天无破功）、逐级不跳级
- 升档回退：L3 出现连续破功 → 直接回 L1
- 无记录保持当前档位
- 接口测试：GET /api/settings/ritual-stage 返回档位与 today_count、惰性结算写回

### 8. tests/frontend_smoke.cjs
- stage 1：卡片含反馈 + 三选项 + 建议区；点选项出现对应建议
- stage 2：只显示反馈行
- stage 3 / 裸专注日：破功不弹仪式

### 9. tests/e2e_smoke.cjs
- 视觉断言 + 版本号断言同步

## 版本同步（v35 → v36）
- static/index.html 两处 ?v=
- static/sw.js CACHE / ASSETS
- README.md 逃生地址
- tests/e2e_smoke.cjs 版本断言

## 验证
- python -m pytest -q（全绿）
- node tests/frontend_smoke.cjs + node tests/e2e_smoke.cjs（全绿）
- 视觉 QA：临时 uvicorn + 临时 DB + headless Chrome 截图三档卡片，vision.js 识图确认
- 注意：后端改动需重启服务生效；前端刷新即可