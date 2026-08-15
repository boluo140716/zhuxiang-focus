# 篆香（Zhuxiang）

点一炷香，专注一炷香。不是约束工具，而是「觉察 → 训练 → 习惯」的专注力训练产品：连续达标后，脱离产品也能专注。

## 功能

- 香计时：开始一炷香，专注结束系统评分、盖章归档
- 分心检测：黑名单应用（抖音、B 站等）命中自动记录，实时提醒
- 打卡与待办：每日待办、连续达标天数
- 日记与复盘：记录每天的专注与反思
- 成长体系：受训期 → 过渡期 → 预备毕业，连续达标 28 天毕业
- 多端云同步：本地 SQLite 为真源，Cloudflare 增量同步，断网可用
- 桌面应用：系统托盘、桌面窗口、Windows 通知

## 安装使用

**桌面版（推荐）**：[下载 Zhuxiang-Setup-1.0.0.exe](https://github.com/boluo140716/zhuxiang-focus/releases/latest/download/Zhuxiang-Setup-1.0.0.exe)（约 37 MB），双击安装即用，数据保存在 `%LOCALAPPDATA%\Zhuxiang`。

**源码运行**：

```bash
pip install -r requirements.txt
python run.py
```

桌面监控（分心检测）要求程序由你本人在桌面会话启动，才能读取前台窗口。

## 技术栈

- 后端：FastAPI + SQLModel + SQLite
- 前端：原生 HTML/CSS/JS（无框架）
- 桌面壳：pywebview（WebView2）+ pystray 托盘
- 云同步：Cloudflare Workers + D1

## 目录结构

```
app/          后端（路由 / 服务 / 桌面监控 / 托盘）
static/       前端（页面 / 样式 / 脚本 / 图标）
cloudflare/   云端同步服务（Worker + D1 schema）
run.py        启动入口
```

手机端正在开发...敬请期待
