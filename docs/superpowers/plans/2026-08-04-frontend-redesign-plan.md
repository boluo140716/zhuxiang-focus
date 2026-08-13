# 一炷香：前端视觉重塑实现计划

- 日期：2026-08-04
- 依据设计文档：docs/superpowers/specs/2026-08-04-frontend-redesign-design.md
- 目标：品牌更名"一炷香" + 书道道场视觉 + 昼夜双模式，全部现有测试不回归

## 阶段总览（依赖顺序）
R1 设计令牌与样式重写（style.css）→ R2 页面结构（index.html + manifest）→ R3 交互逻辑（app.js + sw.js）→ R4 名称替换（后端/包/README/conftest）→ R5 测试更新 → R6 回归与视觉确认

## R1 设计令牌与样式重写（static/style.css）
- **保留不动**：`[hidden] { display:none !important; }` 规则、`* box-sizing`、body 最大宽 560px 响应式、弹窗显隐依赖 hidden 属性的约定。
- 新增 CSS 变量：
  - `:root`（夜）：`--bg:#14141c --panel:#1d1d28 --panel2:#26263a --text:#ece7dd --muted:#8f8a80 --accent:#c8443c --gold:#c9a05c --line:rgba(255,255,255,.08) --overlay-bg:rgba(12,12,18,.82)`
  - `@media (prefers-color-scheme: light) { :root:not([data-theme]) }`（昼）：`--bg:#f1ece2 --panel:#faf7f0 --panel2:#e7e0d2 --text:#221f1a --muted:#7c766b --accent:#b84238 --gold:#a8843c --line:rgba(0,0,0,.10) --overlay-bg:rgba(30,26,20,.50)`
  - `:root[data-theme="light"]` / `:root[data-theme="dark"]` 显式覆盖（优先级最高）
- 字体变量：`--font-display`（Noto Serif SC/宋体栈）、`--font-body`（system-ui/苹方/雅黑栈）。
- 组件样式（全部走变量）：
  - `#brandbar`：flex 品牌行，左 `.brand-seal`（28px 朱砂方印 + 白"香"字）+ 品牌名（衬线 18px），右 `#btn-theme`
  - 导航按钮：active 态用朱砂底；圆角 10→6px
  - `.cards`/`.card`：圆角 14→8px；数字用 `--font-display`
  - 新增 `.seal`（大印，56px）、`.seal-sm`（集印条小印，28px）、`.seal.done`（实心朱砂）、`.seal.empty`（朱砂描边透明）；`.week-seals` 7 枚横排，下方 `.seal-dow` 标注"今"（实印=今天那枚，其余空心）
  - `.btn-primary`：朱砂底；`.btn-ghost`：透明 + `--line` 描边；删除 `.btn-danger` 的亮红（放弃改 ghost，避免抢注意力）
  - `.timer`：`--font-display` + 64px + tabular-nums
  - `#week-chart`：`.day-bar.filled` 用朱砂，达标日加 `--gold` 顶边（可选）或保持朱砂
  - 新增 `.scroll-track`/`.scroll-fill`（结业卷轴细进度条，高 6px）
  - `.overlay` 遮罩用 `--overlay-bg`；`.overlay-box` 顶部加 `.box-seal`（18px 小印装饰）
  - `:focus-visible` 朱砂 outline；`prefers-reduced-motion` 时关闭主题过渡
- 验证：无 CSS 单测，靠 R5 的 e2e computed style + 截图人工确认。

## R2 页面结构（static/index.html + manifest.webmanifest）
- `index.html`：
  - `<title>` → 一炷香 专注训练营；资源版本 `?v=5` → `?v=6`；缓存版本注释同步
  - `<body>` 顶部新增品牌行：`<div id="brandbar">` 内含 `.brand-seal`（"香"）、`<span class="brand-name">一炷香</span>`、`<button id="btn-theme">`
  - 主页 `#home-idle` 今日区块新增：`#today-seal`（大印）+ `#week-seals`（7 枚 `.seal-sm` + 标注）
  - 统计页新增结业卷轴面板：`<div id="scroll-panel">` 内含 `#scroll-text`（"连续达标 X 天 · 距毕业约 N 周"）与 `.scroll-track > .scroll-fill`
  - 四个 `.overlay-box` 各加 `.box-seal` 装饰（位于标题前）
- `manifest.webmanifest`：`name` → "一炷香 专注训练营"，`short_name` → "一炷香"
- 验证：jsdom 断言新元素存在（R5）。

