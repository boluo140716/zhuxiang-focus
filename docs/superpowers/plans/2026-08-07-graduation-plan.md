# 毕业仪式与每场鼓励实现计划（2026-08-07）

- 依据设计文档：docs/superpowers/specs/2026-08-07-graduation-design.md

## 后端

### 1. app/services/training.py
- 新增 `stage_timeline(sessions) -> list[str]`：按 started_at 排序，返回经历过的档位名称序列（awareness→受训期等映射，去重保留首次顺序）

### 2. app/routers/sessions.py
- PATCH complete：查询本会话 auto_detect 分心数，响应返回 `{"session": ..., "auto_distracted": bool}`（保留原 FocusSession 字段）

### 3. app/routers/settings.py
- `current_stage(db, user_id)` helper：已毕业（graduated_at 存在）→ 3，否则 ritual_stage
- ritual-stage 路由改用 helper
- GET /api/settings/graduation：{ eligible, graduated_at, rate_28d, self_rate_28d, stages }
- POST /api/settings/graduation/claim：eligible 且未毕业 → 写 graduated_at=today
- POST /api/settings/graduation/retrain：清 graduated_at、ritual_stage=1

### 4. app/main.py
- monitor/settings：已毕业时黑名单置空（用 current_stage helper）

## 前端

### 5. static/index.html
- 香旁加盖章元素（#incense-stamp，hidden）
- 毕业仪式 overlay（overlay-graduation：卷轴 + 文案 + 领取按钮）
- 个人中心毕业档案面板（graduation-panel：状态/日期/轨迹/重新训练按钮）

### 6. static/app.js
- state：prevQualified、incenseSealed、autoDistracted
- endSession complete：读 PATCH 响应 auto_distracted；满足条件 toast 鼓励（文案组轮换 localStorage 索引）
- updateIncense：香尽首次触发盖章动画
- refreshHome：daily.qualified 且 prevQualified=false → today-seal 盖章动画
- endSession 后检查 graduation：eligible 且未毕业 → 弹仪式；领取 → POST claim
- refreshProfile：拉 graduation 渲染档案；重新训练按钮 → confirm + POST retrain

### 7. static/style.css
- 盖章动画（scale/opacity，reduced-motion 禁用）
- 卷轴展开动画（简洁）
- 档案面板样式

## 测试

### 8. pytest
- test_sessions：complete 返回 auto_distracted
- test_settings：graduation GET/claim/retrain、毕业后 ritual-stage=3、monitor 黑名单空
- test_training：stage_timeline

### 9. jsdom
- 鼓励语：≥80 且无自动检测 → toast；有自动检测 → 不出现
- 香尽盖章：香尽后 stamp 可见
- 毕业仪式：eligible 且未毕业 → overlay 弹出；领取后消失
- 档案：毕业状态渲染、重新训练请求

### 10. e2e
- 版本断言 + 视觉

## 版本同步（v37 → v38）
- index.html 两处 ?v=、sw.js CACHE/ASSETS、README 逃生地址、e2e 断言

## 验证
- pytest / jsdom / e2e 三套全绿
- 视觉 QA：headless Chrome 截图盖章动画与毕业仪式，vision.js 识图