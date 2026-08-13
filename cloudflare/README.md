# 篆香多端同步服务（Cloudflare Worker + D1）

云端同步副本：注册/登录 + 增量双向同步。本地 SQLite 为真源，断网不影响使用。

## 部署（一次性）

在项目根目录执行（需要 [Cloudflare 账号](https://dash.cloudflare.com)）：

```bash
# 1. 登录授权（弹出浏览器，选择用 GitHub 注册的账号）
npx wrangler login

# 2. 创建 D1 数据库，把输出的 database_id 填入 cloudflare/wrangler.toml
npx wrangler d1 create zuanxiang-sync

# 3. 初始化表结构
npx wrangler d1 execute zuanxiang-sync --file=cloudflare/schema.sql

# 4. 设置 JWT 签名密钥（任意随机长字符串）
npx wrangler secret put JWT_SECRET

# 5. 部署
npx wrangler deploy
```

部署完成后，把输出的 Worker 域名（形如 `https://zuanxiang-sync.你的子域.workers.dev`）记录下来，配置到产品设置里。

## 本地验证

```bash
# 开发预览（本地起一个模拟环境，可先验证 API）
npx wrangler dev

# 健康检查
curl https://<worker域名>/health
```