## R3 交互逻辑（static/app.js + static/sw.js）
- `app.js`：
  - 顶部新增 `THEMEKEY = "yizhuxiang-theme"`
  - `initTheme()`：读 `localStorage[THEMEKEY]` → 有则 `document.documentElement.dataset.theme`；无则不设（跟随系统）。`#btn-theme` 文案按当前主题显示另一面（"昼"/"夜"），点击切换 light/dark + 写入 localStorage + 文案同步
  - `refreshHome()` 追加：`#today-seal` 加 `done/empty` class（按 `daily.qualified`）；`#week-seals` 渲染 7 枚（按 `weekly.days[].qualified`，标注星期）
  - `refreshStats()` 追加：`#scroll-text` = "连续达标 X 天 · 距毕业约 N 周"（N = max(0, ceil((28−streak)/7))）；`.scroll-fill` 宽度 = min(streak/28, 1)×100%
  - 质量自评提交成功后调用 `refreshHome()`（若现有流程未触发，确保印章即时更新）
  - 顶部注释更新为"一炷香 前端逻辑"
- `sw.js`：`CACHE = "yizhuxiang-v6"`；预缓存列表 URL 全部带 `?v=6`；注释更新
- 验证：jsdom 主题切换/印章/卷轴断言（R5）；浏览器手测切换即时生效。

## R4 名称替换（后端/包/README/conftest）
- `app/main.py`：`FastAPI(title="一炷香 专注训练营")`
- `app/__init__.py`：docstring 改"一炷香 后端包"
- `package.json` / `package-lock.json`：`name` → `yizhuxiang`
- `tests/conftest.py`：临时目录前缀 → `yizhuxiang_test_`
- `README.md`：标题、PWA 安装名、防火墙 `DisplayName "Yizhuxiang 8000"`、逃生地址 `?v=6`、"页面卡在旧版本"章节同步；新增品牌与视觉说明一句
- 验证：`rg -i focusdojo`（排除 codex_chat、node_modules、旧 docs）0 命中

## R5 测试更新
- `tests/frontend_smoke.cjs`（jsdom）新增：
  - 品牌行与 `#btn-theme` 存在；点击后 `html[data-theme]` 与 `localStorage["yizhuxiang-theme"]` 正确
  - `#today-seal`、`#week-seals` 渲染；用 mock 的 daily/weekly 数据断言 done/empty class 与 7 枚数量
  - 结业卷轴文案与进度条宽度（streak=0 → N=4、宽 0%；streak=28 → N=0、宽 100%）
- `tests/e2e_smoke.cjs` 更新：
  - 缓存名断言 → `yizhuxiang-v6`
  - 新增昼夜背景色 computed style 断言（`--bg` 生效）
  - 截图补充：昼夜首页、统计页、设置页、自评弹窗（沿用现有截图命名规则，存 `.e2e_artifacts/`）
- 回归：现有全部断言保持通过

## R6 回归与视觉确认
- `python -m pytest -q`（30）全绿
- `node tests/frontend_smoke.cjs` 全绿
- `node tests/e2e_smoke.cjs` 全绿（无头浏览器 + 独立库）
- 截图人工确认（vision.js）：书道气质、无元素遮挡、弹窗真显隐、昼夜两套均可读
- 提交：实现计划 + 全部改动一个提交；交付信息附 code-review 双轴结论（按全局 AGENTS.md 规则）

## 风险与对策
- 弹窗显隐回归（历史坑）→ `[hidden]` 规则原样保留；e2e 视觉断言覆盖四个弹窗
- 用户浏览器旧缓存 → 缓存版本升 v6 + 逃生地址 `http://127.0.0.1:8000/?v=6` 写进 README 与交付说明
- 主题与系统偏好打架 → CSS 用 `:not([data-theme])` 限定系统跟随分支，显式 data-theme 优先
- 中文字体缺失（离线/跨端）→ 纯系统字体栈，无网络字体依赖；宋体缺失时 serif 兜底
- 印章数据依赖 → 已核实 `/api/stats/daily.qualified`、`/api/stats/weekly.streak/days[].qualified` 存在，无需后端改动
- 自评后印章不刷新 → R3 显式在自评提交成功后调 `refreshHome()`

## 编码规范
- 沿用现有：中文注释、`$()` 简写、元素显隐走 hidden 属性（禁止 class 控制 display）
- CSS 变量命名 `--xxx`，组件类名 kebab-case；不改后端逻辑与 API
- 每个阶段完成跑对应测试，全绿才进下一阶段；最终交付跑全量三套测试