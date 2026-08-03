# 专注训练营（FocusDojo）MVP 实现计划

- 日期：2026-08-03
- 依据设计文档：docs/superpowers/specs/2026-08-03-focus-training-design.md
- 目标：周末可完成、可自用的第一版 MVP

## 技术栈（已定）
FastAPI + SQLModel/SQLite + 单页前端（原生 JS，PWA）+ ctypes 桌面监控。
依赖：fastapi、uvicorn[standard]、sqlmodel、pytest、httpx。

## 阶段总览（依赖顺序）
P0 骨架 → P1 模型与 API → P2 统计洞察 → P3 前端核心 → P4 手机归因 → P5 桌面监控 → P6 达标算法 → P7 打磨交付

## P0 项目骨架
- requirements.txt、.gitignore（已有 data/、__pycache__）
- app/db.py：SQLite 引擎 + 建表（data/focus.db，目录自动创建）
- app/models.py：SQLModel 模型（见设计 5.3）
- app/main.py：FastAPI 实例 + 静态文件挂载 + GET /api/health
- run.py：uvicorn 启动（host 0.0.0.0，端口 8000，可参数覆盖）
- 验证：`python run.py` 启动，/api/health 返回 ok

## P1 数据模型与核心 API
- routers/sessions.py：
  - POST /api/sessions（body: task_name, planned_minutes, device, stage）→ 创建 running 会话；若已有 running 会话，先将其结束并标记 abandoned（唯一会话约束）
  - PATCH /api/sessions/{id}（action: complete/abandon，completion_score, flow_score）→ 结束会话，计算 actual_minutes（时间戳差值）
- routers/distractions.py：
  - POST /api/sessions/{id}/distractions（source: manual/auto_detect/phone_pickup，app_name, resolved_reason, duration_minutes）
  - POST /api/distractions（会话外独立记录）
- routers/settings.py：GET/PUT /api/settings（key-value，黑名单列表/目标时长/深度时段/提醒开关）
- 验证：pytest 覆盖 CRUD、唯一 running 约束、abandoned 自动收尾

## P2 统计与洞察
- routers/stats.py：GET /api/stats/daily（今日专注/分心汇总）、weekly（本周趋势）、insights（按小时聚合分心 → 几点最易破功）
- services/insights.py：聚合逻辑（纯函数，便于单测）
- 验证：pytest 用种子数据断言聚合结果

## P3 前端核心（单页）
- static/index.html + app.js + style.css：三个视图
  - 主页：未开始（启动仪式：任务名 + 时长）→ 进行中（倒计时、破功按钮、离开归因浮层）→ 结束（10 秒质量自评）→ 未达标日显示回弹任务入口
  - 统计：今日/本周卡片、连续达标天数、下周建议时长、几点易破功
  - 设置：黑名单管理、目标时长、深度时段、提醒开关
- 计时用时间戳差值（不依赖 setInterval 精度）；页面可见性变化时校正
- PWA：manifest.webmanifest（standalone + 图标）、sw.js（缓存静态资源，离线可开）
- 离线队列：写操作（开始/结束/分心/自评）先入 localStorage pending 队列，navigator.onLine + 在线事件触发补交，成功后出队
- 验证：桌面浏览器手测全流程；DevTools 模拟离线验证补交

## P4 手机端归因
- 进行中会话时监听 visibilitychange：
  - hidden → 记 phone_pickup 分心（duration 待定，回前台时结算）
  - visible → 结算时长，弹 3 秒归因（刷手机/工作/喝水/上厕所，默认刷手机，先记后改）
- 页面在后台时计时继续用时间戳差值结算，避免安卓浏览器冻结定时器问题
- 验证：安卓 Chrome 手测：开始 → 切走 1 分钟 → 回来弹归因 → 数据正确

## P5 电脑端监控
- app/monitor/win_monitor.py：ctypes 调 user32：
  - GetForegroundWindow → GetWindowTextW（标题）、GetWindowThreadProcessId + OpenProcess + QueryFullProcessImageNameW（进程名）
  - 每 2-5 秒轮询；命中黑名单且存在 running 会话 → POST distractions（source=auto_detect）
- app/services/blacklist.py：黑名单匹配（进程名/标题子串，大小写不敏感；默认含抖音客户端与 douyin 网页）
- 在岗检测（前端）：进行中监听 keydown/mousemove；超过阈值无操作 → 标记"可能走神"，回到页面时补问
- 监控线程随 run.py 启动；Windows 专属，非 Windows 自动跳过
- 验证：pytest 测 blacklist 匹配；手动：开抖音 → 2-5 秒内自动记分心

## P6 达标与成长算法
- services/training.py：
  - 达标日判定（设计 4.3：时长 ≥ 目标×80% 且完成度 ≥ 60）
  - 连续天数：不归零降级（连续天数保留，只标记"恢复日"）
  - 下周建议时长：本周完成率 > 80% 加 5 分钟；< 50% 降回；否则不变（上限 60 分钟）
- stats API 扩展：GET /api/stats/streak、/api/stats/next_target
- 验证：pytest 用合成数据断言连续天数与建议算法

## P7 打磨与交付
- README.md：安装、`python run.py` 启动、手机访问指引（查电脑局域网 IP + 防火墙放行）、数据备份（复制 data/focus.db）、安全提示（仅可信网络）
- tests/ 全部通过；手动冒烟清单（写进 README 或 docs/）
- 冒烟清单：① 桌面开会话→开抖音→自动记分心 ② 手机安装 PWA→跑一轮完整会话（开始/切走/归因/自评）③ 离线断网→操作→恢复联网→数据补交成功 ④ 重启服务数据仍在

## 风险与对策
- 安卓浏览器后台冻结定时器 → 一律时间戳差值结算，前端不做精确倒计时承诺
- Windows 前台窗口识别对全屏/特殊窗口可能失效 → 标题/进程双通道匹配，识别不到就跳过不误报
- PWA 通知在 MVP 不做 Web Push → 深度时段提醒降级为"打开页面时横幅提示"，v2 接推送
- 单用户无鉴权 → 仅限可信局域网，README 明示

## 编码规范
- 中文注释；routers 只做参数校验与响应，逻辑进 services（便于单测）
- 每个阶段结束跑 pytest，红了才进下一阶段
