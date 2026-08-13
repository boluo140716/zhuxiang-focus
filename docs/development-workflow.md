# 开发流程约定（2026-08-13）

目标：小改动快速交付，同时保住正确率。以下约定是长期合作的工作方式。

## 分层测试

按改动影响面选择测试层级，不无脑全跑：

- 只改前端（HTML/CSS/JS 文案、样式、交互）→ 跑 `node tests/frontend_smoke.cjs`；涉及缓存/版本引用时加 `node tests/e2e_smoke.cjs`
- 只改后端 Python → 跑相关 `python -m pytest tests/test_xxx.py`（按改动文件）
- 涉及多端/账号/同步/迁移等跨层改动 → 跑对应 pytest 文件 + frontend_smoke
- **阶段交付**（一个完整功能点收尾）→ 全量三套：`pytest` + `frontend_smoke` + `e2e_smoke`

## 版本号升级

不手工改 5 处，用脚本：

```bash
python scripts/bump_version.py            # 当前版本 +1
python scripts/bump_version.py --dry-run  # 先预演
```

脚本同步：`index.html`（注释 + 两处 `?v=`）、`sw.js`（CACHE/ASSETS）、`README`（逃生地址）、`tests/e2e_smoke.cjs`（4 处断言）、`.e2e_artifacts/incense_qa.cjs`。

## 小步提交

- 每个功能点完成后 commit 一次，审查只看增量（`git diff` 上一个提交），回滚容易
- 提交信息用中文，格式 `feat/fix: 一句话`
- 未经用户同意不 commit 属于「未授权」；用户已授权按功能点提交后，正常小步提交

## 质量兜底（不因提速而砍）

- 改完代码必做对抗式自查四行（我可能错在哪 / 改动最小 / 验证真实运行 / 安全）
- 所有改动运行真实验证（pytest 单测 / jsdom / headless Chrome）
- 危险操作（删除、批量移动、改数据库）仍先征求同意

## 审查分级（2026-08-13）

- **小改动**（纯文案/样式、单点修复，<50 行）：自查四行 + `ponytail-review`，跳过完整 `code-review`
- **中等改动**（新增/修改逻辑，50–200 行）：自查 + `ponytail-review` + `code-review` 双轴
- **大改动 / 阶段交付**（跨层、>200 行、涉及数据/同步/账号）：自查 + 双轴 `code-review` + 全量三套测试
- 纯文档改动只自查，不跑 review
- 审查固定点默认 = 上一个提交（`git diff HEAD`，含新增未跟踪文件）

## 后端测试并行（需本机验证）

```bash
python -m pytest -q -n 4   # pytest-xdist 已安装；沙箱内因句柄限制无法运行，请在本机确认
```
