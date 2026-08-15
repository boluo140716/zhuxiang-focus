/**
 * 篆香多端同步服务（Cloudflare Worker + D1）
 *
 * 本地 SQLite 为真源，D1 为云端同步副本（多端同步阶段 3/4 底座）。
 *
 * API：
 *   POST /register  { username, password }           -> { token, user }
 *   POST /login     { username, password }           -> { token, user }
 *   POST /sync      { last_sync_at, changes: [...] } -> { server_time, changes: [...] }
 *   GET  /health                                     -> { ok: true }
 *
 * 认证：JWT（HS256），密钥来自环境变量 JWT_SECRET（`npx wrangler secret put JWT_SECRET`）。
 * 密码：PBKDF2-SHA256（1 万次迭代，随机盐）。
 * 注意：云端迭代数低于本地 auth.py（20 万次），因 Workers 免费层 CPU 限制（10ms/请求）。
 * 两端哈希独立存储、互不验证，云端降强度不影响本地安全模型。
 */
const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 10_000;
const TOKEN_TTL = 7 * 24 * 3600;

/* ---------- 工具 ---------- */
export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body, status = 200) {
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res;
}

/* ---------- 密码哈希（PBKDF2-SHA256） ---------- */
export async function hashPassword(password) {
  const salt = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256
  );
  return `${salt}$${hex(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  const [salt, expected] = (stored || "").split("$");
  if (!salt || !expected) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256
  );
  return hex(new Uint8Array(bits)) === expected;
}

/* ---------- JWT（HS256） ---------- */
export async function createToken(secret, userId) {
  const header = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(
    enc.encode(JSON.stringify({ uid: userId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL }))
  );
  const signing = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signing));
  return `${signing}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyToken(secret, token) {
  try {
    const [header, payload, sig] = (token || "").split(".");
    if (!header || !payload || !sig) return null;
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sig), enc.encode(`${header}.${payload}`));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
    if (!data.exp || data.exp * 1000 < Date.now()) return null;
    return data.uid;
  } catch {
    return null;
  }
}

/* ---------- 业务 ---------- */
async function register(env, body) {
  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!username || password.length < 6) return json({ error: "用户名或密码不符合要求" }, 400);
  const exists = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).all();
  if (exists.results.length > 0) return json({ error: "用户名已被使用" }, 409);
  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  await env.DB.prepare(
    "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)"
  ).bind(id, username, hash, new Date().toISOString()).run();
  const token = await createToken(env.JWT_SECRET, id);
  return json({ token, user: { id, username } });
}

async function login(env, body) {
  const username = (body.username || "").trim();
  const row = await env.DB.prepare("SELECT id, username, password_hash FROM users WHERE username = ?").bind(username).first();
  if (!row || !(await verifyPassword(body.password || "", row.password_hash))) {
    return json({ error: "用户名或密码不正确" }, 401);
  }
  const token = await createToken(env.JWT_SECRET, row.id);
  return json({ token, user: { id: row.id, username: row.username } });
}

async function sync(env, body, userId) {
  const lastSyncAt = body.last_sync_at || "1970-01-01T00:00:00.000Z";
  const changes = Array.isArray(body.changes) ? body.changes : [];
  const pushed = new Set(
    changes.filter((c) => c && c.id && c.entity_type).map((c) => `${c.entity_type}:${c.id}`)
  );
  const upsert = env.DB.prepare(
    `INSERT INTO sync_items (id, user_id, entity_type, payload, updated_at, deleted) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, entity_type, id) DO UPDATE SET
       payload = excluded.payload, updated_at = excluded.updated_at, deleted = excluded.deleted
     WHERE excluded.updated_at > sync_items.updated_at`
  );
  const stmts = [];
  for (const c of changes) {
    if (!c || !c.id || !c.entity_type || !c.updated_at) continue;
    stmts.push(
      upsert.bind(c.id, userId, c.entity_type, JSON.stringify(c.payload || {}), c.updated_at, c.deleted ? 1 : 0)
    );
  }
  if (stmts.length > 0) await env.DB.batch(stmts);  // 批量写入：首次全量几百条时避免串行 D1 超时
  const rows = await env.DB.prepare(
    `SELECT id, entity_type, payload, updated_at, deleted FROM sync_items
     WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC`
  ).bind(userId, lastSyncAt).all();
  const results = rows.results
    .filter((r) => !pushed.has(`${r.entity_type}:${r.id}`))  // 本次推送的不回传（客户端游标推进后自然拿到云端更新）
    .map((r) => ({
      id: r.id,
      entity_type: r.entity_type,
      payload: JSON.parse(r.payload),
      updated_at: r.updated_at,
      deleted: !!r.deleted,
    }));
  return json({
    server_time: new Date().toISOString(),
    changes: results,
  });
}

/* ---------- 路由 ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return json({ ok: true }, 204);
    }
    try {
      if (request.method === "GET" && path === "/health") return json({ ok: true });
      if (request.method === "POST" && path === "/register") {
        return register(env, await request.json());
      }
      if (request.method === "POST" && path === "/login") {
        return login(env, await request.json());
      }
      if (request.method === "POST" && path === "/sync") {
        if (!env.JWT_SECRET) return json({ error: "服务端未配置 JWT_SECRET" }, 500);
        const auth = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        const userId = await verifyToken(env.JWT_SECRET, auth);
        if (!userId) return json({ error: "未登录或登录已过期" }, 401);
        return sync(env, await request.json(), userId);
      }
      return json({ error: "Not Found" }, 404);
    } catch (e) {
      return json({ error: e.message || "Internal Error" }, 500);
    }
  },
};
