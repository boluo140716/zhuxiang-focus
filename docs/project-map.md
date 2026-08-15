# 篆香 项目速查（2026-08-13）

本地单机专注力产品：FastAPI + SQLite + 原生前端 + Cloudflare Worker 云同步。本地为真源，断网可用。

## 文件地图

### 后端 `app/`
- `main.py`：FastAPI 入口，路由注册，monitor 内部端点
- `models.py`：6 张表，主键全部 UUID 字符串（`new_id()`），业务表带 `updated_at`/`deleted`
- `db.py`：engine、旧库自动迁移（int→UUID，迁移前备份 `.pre-uuid.bak`）
- `deps.py`：`get_current_user`（Bearer token）
- `routers/`：`auth`（注册/登录/头像/安全问题）、`data`（导出/导入）、`diary`、`distractions`、`notify`（winotify toast）、`sessions`、`settings`、`stats`、`sync`（云同步绑定/状态）、`todos`
- `services/`：`auth`（JWT+PBKDF2）、`backup`（导出/导入合并）、`blacklist`（分心关键词）、`insights`、`stage`、`sync`（同步引擎）、`training`
- `monitor/win_monitor.py`：Windows 前台窗口/进程检测

### 前端 `static/`（单页，版本号 `?v=N`）
- `index.html`（~700 行）、`app.js`（~2200 行）、`style.css`（~1000 行）
- `sw.js`：Service Worker 缓存（`CACHE = "yizhuxiang-vN"`）
- `favicon.svg/png`、`icons/`、`manifest.webmanifest`

### 云端 `cloudflare/`（Worker 同步服务）
- `src/index.js`：`/register` `/login` `/sync`（JWT + PBKDF2 + 后写覆盖）
- `schema.sql`、`wrangler.toml`（D1 `DB` 绑定）、`test_worker.mjs`
- 部署域名：`https://zuanxiang-sync.zuanxiang-focus.workers.dev`（需科学上网）

### 测试 `tests/`
- pytest：`test_*.py`（含 `test_sync.py` 同步引擎、`test_migration.py` UUID 迁移）
- `frontend_smoke.cjs`（jsdom，~299 项）、`e2e_smoke.cjs`（headless Chrome，~96 项）
- `cloudflare/test_worker.mjs`：Worker 逻辑单测

## 常用命令

```bash
python -m uvicorn app.main:app --port 8000      # 启动
python -m pytest -q                              # 后端串行（~33s）
python -m pytest -q -n 4                         # 后端并行（需本机验证）
node tests/frontend_smoke.cjs                    # 前端冒烟（~50s）
node tests/e2e_smoke.cjs                         # 端到端（~45s，真实 Chrome）
node cloudflare/test_worker.mjs                  # Worker 单测
python scripts/bump_version.py                   # 版本号 +1（同步 5 处）
python -m PyInstaller packaging/Zhuxiang.spec --noconfirm --distpath packaging/dist --workpath packaging/build  # 打包 EXE
'C:\Users\20486\AppData\Local\Programs\Inno Setup 6\ISCC.exe' packaging/installer.iss   # 构建安装包
```

## 版本现状

- 代码版本 v80（升级用 `scripts/bump_version.py`，勿手改）；EXE 安装包 1.0.0

## 已知坑

- PowerShell 禁用 `.ps1`：npm/npx/wrangler 用 `.cmd` 版（`npx.cmd`、`wrangler.cmd`）
- `*.workers.dev` 国内直连不通：后端走本机 Clash 代理（默认 `127.0.0.1:7897`，环境变量 `SYNC_PROXY` 覆盖），本地同步失败不阻塞使用
- 云端 Worker 受免费层 CPU 限制（10ms/请求）：PBKDF2 迭代已降到 1 万次（本地 auth.py 仍 20 万，两端哈希独立存储、互不验证）
- 云端同步必须用 D1 `batch` 批量写入：逐条写入几百条记录会拖到 70s+ 触发客户端超时（客户端超时已放宽至 120s）
- windowed（无控制台）EXE 下 uvicorn 默认日志写无效 stderr 会卡死启动：`run.py` 在 EXE 模式传 `log_config=None`，勿删
- EXE 数据目录在 `%LOCALAPPDATA%\Zhuxiang`（旧版 `FocusProject` 目录首次启动自动迁移）；卸载不删数据
- EXE 桌面形态用 pywebview（系统 WebView2）+ pystray 托盘：不弹浏览器；关窗最小化到托盘，托盘"退出"才结束进程（`run.py` 的 `_run_desktop`）
- 系统时区为 UTC：同步游标统一 UTC ISO（`app/services/sync.py` 的 `_utc_iso`）
- 中文经 PowerShell 管道传 Python 易乱码：用 UTF-8 文件或 `python -c`，别用内联中文 stdin
- pytest-xdist 在沙箱内无法运行（句柄限制），需本机验证
- 行尾约定：`index.html`/`style.css`/`app.js`/`tests/*.cjs` 用 CRLF；`sw.js`/README/docs 用 LF
- e2e 需要 Chrome（`C:/Program Files/Google/Chrome/...` 或 Edge 兜底）

## 架构要点

- 本地 SQLite 真源 + Cloudflare D1 副本；增量双向同步，`updated_at` 后写覆盖
- UUID 主键：多端不撞 id；`deleted` 软删除墓碑
- 两套账号：本地账号（登录用）+ 云端账号（同步归属），设置页绑定
- 设置入表：主题/提醒等存 `Setting` 表随账号同步；`cloud_bind`/`cloud_cursor` 自身不同步

## 当前待办

- 阶段 5：手机版（复用同步引擎，纯记录：香计时/打卡/日记）
- ~~EXE 安装包~~ ✅ 已完成（2026-08-15）：`packaging/installer/Zhuxiang-Setup-1.0.0.exe`
