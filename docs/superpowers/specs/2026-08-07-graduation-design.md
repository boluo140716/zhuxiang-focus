# 毕业仪式与每场鼓励设计（2026-08-07）

- 状态：已获用户口头批准（2026-08-07）
- 依据：brainstorming/grill-me 结论（毕业仪式 + 毕业档案 + 重新训练 + 每场鼓励）

## 1. 背景与目标

v37 已有毕业双条件（近 28 天达标率 ≥ 60% 且 靠自己 ≥ 50%），但毕业时刻没有任何反馈，用户会困惑"然后呢"。本轮补上产品的终点体验与过程反馈：

- 每场鼓励：专注完成给盖章确认，表现好给一句鼓励
- 毕业仪式：达标毕业时庄重宣告，并提供毕业档案
- 重新训练：毕业后用户可自愿回到受训期，再走一轮

## 2. 每场鼓励（轻反馈）

- **香尽盖章**：专注到点（香燃尽）时，香旁出现一次朱砂印"盖下"动画（CSS 一次性动画，reduced-motion 禁用），纯视觉确认
- **鼓励语**：自评提交且「完成度 ≥ 80 且 本场无黑名单自动检测分心」→ toast 一句鼓励，3-5 组文案轮换（localStorage 记索引）
- 普通完成：只有盖章确认，不给鼓励语

## 3. 达标盖章动画

- 当天从"未达标"变"达标"的瞬间（完成本场后整天达标），今日大香字印章触发"盖下"动画（空心变实印时加缩放/震动）

## 4. 毕业仪式

- 完成本场后 eligible=true 且 未毕业 → 全屏仪式页：卷轴展开动画 +「你毕业了」+ 毕业日期 + 祝福 +「领取毕业」按钮
- 点击领取 → 后端记录毕业日期（graduated_at）
- **毕业后保持模式**：档位恒为 L3（黑名单不检测、无操作不补问、手机不感知、回神仪式不弹），只留计时 + 手动破功 + 统计

## 5. 毕业档案与重新训练

- 个人中心新增「毕业档案」面板：
  - 已毕业：毕业日期、阶段轨迹（受训 → 过渡 → 预备 → 毕业，按会话 stage 字段时间序列）、靠自己比例、「重新训练」按钮
  - 未毕业：显示近 4 周达标率与靠自己比例进度
- **重新训练**：确认后重置（graduated_at 清空、档位回 L1），可再次走递减并再次毕业

## 6. 技术实现

### 后端
- `app/services/training.py`：新增 `stage_timeline(sessions)`（按时间返回经历的档位名称序列）
- `app/routers/sessions.py`：PATCH complete 响应加 `auto_distracted`（本场是否有 auto_detect 分心）
- `app/routers/settings.py`：
  - GET /api/settings/graduation：{ eligible, graduated_at, rate_28d, self_rate_28d, stages }
  - POST /api/settings/graduation/claim：写 graduated_at
  - POST /api/settings/graduation/retrain：清 graduated_at、档位回 1
  - ritual-stage：已毕业恒返回 3
- `app/main.py`：monitor/settings 已毕业时黑名单置空

### 前端
- `static/index.html`：香尽盖章元素、毕业仪式 overlay、个人中心毕业档案面板
- `static/app.js`：香尽盖章触发、鼓励 toast（条件+轮换）、达标盖章动画、毕业仪式检查与领取、档案渲染与重新训练
- `static/style.css`：盖章动画、卷轴展开动画、档案面板样式

## 7. 测试

- pytest：auto_distracted 返回、claim/retrain、毕业后档位恒 3、毕业后黑名单空、stage_timeline
- jsdom：鼓励语条件（≥80 且无自动检测）、香尽盖章显示、毕业仪式弹出与领取、档案渲染、重新训练
- e2e：版本断言 + 视觉

## 8. 版本同步

- v37 → v38（index.html 两处 ?v=、sw.js CACHE/ASSETS、README 逃生地址、e2e 断言）

## 9. 不做（YAGNI）

- 证书分享/生成图片、毕业排名
- 鼓励音效、粒子特效
- 毕业后的阶段回退监测（毕业即信任，不监控）