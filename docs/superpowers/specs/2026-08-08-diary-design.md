# 日记工具设计（2026-08-08）

- 状态：已获用户口头批准（2026-08-08：完整日记 A 方案，全屏页 + 日期切换回看）

## 1. 背景与目标

「工具」分类目前只有计时器。本轮新增「日记」工具：每天写几句，按日期存档，可回看/补写任意一天。与计时器同属轻工具，复用全屏页模式。

## 2. 入口与页面

- 工具面板新增卡片：名称「日记」，描述「每天写几句，回看自己」，点击进入全屏页。
- 全屏页 `view-tool-diary`（复用 `view-tool-timer` 模式：隐藏 nav/brandbar，顶部返回）：
  - 顶部：返回按钮 + 标题「日记」+ 日期导航 `◀ 8/8 ▶`（左右切换日期，回看/补写）
  - 正文：大输入框 `textarea`，占满页面
  - 底部：保存按钮 + 「已保存 xx:xx」提示
  - **自动保存**：输入停顿 1.5s 自动保存，防写一半丢失

## 3. 数据

- 新表 `Diary`（由 `create_all` 自动创建，无需迁移）：id、date（YYYY-MM-DD，按用户唯一）、content、user_id、updated_at
- 接口：
  - `GET /api/diary?date=YYYY-MM-DD` → 当天日记（无则 `{ content: "" }`）
  - `PUT /api/diary` body `{ date, content }` → 保存（upsert）

## 4. 技术实现

### 后端
- `app/models.py`：`Diary` 模型，`UniqueConstraint(date, user_id)`
- `app/schemas.py`：`DiarySave`
- `app/routers/diary.py`：GET/PUT
- `app/main.py`：注册 diary 路由

### 前端
- `static/index.html`：工具面板日记卡片 + `view-tool-diary`
- `static/app.js`：`openDiaryTool/closeDiaryTool`、日期状态、加载/保存、自动保存定时器、`◀▶` 切换
- `static/style.css`：日记页输入框/日期导航样式
- 版本 v61 → v62

## 5. 测试

- `tests/test_diary.py`：GET 空、PUT 保存、重复 PUT 覆盖、数据按用户隔离
- `tests/frontend_smoke.cjs`：日记卡片存在、打开全屏页、输入保存请求发出、日期切换
- 三套全量回归：pytest、frontend_smoke、e2e_smoke
