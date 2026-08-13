/** Worker 逻辑单测（Node 直接跑，不依赖 wrangler dev）。 */
import assert from "node:assert";
import worker, { b64url, b64urlToBytes, hashPassword, verifyPassword, createToken, verifyToken } from "./src/index.js";

/* ---------- mock D1 ---------- */
class MockStmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a; return this; }
  run() { return this.db.run(this.sql, this.args); }
  all() { return this.db.all(this.sql, this.args); }
  first() { return this.db.first(this.sql, this.args); }
}

class MockDB {
  constructor() { this.users = []; this.items = []; }
  prepare(sql) { return new MockStmt(this, sql); }
  run(sql, args) {
    if (sql.includes("INSERT INTO users")) {
      this.users.push({ id: args[0], username: args[1], password_hash: args[2], created_at: args[3] });
      return { success: true };
    }
    if (sql.includes("INSERT INTO sync_items")) {
      const [id, userId, type, payload, updatedAt, deleted] = args;
      const key = `${userId}|${type}|${id}`;
      const exist = this.items.find((i) => i._key === key);
      if (!exist || updatedAt > exist.updated_at) {
        if (exist) Object.assign(exist, { payload, updated_at: updatedAt, deleted });
        else this.items.push({ _key: key, id, user_id: userId, entity_type: type, payload, updated_at: updatedAt, deleted });
      }
      return { success: true };
    }
    throw new Error("unhandled run: " + sql);
  }
  all(sql, args) {
    if (sql.includes("SELECT id FROM users")) {
      return { results: this.users.filter((u) => u.username === args[0]).map((u) => ({ id: u.id })) };
    }
    if (sql.includes("FROM sync_items")) {
      const [userId, after] = args;
      return {
        results: this.items
          .filter((i) => i.user_id === userId && i.updated_at > after)
          .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
          .map((i) => ({ id: i.id, entity_type: i.entity_type, payload: i.payload, updated_at: i.updated_at, deleted: i.deleted })),
      };
    }
    throw new Error("unhandled all: " + sql);
  }
  first(sql, args) {
    if (sql.includes("SELECT id, username, password_hash FROM users")) {
      const u = this.users.find((x) => x.username === args[0]);
      return u ? { id: u.id, username: u.username, password_hash: u.password_hash } : null;
    }
    throw new Error("unhandled first: " + sql);
  }
}

/* ---------- 工具函数 ---------- */
function b64rt(s) {
  return new TextDecoder().decode(b64urlToBytes(b64url(new TextEncoder().encode(s))));
}

async function main() {
  // 1) base64url 往返（含中文）
  assert.strictEqual(b64rt("抖音回来专注"), "抖音回来专注");

  // 2) 密码哈希往返
  const h = await hashPassword("secret123");
  assert.ok(h.includes("$"));
  assert.strictEqual(await verifyPassword("secret123", h), true);
  assert.strictEqual(await verifyPassword("wrong", h), false);

  // 3) JWT 往返
  const token = await createToken("test-secret", "user-abc");
  assert.strictEqual(await verifyToken("test-secret", token), "user-abc");
  assert.strictEqual(await verifyToken("bad-secret", token), null);
  assert.strictEqual(await verifyToken("test-secret", "x.y.z"), null);

  // 4) API 流程：注册 → 登录 → 同步推拉
  const env = { DB: new MockDB(), JWT_SECRET: "test-secret" };
  const base = "http://localhost";
  const call = (path, opts = {}) => worker.fetch(new Request(base + path, opts), env);

  let res = await call("/register", { method: "POST", body: JSON.stringify({ username: "小明", password: "secret123" }) });
  assert.strictEqual(res.status, 200, "注册成功");
  const reg = await res.json();
  assert.ok(reg.token);

  res = await call("/register", { method: "POST", body: JSON.stringify({ username: "小明", password: "secret123" }) });
  assert.strictEqual(res.status, 409, "重名冲突");

  res = await call("/login", { method: "POST", body: JSON.stringify({ username: "小明", password: "secret123" }) });
  assert.strictEqual(res.status, 200, "登录成功");
  const login = await res.json();

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${login.token}` };

  // 推 2 条本地改动（todo + diary）
  res = await call("/sync", {
    method: "POST",
    headers,
    body: JSON.stringify({
      last_sync_at: "2026-08-11T00:00:00.000Z",
      changes: [
        { entity_type: "todo", id: "t-1", payload: { text: "背单词", done: true }, updated_at: "2026-08-11T10:00:00.000Z", deleted: false },
        { entity_type: "diary", id: "d-1", payload: { date: "2026-08-11", content: "写了周报" }, updated_at: "2026-08-11T10:05:00.000Z", deleted: false },
      ],
    }),
  });
  assert.strictEqual(res.status, 200);
  let s = await res.json();
  assert.strictEqual(s.changes.length, 0, "首次推送后无可拉取改动");

  // 拉取：last_sync_at 更早 → 返回刚推的 2 条
  res = await call("/sync", {
    method: "POST",
    headers,
    body: JSON.stringify({ last_sync_at: "2026-08-11T00:00:00.000Z", changes: [] }),
  });
  s = await res.json();
  assert.strictEqual(s.changes.length, 2, "能拉回自己推的改动");
  assert.strictEqual(s.changes[0].entity_type, "todo");

  // 冲突：云端已有更新版本，旧版本推送不覆盖
  const newer = await call("/sync", {
    method: "POST",
    headers,
    body: JSON.stringify({
      last_sync_at: "2026-08-11T00:00:00.000Z",
      changes: [
        { entity_type: "todo", id: "t-1", payload: { text: "背单词(旧)", done: false }, updated_at: "2026-08-11T09:00:00.000Z", deleted: false },
      ],
    }),
  }).then((r) => r.json());
  res = await call("/sync", { method: "POST", headers, body: JSON.stringify({ last_sync_at: "2026-08-11T00:00:00.000Z", changes: [] }) });
  s = await res.json();
  const t1 = s.changes.find((c) => c.id === "t-1");
  assert.strictEqual(t1.payload.text, "背单词", "云端较新版本不被旧推送覆盖");

  // 5) 未登录 / 错误 token
  res = await call("/sync", { method: "POST", body: JSON.stringify({}) });
  assert.strictEqual(res.status, 401, "无 token 拒绝");
  res = await call("/sync", { method: "POST", headers: { Authorization: "Bearer bad" }, body: JSON.stringify({}) });
  assert.strictEqual(res.status, 401, "坏 token 拒绝");

  console.log("Worker 单测全部通过 ✓");
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
