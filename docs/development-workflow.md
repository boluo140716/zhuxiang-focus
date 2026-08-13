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

- 改完代码必做 code-review + ponytail-review + 对抗式自查四行
- 所有改动运行真实验证（pytest 单测 / jsdom / headless Chrome）
- 危险操作（删除、批量移动、改数据库）仍先征求同意
