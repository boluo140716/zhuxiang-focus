# 阶段 1 计划：数据导出/导入（2026-08-11）

## 目标

用户可将自己的全部数据导出为一个 JSON 文件，在另一台设备导入，实现数据搬家与备份；同时为阶段 2 表地基改造提供兜底。

## 接口设计

### 导出 `GET /api/data/export`

- 返回 JSON：`{ app: "篆香", schema_version: 1, exported_at, user_id, data: { sessions, distractions, todos, diaries, settings } }`
- 只导出当前登录用户的数据；不含密码哈希。
- 前端触发浏览器下载 `篆香数据备份-YYYYMMDD.json`。

### 导入 `POST /api/data/import`

- body 为导出 JSON；校验 `schema_version` 与数据完整性后合并入库。
- 合并策略：
  - `diaries`：按 `(date, user_id)` upsert，**导入覆盖本地**（备份还原语义）。
  - `settings`：按 `(key, user_id)` upsert，导入覆盖本地。
  - `todos`：按 `(text, user_id)` 去重，文本相同的跳过，其余新增（重新分配 id）。
  - `sessions` / `distractions`：按原始 id 去重，id 已被占用则重新分配新 id（内容保留）；分心记录随会话关联一起导入。
  - `streak` / `last_checkin`：导入后按最近打卡日重算。
- 返回 `{ imported: { sessions, distractions, todos, diaries, settings }, skipped: N }`。

## UI

- 设置页新增「数据」区（账号管理旁）：
  - 「导出数据」按钮 → 下载 JSON。
  - 「导入数据」按钮 → 文件选择，确认弹窗（"导入将合并/覆盖当前数据"）后上传。
- 导入成功 toast 提示并刷新当前页数据。

## 文件改动

- 新增 `app/routers/data.py`（导出/导入路由）；`app/main.py` 注册。
- 新增 `app/services/backup.py`（序列化/反序列化 + 合并逻辑）。
- `static/index.html`：设置页数据区；`static/app.js`：导出/导入逻辑；`static/style.css` 少量样式。
- 版本 v76 → v77（5 处同步）。

## 测试

- `tests/test_backup.py`：导出完整性（各表数据齐全）；导入空库；导入合并（日记覆盖/待办去重/id 冲突重分配）；越权（其他用户数据不可见）。
- `frontend_smoke.cjs`：设置页数据区按钮存在、导出触发 API。
- `e2e_smoke.cjs`：真实导出 → 换库导入 → 数据可查。
