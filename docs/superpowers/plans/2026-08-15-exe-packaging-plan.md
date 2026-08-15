# 篆香 EXE 安装包方案（2026-08-15）

## 目标

把当前 FastAPI + SQLite + 原生前端 + 云同步的本地产品，打包成 Windows 用户可双击安装的程序：安装向导、开始菜单/桌面快捷方式、卸载入口，无需用户装 Python。

## 验收标准

- 安装包在干净 Windows 环境安装后，双击即可打开产品（自动起服务 + 浏览器）
- 数据落在 `%LOCALAPPDATA%\FocusProject\data\focus.db`，卸载不影响数据（或提供保留选项）
- 随机端口，不冲突 8000；关窗/退出后后端进程一并退出
- 云同步、桌面监控（分心拦截）、导出导入、通知 toast 在 EXE 版全部可用
- 有产品图标（沿用印章视觉）

## 技术选型与取舍

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 打包器 | PyInstaller onedir（目录版） | 启动快、杀软误报少、日志可查；安装器负责"像单文件一样"的体验 |
| 安装器 | Inno Setup 6 | 免费、脚本化、卸载干净；需下载安装（winget） |
| 数据目录 | `%LOCALAPPDATA%\FocusProject` | 安装目录受 Program Files 写保护，数据必须外迁 |
| 端口 | 启动时绑定空闲端口（socket bind 0） | 避免 8000 被占 |
| 退出机制 | 页面"退出应用"按钮 → 调 shutdown API 优雅退出 | 可靠、无额外依赖；托盘方案需 pystray 依赖，先不做 |
| 图标 | static/icons/icon-512.png → icon.ico（Pillow） | 复用现有印章图标 |
| 依赖收集 | uvicorn / winotify(winsdk) 走 hidden-imports/collect | 这两个是 PyInstaller 打包的已知坑 |

## 实施步骤

1. ✅ 安装 PyInstaller（6.22.0），Python 3.14 兼容
2. ✅ 生成 icon.ico（Pillow 转换 icon-512.png）
3. ✅ 改 `app/db.py`：EXE 模式数据目录 `%LOCALAPPDATA%\FocusProject`
4. ✅ 改 `run.py`：随机端口 + 自动开浏览器 + `FOCUS_NO_BROWSER` 开关 + 启动日志
5. ✅ `POST /api/system/shutdown`（仅本机）+ 设置页"退出应用"按钮
6. ✅ PyInstaller spec：onedir + static 收集 + uvicorn/winsdk hidden imports + 图标
7. ✅ 打包 + 本机冒烟：启动、随机端口、首页、健康检查、退出全通过
   - 关键坑：windowed（无控制台）EXE 下 uvicorn 默认日志写无效 stderr 会卡启动 → EXE 模式 `log_config=None`
8. ✅ 安装 Inno Setup 6.7.3（winget），写 installer.iss（中文界面 + 桌面快捷方式 + 卸载）
9. ✅ 构建安装包 `packaging/installer/FocusProject-Setup-1.0.0.exe`（35MB）
   - 全流程验收：静默安装 → 启动（随机端口/health/首页）→ 退出 → 静默卸载 → 数据目录保留

## 风险与已知坑

- Python 3.14 较新：PyInstaller 需 ≥6.16（2026 年当前版本应已支持，先装验证）
- uvicorn 动态加载 loop/protocol：spec 里补 hidden imports，否则启动即崩
- winotify → winsdk 打包需 collect（DLL/数据文件）
- 杀软误报：onedir 缓解，PyInstaller 打的新 exe 首次运行可能被 SmartScreen 拦，需"仍要运行"
- 监控线程依赖交互桌面：EXE 由用户双击启动，天然满足（开发时以管理员/服务方式跑会失效，文档已注明）
- 中文路径/图标/版本资源：spec 用绝对路径，注意编码

## 验证方式

- PyInstaller 打包后：独立运行 `dist\FocusProject\FocusProject.exe` 冒烟
- Inno Setup 安装后：从开始菜单启动，走一遍核心链路
- 卸载后：确认数据目录仍在（提示用户）

## 待确认

- [x] 允许用 winget 安装 Inno Setup 6（外部软件）
- [x] 退出机制采用页面"退出应用"按钮（不做托盘）
