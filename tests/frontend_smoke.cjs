/* 篆香 前端冒烟测试（jsdom）：核心流程 + 遗留会话自动结束 + 弹窗逃生 + 主题/印章/卷轴 */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require(path.join(__dirname, "..", "node_modules", "jsdom"));

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "static", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(ROOT, "static", "app.js"), "utf8");

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NOW = Date.now();
function daily(total = 0, qualified = false) {
  const today = new Date(NOW);
  const iso = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  return { date: iso, focus_minutes: 0, completed_sessions: 0, abandoned_sessions: 0, total_sessions: total, distractions: 0, distraction_minutes: 0, distraction_by_hour: [], qualified };
}
function weekly(opts = {}) {
  const days = [];
  const prevDays = [];
  const today = new Date(NOW);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - (6 - i) * 86400000);
    const iso = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    days.push({ date: iso, focus_minutes: opts.focusMinutes || 0, completed_sessions: opts.completedSessions || 0, qualified: !!(opts.qualifiedDays && opts.qualifiedDays.includes(6 - i)) });
  }
  for (let i = 13; i >= 7; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const iso = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    prevDays.push({ date: iso, focus_minutes: opts.prevFocusMinutes || 0, completed_sessions: 0, qualified: false });
  }
  const grad = opts.graduation !== undefined ? opts.graduation : { rate_28d: 0, self_rate_28d: null, eligible: false };
  return { days, prev_week_days: prevDays, completion_rate: 0, streak: opts.streak || 0, self_sessions: opts.selfSessions || 0, product_sessions: opts.productSessions || 0, self_rate: opts.selfRate !== undefined ? opts.selfRate : null, graduation: grad };
}

async function boot({ current = null, localSession = null, totalSessions = 0, qualified = false, weeklyOpts = {}, hit = null, insights = null, reflections = null, touch = false, settings = {}, noAuth = false, me401 = false, todos = [], view = null, ritualStage = null, graduation = null, autoHit = false } = {}) {
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8000/", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  const requests = [];
  let meNickname = "测试";
  const todoDb = todos.map((t) => ({ ...t }));
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || "GET";
    requests.push({ method, u, body: opts.body });
    if (u === "/api/settings") return { ok: true, status: 200, json: async () => ({ blacklist: [], target_minutes: 15, deep_start: "09:00", deep_end: "11:00", reminder_enabled: false, naked_day: null, ...settings }) };
    if (u === "/api/settings/ritual-stage") return { ok: true, status: 200, json: async () => (ritualStage || { stage: 1, today_count: 0 }) };
    if (u === "/api/settings/graduation") return { ok: true, status: 200, json: async () => (graduation || { eligible: false, graduated_at: null, rate_28d: 0, self_rate_28d: null, stages: [] }) };
    if (u === "/api/settings/graduation/claim" && method === "POST") return { ok: true, status: 200, json: async () => ({ graduated_at: "2026-08-07" }) };
    if (u === "/api/settings/graduation/retrain" && method === "POST") return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (u === "/api/auth/me" && method === "PATCH") { const b = JSON.parse(opts.body || "{}"); meNickname = b.nickname || "测试"; return { ok: true, status: 200, json: async () => ({ id: 1, username: "tester", nickname: meNickname, created_at: "2026-08-05T00:00:00" }) }; }
    if (u === "/api/auth/me") return me401 ? { ok: false, status: 401, json: async () => ({ detail: "登录已过期，请重新登录" }) } : { ok: true, status: 200, json: async () => ({ id: 1, username: "tester", nickname: meNickname, created_at: "2026-08-05T00:00:00" }) };
    if (u === "/api/auth/summary") return { ok: true, status: 200, json: async () => ({ total_focus_minutes: 320, total_completed: 12, total_distractions: 8, qualified_days: 5, self_rate: 0.75 }) };
    if (u === "/api/auth/password" && method === "POST") { const b = JSON.parse(opts.body || "{}"); if (b.old_password === "bad") return { ok: false, status: 400, json: async () => ({ detail: "旧密码不正确" }) }; return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    if (u === "/api/auth/register" && method === "POST") { const b = JSON.parse(opts.body || "{}"); return { ok: true, status: 200, json: async () => ({ token: "t-" + Date.now(), user: { id: 2, username: b.username, nickname: b.nickname || b.username } }) }; }
    if (u === "/api/auth/login" && method === "POST") { const b = JSON.parse(opts.body || "{}"); if (b.password === "bad") return { ok: false, status: 401, json: async () => ({ detail: "用户名或密码不正确" }) }; return { ok: true, status: 200, json: async () => ({ token: "t-" + Date.now(), user: { id: 1, username: b.username, nickname: "测试" } }) }; }
    if (u === "/api/auth/security" && method === "POST") return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (u.startsWith("/api/auth/security-question")) return { ok: true, status: 200, json: async () => ({ question: "你最喜欢的城市是？" }) };
    if (u === "/api/auth/reset-password" && method === "POST") return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (u === "/api/sessions/current") return current ? { ok: true, status: 200, json: async () => current } : { ok: false, status: 404, json: async () => ({}) };
    if (u === "/api/monitor/hit") return hit ? { ok: true, status: 200, json: async () => hit } : { ok: false, status: 404, json: async () => ({}) };
    if (u === "/api/stats/daily") return { ok: true, status: 200, json: async () => daily(totalSessions, qualified) };
    if (u === "/api/stats/weekly") return { ok: true, status: 200, json: async () => weekly(weeklyOpts) };
    if (u === "/api/stats/insights") return { ok: true, status: 200, json: async () => (insights || { total_distractions: 0, worst_hours: [], phone_pickups: 0, auto_detected: 0 }) };
    if (u === "/api/stats/reflections") return { ok: true, status: 200, json: async () => (reflections || { items: [] }) };
    if (u === "/api/diary" && method === "PUT") { const b = JSON.parse(opts.body || "{}"); return { ok: true, status: 200, json: async () => b }; }
    if (u.startsWith("/api/diary?date=")) return { ok: true, status: 200, json: async () => ({ date: u.split("date=")[1], content: "" }) };
    if (u.startsWith("/api/diary/search?q=")) { const q = decodeURIComponent(u.split("q=")[1] || ""); const all = [{ date: "2026-08-01", content: "去爬山，风景很好" }, { date: "2026-08-05", content: "写了周报" }]; return { ok: true, status: 200, json: async () => ({ items: all.filter((d) => d.content.includes(q)) }) }; }
    if (u === "/api/notify/toast" && method === "POST") return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (u === "/api/stats/next_target") return { ok: true, status: 200, json: async () => ({ suggested_target: 15 }) };
    if (u === "/api/sessions" && method === "POST") { const b = JSON.parse(opts.body || "{}"); return { ok: true, status: 201, json: async () => ({ id: 1, task_name: b.task_name, planned_minutes: b.planned_minutes, started_at: NOW, device: "desktop", stage: "training", status: "running", todo_id: b.todo_id || null }) }; }
    if (/^\/api\/sessions\/\d+$/.test(u) && method === "PATCH") return { ok: true, status: 200, json: async () => ({ session: { id: 1, status: "abandoned" }, auto_distracted: autoHit }) };
    if (/^\/api\/sessions\/\d+\/distractions$/.test(u) && method === "POST") return { ok: true, status: 201, json: async () => ({ id: 1 }) };
    if (u === "/api/distractions" && method === "POST") return { ok: true, status: 201, json: async () => ({ id: 1 }) };
    if (u === "/api/todos" && method === "GET") {
      return { ok: true, status: 200, json: async () => [...todoDb].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id) };
    }
    if (u === "/api/todos" && method === "POST") {
      const b = JSON.parse(opts.body || "{}");
      const t = { id: todoDb.length ? Math.max(...todoDb.map((x) => x.id)) + 1 : 1, text: b.text, sort_order: (todoDb.length ? Math.min(...todoDb.map((x) => x.sort_order)) : 0) - 1, done: false, is_daily: !!b.is_daily, streak: 0, done_date: null };
      todoDb.push(t);
      return { ok: true, status: 201, json: async () => t };
    }
    if (/^\/api\/todos\/\d+$/.test(u) && method === "PATCH") {
      const id = parseInt(u.split("/").pop(), 10);
      const b = JSON.parse(opts.body || "{}");
      const t = todoDb.find((x) => x.id === id);
      if (t) { if (b.text !== undefined) t.text = b.text; if (b.is_daily !== undefined) t.is_daily = b.is_daily; if (b.done !== undefined) { t.done = b.done; if (b.done) t.streak = (t.streak || 0) + 1; } }
      return { ok: true, status: 200, json: async () => t };
    }
    if (/^\/api\/todos\/\d+$/.test(u) && method === "DELETE") {
      const id = parseInt(u.split("/").pop(), 10);
      const i = todoDb.findIndex((x) => x.id === id);
      if (i >= 0) todoDb.splice(i, 1);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  if (localSession) window.localStorage.setItem("fd_local_session", JSON.stringify(localSession));
  if (!noAuth) window.localStorage.setItem("yizhuxiang-token", "test-token");
  if (view) window.localStorage.setItem("yizhuxiang-view", view);
  if (touch) {
    try { Object.defineProperty(window, "ontouchstart", { value: () => {}, configurable: true }); } catch (e) {}
    try { Object.defineProperty(window.navigator, "maxTouchPoints", { value: 5, configurable: true }); } catch (e) {}
  }
  window.eval(appJs);
  await sleep(120); // 等 init() 的异步请求完成
  return { dom, window, requests };
}

(async () => {
  console.log("== T1 全新用户（无会话）→ 首页 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    check("home-idle 可见", !doc.getElementById("home-idle").hidden);
    check("home-running 隐藏", doc.getElementById("home-running").hidden);
    check("idle 弹窗隐藏", doc.getElementById("overlay-idle").hidden);
    check("startup 弹窗隐藏", doc.getElementById("overlay-startup").hidden);
    check("首页有「开始专注」按钮", !!doc.getElementById("btn-start"));
    check("页面标题正常", doc.querySelector("#today-title").textContent === "今天");
  }

  console.log("== T2 遗留本地旧会话（2小时前）→ 自动结束回首页 ==");
  {
    const { window, requests } = await boot({
      localSession: { clientKey: "sk-old", task_name: "旧任务", planned_minutes: 15, started_at: NOW - 2 * 3600 * 1000 },
    });
    const doc = window.document;
    check("localStorage 已清除", window.localStorage.getItem("fd_local_session") === null);
    check("home-idle 可见", !doc.getElementById("home-idle").hidden);
    check("home-running 隐藏", doc.getElementById("home-running").hidden);
    check("idle 弹窗隐藏", doc.getElementById("overlay-idle").hidden);
    check("toast 提示自动结束", (doc.getElementById("toast").textContent || "").includes("自动结束"));
  }

  console.log("== T3 近期本地会话（2分钟前）→ 进入专注视图 ==");
  {
    const { window } = await boot({
      localSession: { clientKey: "sk-new", task_name: "写周报", planned_minutes: 15, started_at: NOW - 2 * 60 * 1000 },
    });
    const doc = window.document;
    check("home-running 可见", !doc.getElementById("home-running").hidden);
    check("home-idle 隐藏", doc.getElementById("home-idle").hidden);
    check("任务名正确", doc.getElementById("running-task").textContent === "写周报");
    check("idle 弹窗隐藏", doc.getElementById("overlay-idle").hidden);
  }

  console.log("== T4 服务端有 running 会话 → 专注视图 ==");
  {
    const { window } = await boot({
      current: { id: 7, task_name: "服务端任务", planned_minutes: 25, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
    });
    const doc = window.document;
    check("home-running 可见", !doc.getElementById("home-running").hidden);
    check("任务名正确", doc.getElementById("running-task").textContent === "服务端任务");
    check("香元素存在", !!doc.getElementById("incense") && !!doc.getElementById("incense-ash") && !!doc.getElementById("incense-tip") && !!doc.getElementById("incense-burner"));
    check("已燃分钟显示", /^已燃 \d+ 分钟$/.test(doc.getElementById("incense-time").textContent));
  }

  console.log("== T4b 香燃烧：进度 + 香尽 ==");
  {
    const { window } = await boot({
      current: { id: 8, task_name: "香测试", planned_minutes: 15, started_at: NOW - 3 * 60 * 1000, device: "desktop", stage: "training", status: "running" },
    });
    const doc = window.document;
    check("已燃 3 分钟", doc.getElementById("incense-time").textContent === "已燃 3 分钟");
    check("香身剩约 80%", doc.getElementById("incense-burn").style.height === "80%");
    check("香头在 20%", doc.getElementById("incense-tip").style.top === "20%");
    check("香尽提示隐藏", doc.getElementById("incense-done").hidden);
  }
  {
    const { window } = await boot({
      current: { id: 9, task_name: "香尽测试", planned_minutes: 15, started_at: NOW - 16 * 60 * 1000, device: "desktop", stage: "training", status: "running" },
    });
    const doc = window.document;
    check("香尽提示显示", !doc.getElementById("incense-done").hidden);
    check("香尽后不再继续计时", doc.getElementById("incense-time").textContent === "已燃 15 分钟");
    check("香头熄灭", doc.getElementById("incense-tip").style.opacity === "0");
    check("香身燃尽 0%", doc.getElementById("incense-burn").style.height === "0%");
  }
  {
    // 香尽触发系统通知（开关开启时只触发一次）
    const { window, requests } = await boot({
      current: { id: 10, task_name: "香尽通知", planned_minutes: 15, started_at: NOW - 16 * 60 * 1000, device: "desktop", stage: "training", status: "running" },
    });
    const doc = window.document;
    window.localStorage.setItem("yizhuxiang-remind-notify", "1");
    window.__fd.state.incenseReminded = false;
    await sleep(1600); // 等下一轮 1s tick 触发提醒
    check("香尽触发系统通知请求", requests.some((r) => r.method === "POST" && r.u === "/api/notify/toast"));
    const before = requests.filter((r) => r.u === "/api/notify/toast").length;
    await sleep(1400);
    check("提醒只触发一次", requests.filter((r) => r.u === "/api/notify/toast").length === before);
  }

  console.log("== T5 无操作弹窗：显示 + 稍后再问逃生 ==");
  {
    const { window, requests } = await boot({
      localSession: { clientKey: "sk-new2", task_name: "写代码", planned_minutes: 15, started_at: NOW - 60000 },
    });
    const doc = window.document;
    const st = window.__fd.state;
    st.idleFlag = true;
    st.lastActivity = NOW - 4 * 60 * 1000;
    doc.dispatchEvent(new window.Event("visibilitychange")); // 模拟回到页面
    check("弹窗显示", !doc.getElementById("overlay-idle").hidden);
    const before = requests.length;
    doc.getElementById("btn-idle-later").click();
    check("稍后再问后弹窗隐藏", doc.getElementById("overlay-idle").hidden);
    check("稍后再问未记录分心", requests.length === before);
    check("idleFlag 已复位", st.idleFlag === false);
  }

  console.log("== T6 弹窗点「走神了」→ 记录分心 ==");
  {
    const { window, requests } = await boot({
      current: { id: 9, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
    });
    const doc = window.document;
    const st = window.__fd.state;
    st.idleFlag = true;
    doc.dispatchEvent(new window.Event("visibilitychange"));
    doc.querySelector('#overlay-idle button[data-idle="distracted"]').click();
    check("走神了后弹窗隐藏", doc.getElementById("overlay-idle").hidden);
    const hit = requests.some((r) => r.method === "POST" && /distractions$/.test(r.u));
    check("已 POST 分心记录", hit);
  }

  console.log("== T7 开始专注 → 进入专注视图 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    doc.getElementById("task-input").value = "读 20 页书";
    doc.getElementById("btn-start").click();
    await sleep(80);
    check("点击后直接进入专注视图", !doc.getElementById("home-running").hidden);
    check("任务名回填", doc.getElementById("running-task").textContent === "读 20 页书");
  }

  console.log("== T8 昼夜主题切换 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    const btn = doc.getElementById("btn-theme");
    check("主题按钮存在", !!btn);
    btn.click();
    const saved = window.localStorage.getItem("yizhuxiang-theme");
    check("点击后 data-theme 已设置", doc.documentElement.dataset.theme === saved);
    check("localStorage 已记忆", saved === "light" || saved === "dark");
    check("按钮显示另一面", btn.textContent === (saved === "dark" ? "昼" : "夜"));
    btn.click();
    const saved2 = window.localStorage.getItem("yizhuxiang-theme");
    check("再次点击可切回", saved2 !== saved);
  }

    console.log("== T9 今日印章与集印条 ==");
  {
    const { window } = await boot({ qualified: false });
    const doc = window.document;
    check("今日大印存在", !!doc.getElementById("today-seal"));
    check("未达标为空印", doc.getElementById("today-seal").classList.contains("empty"));
    check("集印条渲染 7 枚", doc.querySelectorAll("#week-seals .seal-sm").length === 7);
    check("无达标时仅今天为实印", doc.querySelectorAll("#week-seals .seal-sm.done").length === 1 && doc.querySelectorAll("#week-seals .seal-sm.empty").length === 6);
    const todaySeal = doc.querySelector("#week-seals .seal-sm.done");
    check("实印那枚是今天", todaySeal && todaySeal.textContent === String(new Date().getDate()));
    check("今天小印下方标「今」", todaySeal && todaySeal.parentElement.querySelector(".seal-dow").textContent === "今");
  }
  {
    const { window } = await boot({ qualified: true, weeklyOpts: { streak: 3, qualifiedDays: [6] } });
    const doc = window.document;
    check("达标为实印（大香字）", doc.getElementById("today-seal").classList.contains("done"));
    check("集印条仅今天为实印", doc.querySelectorAll("#week-seals .seal-sm.done").length === 1);
    doc.querySelector(`#nav .nav-btn[data-view="stats"]`).click();
    await sleep(80);
    check("统计页不标记今天（无 today 类）", !doc.querySelector("#week-chart .day-bar.today"));
  }
  {
    const { window } = await boot({ qualified: true, weeklyOpts: { streak: 3, qualifiedDays: [5] } });
    const doc = window.document;
    const todaySeal = doc.querySelector("#week-seals .seal-sm.done");
    check("集印条实印是今天（不受达标日影响）", todaySeal && todaySeal.textContent === String(new Date().getDate()));
    check("实印只有今天一枚", doc.querySelectorAll("#week-seals .seal-sm.done").length === 1);
  }
console.log("== T10 结业卷轴 ==");
  {
    const { window } = await boot({ weeklyOpts: { graduation: { rate_28d: 0, self_rate_28d: null, eligible: false } } });
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="stats"]').click();
    await sleep(80);
    check("卷轴显示近 4 周达标 0%", doc.getElementById("scroll-text").textContent.includes("近 4 周达标 0%"));
    check("进度条 0%", doc.getElementById("scroll-fill").style.width === "0%");
  }
  {
    const { window } = await boot({ weeklyOpts: { graduation: { rate_28d: 1, self_rate_28d: 1, eligible: true } } });
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="stats"]').click();
    await sleep(80);
    check("卷轴显示近 4 周达标 100%", doc.getElementById("scroll-text").textContent.includes("近 4 周达标 100%"));
    check("进度条 100%", doc.getElementById("scroll-fill").style.width === "100%");
  }

  console.log("== T11 抖音实时提醒 ==");
  {
    const hitState = { hit: true, app: "抖音", since: (NOW / 1000) - 130, total: 130 };
    const { window, requests } = await boot({
      current: { id: 9, task_name: "写代码", planned_minutes: 15, started_at: NOW - 60 * 1000, status: "running", device: "desktop" },
      hit: hitState,
    });
    const doc = window.document;
    window.localStorage.setItem("yizhuxiang-remind-notify-distract", "1");
    const notifyCount = () => requests.filter((r) => r.method === "POST" && r.u === "/api/notify/toast").length;
    check("进入专注视图", !doc.getElementById("home-running").hidden);
    await sleep(2200); // 等一轮 pollDistract 轮询
    check("命中后卡片显示", !doc.getElementById("overlay-distract").hidden);
    check("分钟数=2", doc.getElementById("distract-minutes").textContent === "2");
    check("应用名=抖音", doc.getElementById("distract-app").textContent.includes("抖音"));
    check("新段命中发系统通知", notifyCount() === 1);
    const nBody = requests.find((r) => r.method === "POST" && r.u === "/api/notify/toast");
    check("通知带应用名", !!nBody && JSON.parse(nBody.body).body.includes("抖音"));

    doc.getElementById("btn-distract-back").click();
    check("点回来专注后卡片隐藏", doc.getElementById("overlay-distract").hidden);
    await sleep(2200); // 同一连续段（since 不变）再轮询
    check("同连续段不再重弹", doc.getElementById("overlay-distract").hidden);
    check("同段不重发系统通知", notifyCount() === 1);

    hitState.hit = false; hitState.since = null; hitState.app = null; hitState.total = 130;
    await sleep(2200);
    check("真切走（hit=false）后不再显示卡片", doc.getElementById("overlay-distract").hidden);

    hitState.hit = true; hitState.since = (NOW / 1000) - 300; hitState.app = "抖音"; hitState.total = 300;
    await sleep(2200);
    check("重新命中（新连续段）卡片显示", !doc.getElementById("overlay-distract").hidden);
    check("分钟数=5", doc.getElementById("distract-minutes").textContent === "5");
    doc.getElementById("btn-distract-quit").click();
    await sleep(80);
    check("结束需确认弹窗", !doc.getElementById("overlay-confirm").hidden);
    doc.getElementById("btn-confirm-ok").click();
    await sleep(80);
    check("确认后弹复盘窗", !doc.getElementById("overlay-reflect").hidden);
    doc.getElementById("btn-reflect-skip").click();
    await sleep(80);
    check("结束这场专注回首页", doc.getElementById("home-running").hidden);
    check("卡片已隐藏", doc.getElementById("overlay-distract").hidden);
  }

console.log("== T11b 干预递减：L2 黑名单只记录不弹卡片 ==");
  {
    const hitState = { hit: true, app: "bilibili", since: (NOW / 1000) - 130, total: 130 };
    const { window } = await boot({
      current: { id: 26, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, status: "running", device: "desktop" },
      hit: hitState,
      ritualStage: { stage: 2, today_count: 0 },
    });
    const doc = window.document;
    await sleep(2200);
    check("L2 黑名单命中不弹卡片", doc.getElementById("overlay-distract").hidden);
  }

console.log("== T11c 干预递减：L2 无操作不补问 ==");
  {
    const { window } = await boot({
      current: { id: 27, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, status: "running", device: "desktop" },
      ritualStage: { stage: 2, today_count: 0 },
    });
    const doc = window.document;
    const st = window.__fd.state;
    st.idleFlag = true;
    doc.dispatchEvent(new window.Event("visibilitychange"));
    await sleep(80);
    check("L2 不弹无操作补问", doc.getElementById("overlay-idle").hidden);
  }

console.log("== T11d 干预递减：L3 手机不感知 ==");
  {
    const { window } = await boot({
      current: { id: 28, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, status: "running", device: "phone" },
      ritualStage: { stage: 3, today_count: 0 },
      touch: true,
    });
    const doc = window.document;
    const st = window.__fd.state;
    st.hiddenAt = Date.now() - 3 * 60 * 1000; // 模拟残留切走状态
    doc.dispatchEvent(new window.Event("visibilitychange"));
    await sleep(80);
    check("L3 手机归因不弹窗", doc.getElementById("overlay-attribution").hidden);
    check("L3 不触发回神仪式", doc.getElementById("overlay-ritual").hidden);
  }

console.log("== T12 未命中不弹卡 ==");
  {
    const { window } = await boot({
      current: { id: 10, task_name: "写代码", planned_minutes: 15, started_at: NOW - 60 * 1000, status: "running", device: "desktop" },
    });
    const doc = window.document;
    await sleep(2200); // 等一轮 pollDistract 轮询
    check("未命中卡片隐藏", doc.getElementById("overlay-distract").hidden);
  }

  console.log("== T13 未点按钮切走卡片保留 ==");
  {
    const hitState = { hit: true, app: "抖音", since: (NOW / 1000) - 130, total: 130 };
    const { window } = await boot({
      current: { id: 11, task_name: "写代码", planned_minutes: 15, started_at: NOW - 60 * 1000, status: "running", device: "desktop" },
      hit: hitState,
    });
    const doc = window.document;
    await sleep(2200);
    check("命中后卡片显示", !doc.getElementById("overlay-distract").hidden);
    hitState.hit = false; hitState.since = null; hitState.app = null;
    await sleep(2200);
    check("未点按钮切走后卡片保留（等确认）", !doc.getElementById("overlay-distract").hidden);
    check("切走后文案更新为已回到其他窗口", doc.getElementById("distract-app").textContent.includes("已回到其他窗口"));
  }

  console.log("== T14 回神仪式 L1：破功 → 反馈+选项+建议 → 继续 ==");
  {
    const { window } = await boot({
      current: { id: 20, task_name: "写代码", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
      ritualStage: { stage: 1, today_count: 1 },
    });
    const doc = window.document;
    doc.getElementById("btn-distract").click();
    await sleep(80);
    check("破功后回神仪式弹出", !doc.getElementById("overlay-ritual").hidden);
    check("仪式有「我回来了」按钮", !!doc.getElementById("btn-ritual-done"));
    check("L1 显示今天第 N 次反馈", !doc.getElementById("ritual-count").hidden && doc.getElementById("ritual-count").textContent.includes("第 1 次回来"));
    check("L1 显示三个原因选项", !doc.getElementById("ritual-reasons").hidden);
    doc.querySelector('.ritual-reason[data-reason="tired"]').click();
    await sleep(40);
    check("点「有点累」出现建议", !doc.getElementById("ritual-advice").hidden && doc.getElementById("ritual-advice").textContent.includes("去接杯水"));
    doc.querySelector('.ritual-reason[data-reason="annoyed"]').click();
    await sleep(40);
    check("切「有点烦」换建议", doc.getElementById("ritual-advice").textContent.includes("先做最简单的 5 分钟"));
    doc.getElementById("btn-ritual-done").click();
    await sleep(80);
    check("完成仪式后浮层隐藏", doc.getElementById("overlay-ritual").hidden);
  }

  console.log("== T14b 回神仪式 L2：只显示反馈 ==");
  {
    const { window } = await boot({
      current: { id: 23, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
      ritualStage: { stage: 2, today_count: 3 },
    });
    const doc = window.document;
    doc.getElementById("btn-distract").click();
    await sleep(80);
    check("L2 仪式弹出", !doc.getElementById("overlay-ritual").hidden);
    check("L2 显示反馈行", !doc.getElementById("ritual-count").hidden);
    check("L2 隐藏原因选项", doc.getElementById("ritual-reasons").hidden);
    doc.getElementById("btn-ritual-done").click();
    await sleep(80);
    check("L2 完成后浮层隐藏", doc.getElementById("overlay-ritual").hidden);
  }

  console.log("== T14c 回神仪式 L3：静默不弹 ==");
  {
    const { window } = await boot({
      current: { id: 24, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "habit", status: "running" },
      ritualStage: { stage: 3, today_count: 0 },
    });
    const doc = window.document;
    doc.getElementById("btn-distract").click();
    await sleep(80);
    check("L3 破功后仪式不弹出", doc.getElementById("overlay-ritual").hidden);
  }

  console.log("== T14d 回神仪式：裸专注日静默 ==");
  {
    const isoDay = new Date().getDay() === 0 ? 7 : new Date().getDay();
    const { window } = await boot({
      current: { id: 25, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
      settings: { naked_day: isoDay },
      ritualStage: { stage: 1, today_count: 2 },
    });
    const doc = window.document;
    doc.getElementById("btn-distract").click();
    await sleep(80);
    check("裸专注日破功后仪式不弹出", doc.getElementById("overlay-ritual").hidden);
  }

  console.log("== T15 电脑补问「走神了」→ 回神仪式 ==");
  {
    const { window } = await boot({
      current: { id: 21, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
    });
    const doc = window.document;
    const st = window.__fd.state;
    st.idleFlag = true;
    doc.dispatchEvent(new window.Event("visibilitychange"));
    doc.querySelector('#overlay-idle button[data-idle="distracted"]').click();
    await sleep(80);
    check("走神后回神仪式弹出", !doc.getElementById("overlay-ritual").hidden);
    doc.getElementById("btn-ritual-done").click();
    check("完成后浮层隐藏", doc.getElementById("overlay-ritual").hidden);
  }

  console.log("== T16 手机归因「刷手机」→ 回神仪式 ==");
  {
    const { window } = await boot({
      current: { id: 22, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "phone", stage: "training", status: "running" },
      touch: true,
    });
    const doc = window.document;
    const st = window.__fd.state;
    check("识别为手机端", st.device === "phone");
    // 模拟切走 3 分钟再回到页面 → 触发归因
    st.hiddenAt = Date.now() - 3 * 60 * 1000;
    doc.dispatchEvent(new window.Event("visibilitychange"));
    await sleep(80);
    check("归因弹窗显示", !doc.getElementById("overlay-attribution").hidden);
    doc.querySelector('#overlay-attribution button[data-reason="刷手机"]').click();
    await sleep(80);
    check("刷手机归因后回神仪式弹出", !doc.getElementById("overlay-ritual").hidden);
    check("归因弹窗已关闭", doc.getElementById("overlay-attribution").hidden);
  }

  console.log("== T17 设置页：裸专注日 ==");
  {
    const { window, requests } = await boot({ settings: { naked_day: 3 } });
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="settings"]`).click();
    await sleep(80);
    check("裸专注日下拉存在", !!doc.getElementById("naked-day"));
    check("回填周三(3)", doc.getElementById("naked-day").value === "3");
    check("训练阶段展示入门", doc.getElementById("ritual-stage-label").textContent === "入门");
    doc.getElementById("naked-day").value = "5";
    doc.getElementById("btn-save-settings").click();
    await sleep(80);
    const saved = requests.find((r) => r.method === "PUT" && r.u === "/api/settings");
    check("保存请求带 naked_day=5", !!saved && JSON.parse(saved.body).naked_day === 5);
  }
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="settings"]`).click();
    await sleep(80);
    check("默认不启用(0)", doc.getElementById("naked-day").value === "0");
  }

  console.log("== T17c 到点提醒设置开关 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="settings"]`).click();
    await sleep(80);
    check("提示音默认开", doc.getElementById("reminder-sound").checked === true);
    check("系统通知默认关", doc.getElementById("reminder-notify").checked === false);
    check("分心通知默认关", doc.getElementById("reminder-notify-distract").checked === false);
    check("数据区导出按钮存在", !!doc.getElementById("btn-export-data"));
    check("数据区导入按钮存在", !!doc.getElementById("btn-import-data"));
    check("云同步绑定按钮存在", !!doc.getElementById("btn-sync-bind"));
    check("云同步地址输入框存在", !!doc.getElementById("sync-url"));
    check("云同步未绑定视图默认显示", !doc.getElementById("sync-unbound").hidden);
    check("云同步已绑定视图默认隐藏", doc.getElementById("sync-bound").hidden);
    doc.getElementById("reminder-notify").click();
    await sleep(30);
    check("通知开关已保存", window.localStorage.getItem("yizhuxiang-remind-notify") === "1");
  }

  console.log("== T17b 静修时段时间选择器 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="settings"]`).click();
    await sleep(80);
    check("时间按钮回填 09:00", doc.getElementById("deep-start-btn").textContent === "09:00");
    doc.getElementById("deep-start-btn").click();
    await sleep(60);
    check("时间选择弹窗打开", !doc.getElementById("overlay-time-picker").hidden);
    check("标题为开始", doc.getElementById("tp-title").textContent.includes("开始"));
    doc.querySelectorAll("#tp-hours .tp-num")[10].click();
    await sleep(30);
    doc.querySelectorAll("#tp-minutes .tp-num")[1].click();
    await sleep(30);
    doc.getElementById("btn-tp-ok").click();
    await sleep(60);
    check("确定后弹窗关闭", doc.getElementById("overlay-time-picker").hidden);
    check("按钮更新为 10:05", doc.getElementById("deep-start-btn").textContent === "10:05");
    check("隐藏输入同步", doc.getElementById("deep-start").value === "10:05");
  }

  console.log("== T18 自评：靠产品/靠自己 ==");
  {
    const { window, requests } = await boot({
      current: { id: 30, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
    });
    const doc = window.document;
    check("reliance-picker 存在", !!doc.getElementById("reliance-picker"));
    check("默认选靠自己", doc.querySelector(`#reliance-picker .reliance-btn.selected`).dataset.v === "self");
    doc.getElementById("btn-complete").click();
    doc.querySelector(`#reliance-picker .reliance-btn[data-v="product"]`).click();
    check("点击后选中靠产品", doc.querySelector(`#reliance-picker .reliance-btn.selected`).dataset.v === "product");
    doc.getElementById("btn-submit-review").click();
    await sleep(80);
    const patch = requests.find((r) => r.method === "PATCH" && /^\/api\/sessions\/30$/.test(r.u));
    check("PATCH 带 reliance=product", !!patch && JSON.parse(patch.body).reliance === "product");
  }

console.log("== T18d 复盘：完成场次有分心显示输入框；放弃场次可写原因 ==");
  {
    const { window } = await boot({
      current: { id: 40, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
    });
    const doc = window.document;
    doc.getElementById("btn-complete").click();
    check("无分心时复盘行隐藏", doc.getElementById("review-reflect-row").hidden);
    doc.getElementById("btn-submit-review").click();
    await sleep(80);
  }
  {
    const { window, requests } = await boot({
      current: { id: 41, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
    });
    const doc = window.document;
    window.__fd.state.sessionDistractions = 2; // 本场有分心
    doc.getElementById("btn-complete").click();
    check("有分心时复盘行显示", !doc.getElementById("review-reflect-row").hidden);
    doc.getElementById("review-reflect").value = "抖音推送太诱人";
    doc.getElementById("btn-submit-review").click();
    await sleep(80);
    const patch = requests.find((r) => r.method === "PATCH" && /^\/api\/sessions\/41$/.test(r.u));
    check("PATCH 带 reflection", !!patch && JSON.parse(patch.body).reflection === "抖音推送太诱人", patch ? patch.body : "none");
  }
  {
    const { window, requests } = await boot({
      current: { id: 42, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
    });
    const doc = window.document;
    doc.getElementById("btn-abandon").click();
    await sleep(60);
    doc.getElementById("btn-confirm-ok").click();
    await sleep(60);
    check("放弃后弹复盘窗", !doc.getElementById("overlay-reflect").hidden);
    doc.getElementById("reflect-input").value = "临时有事";
    doc.getElementById("btn-reflect-save").click();
    await sleep(80);
    const patch = requests.find((r) => r.method === "PATCH" && /^\/api\/sessions\/42$/.test(r.u));
    check("放弃 PATCH 带 reflection", !!patch && JSON.parse(patch.body).reflection === "临时有事", patch ? patch.body : "none");
  }
  {
    const { window } = await boot({
      current: { id: 43, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
    });
    const doc = window.document;
    doc.getElementById("btn-abandon").click();
    await sleep(60);
    doc.getElementById("btn-confirm-ok").click();
    await sleep(60);
    doc.getElementById("btn-reflect-skip").click();
    await sleep(80);
    check("跳过复盘后复盘窗关闭", doc.getElementById("overlay-reflect").hidden);
    check("跳过复盘也结束会话", doc.getElementById("home-running").hidden);
  }

console.log("== T18b 每场鼓励：完成度>=80 且无自动检测 → 鼓励语 ==");
  {
    const { window } = await boot({
      current: { id: 32, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
    });
    const doc = window.document;
    doc.getElementById("btn-complete").click();
    const slider = doc.getElementById("completion-slider");
    slider.value = "85";
    slider.dispatchEvent(new window.Event("input"));
    doc.getElementById("btn-submit-review").click();
    await sleep(100);
    const toastText = doc.getElementById("toast").textContent;
    check("鼓励语出现", /这一炷香又稳又干净|干净利落|这一场，漂亮|专注得很扎实/.test(toastText), toastText);
  }

console.log("== T18c 每场鼓励：有自动检测分心 → 不鼓励 ==");
  {
    const { window } = await boot({
      current: { id: 33, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
      autoHit: true,
    });
    const doc = window.document;
    doc.getElementById("btn-complete").click();
    const slider = doc.getElementById("completion-slider");
    slider.value = "85";
    slider.dispatchEvent(new window.Event("input"));
    doc.getElementById("btn-submit-review").click();
    await sleep(100);
    const toastText = doc.getElementById("toast").textContent;
    check("有自动检测时不鼓励", !/这一炷香又稳又干净|干净利落|这一场，漂亮|专注得很扎实/.test(toastText), toastText);
  }


console.log("== T18e 毕业仪式：eligible 未毕业 → 弹出 → 领取 ==");
  {
    const { window } = await boot({
      current: { id: 35, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
      graduation: { eligible: true, graduated_at: null, rate_28d: 0.61, self_rate_28d: 1, stages: ["受训期"] },
    });
    const doc = window.document;
    doc.getElementById("btn-complete").click();
    doc.getElementById("btn-submit-review").click();
    await sleep(150);
    check("毕业仪式弹出", !doc.getElementById("overlay-graduation").hidden);
    doc.getElementById("btn-grad-claim").click();
    await sleep(100);
    check("领取后仪式关闭", doc.getElementById("overlay-graduation").hidden);
  }

console.log("== T18f 毕业档案：已毕业渲染 + 重新训练 ==");
  {
    const { window, requests } = await boot({
      graduation: { eligible: true, graduated_at: "2026-08-01", rate_28d: 0.7, self_rate_28d: 0.8, stages: ["受训期", "过渡期", "预备毕业"] },
    });
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="me"]').click();
    await sleep(150);
    check("档案面板显示", !doc.getElementById("graduation-panel").hidden);
    check("档案含毕业日期", doc.getElementById("grad-archive").textContent.includes("已毕业（2026-08-01）"));
    check("重新训练按钮可见", !doc.getElementById("btn-retrain").hidden);
    doc.getElementById("btn-retrain").click();
    await sleep(60);
    check("重新训练需确认弹窗", !doc.getElementById("overlay-confirm").hidden);
    doc.getElementById("btn-confirm-ok").click();
    await sleep(100);
    check("重新训练请求发出", requests.some((r) => r.method === "POST" && r.u === "/api/settings/graduation/retrain"));
  }

  console.log("== T18g 自由专注模式：毕业后不干预 ==");
  {
    const { window } = await boot({
      graduation: { eligible: true, graduated_at: "2026-08-01", rate_28d: 0.7, self_rate_28d: 0.8, stages: ["受训期", "过渡期", "预备毕业"] },
    });
    const doc = window.document;
    await sleep(120);
    check("已毕业状态为自由模式", window.__fd.state.graduated === true);
    check("首页显示自由专注 banner", !doc.getElementById("freedom-banner").hidden);
    doc.getElementById("task-input").value = "自由测试";
    doc.getElementById("btn-start").click();
    await sleep(80);
    check("专注页提示自由专注", doc.getElementById("running-hint").textContent.includes("自由专注"));
  }
  {
    const { window } = await boot({
      current: { id: 55, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
      graduation: { eligible: true, graduated_at: null, rate_28d: 0.61, self_rate_28d: 1, stages: ["受训期"] },
    });
    const doc = window.document;
    doc.getElementById("btn-complete").click();
    doc.getElementById("btn-submit-review").click();
    await sleep(150);
    doc.getElementById("btn-grad-claim").click();
    await sleep(100);
    check("领取毕业进入自由模式", window.__fd.state.graduated === true);
    check("领取后首页显示 banner", !doc.getElementById("freedom-banner").hidden);
  }

  console.log("== T19 裸专注日：检测与提醒静默 ==");
  {
    const gd = new Date().getDay();
    const iso = gd === 0 ? 7 : gd; // JS getDay 0=周日 → ISO 7=周日
    const hitState = { hit: true, app: "抖音", since: (NOW / 1000) - 130, total: 130 };
    const { window } = await boot({
      current: { id: 31, task_name: "t", planned_minutes: 15, started_at: NOW - 60000, device: "desktop", stage: "training", status: "running" },
      hit: hitState,
      settings: { naked_day: iso },
    });
    const doc = window.document;
    check("专注页裸专注日提示", doc.getElementById("running-hint").textContent.includes("裸专注日"));
    await sleep(2200); // 等一轮 pollDistract
    check("命中抖音但卡片不弹", doc.getElementById("overlay-distract").hidden);
    const st = window.__fd.state;
    st.idleFlag = true;
    doc.dispatchEvent(new window.Event("visibilitychange"));
    check("无操作补问不弹", doc.getElementById("overlay-idle").hidden);
    st.device = "phone";
    st.hiddenAt = Date.now() - 3 * 60 * 1000;
    doc.dispatchEvent(new window.Event("visibilitychange"));
    check("离开归因不弹", doc.getElementById("overlay-attribution").hidden);
  }

  console.log("== T20 统计页：靠自己比例 ==");
  {
    const { window } = await boot({ weeklyOpts: { selfRate: 0.5, selfSessions: 3, productSessions: 3 } });
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="stats"]`).click();
    await sleep(80);
    check("self-rate 显示 50%", doc.getElementById("self-rate").textContent === "50%");
  }
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="stats"]`).click();
    await sleep(80);
    check("无数据时显示 —", doc.getElementById("self-rate").textContent === "—");
  }
  {
    const { window } = await boot({
      reflections: {
        summary: { last7d_count: 2, top_reason: { text: "被打断", count: 1 } },
        items: [
          { date: "2026-08-08", task_name: "写周报", reflection: "被打断", status: "completed", distracted: true },
          { date: "2026-08-07", task_name: "读书", reflection: "静不下心", status: "abandoned", distracted: false },
        ],
      },
    });
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="me"]`).click();
    await sleep(80);
    doc.getElementById("btn-toggle-reflect").click();
    await sleep(120);
    check("复盘面板展开", !doc.getElementById("reflect-panel").hidden);
    check("摘要显示最近 7 天", doc.getElementById("reflect-summary").textContent.includes("最近 7 天 · 2 次复盘"));
    check("按周分组渲染", doc.querySelectorAll("#reflect-groups .reflect-group").length === 1);
    check("组内 2 条明细", doc.querySelectorAll("#reflect-groups .reflection-item").length === 2);
    check("标记渲染（分心+放弃）", doc.querySelectorAll("#reflect-groups .reflection-badge").length === 2);
  }
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="me"]`).click();
    await sleep(80);
    doc.getElementById("btn-toggle-reflect").click();
    await sleep(120);
    check("无复盘时空态显示", !doc.getElementById("reflect-empty").hidden);
  }

  console.log("== T20b 周对比图：本周 vs 上周 ==");
  {
    const { window } = await boot({ weeklyOpts: { focusMinutes: 30, prevFocusMinutes: 20 } });
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="stats"]`).click();
    await sleep(100);
    check("周对比图 7 列", doc.querySelectorAll("#week-chart .day-col").length === 7);
    check("每列双柱共 14 根", doc.querySelectorAll("#week-chart .day-bar").length === 14);
    check("上周灰柱 7 根", doc.querySelectorAll("#week-chart .day-bar.prev").length === 7);
    check("环比文字 +50%", doc.getElementById("week-trend").textContent === "本周专注 210 分钟 · 较上周 +50%");
  }
  {
    const { window } = await boot({ weeklyOpts: { focusMinutes: 30 } });
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="stats"]`).click();
    await sleep(100);
    check("上周无数据只显示合计", doc.getElementById("week-trend").textContent === "本周专注 210 分钟");
  }

  console.log("== T21 未登录 → 登录页 ==");
  {
    const { window } = await boot({ noAuth: true });
    const doc = window.document;
    check("登录页可见", !doc.getElementById("view-auth").hidden);
    check("主视图隐藏", doc.getElementById("view-home").hidden);
    check("导航隐藏", doc.getElementById("nav").hidden);
    check("我的页隐藏（登出不可达）", doc.getElementById("view-me").hidden);
  }

  console.log("== T22 注册流程 ==");
  {
    const { window, requests } = await boot({ noAuth: true });
    const doc = window.document;
    doc.querySelector('.auth-tab[data-mode="register"]').click();
    check("注册模式标题=开卷", doc.getElementById("auth-title").textContent === "开卷");
    check("昵称输入显示", !doc.getElementById("auth-nickname").hidden);
    check("确认密码显示", !doc.getElementById("auth-password2").hidden);
    doc.getElementById("auth-username").value = "alice";
    doc.getElementById("auth-nickname").value = "爱丽丝";
    doc.getElementById("auth-password").value = "secret1";
    doc.getElementById("auth-password2").value = "secret1";
    doc.getElementById("btn-auth-submit").click();
    await sleep(80);
    check("注册请求已发", requests.some((r) => r.method === "POST" && r.u === "/api/auth/register"));
    check("token 已存", !!window.localStorage.getItem("yizhuxiang-token"));
    check("进入应用", doc.getElementById("view-auth").hidden);
    check("注册后自动翻开手册", !doc.getElementById("view-manual").hidden && doc.getElementById("view-home").hidden);
  }
  {
    const { window } = await boot({ noAuth: true });
    const doc = window.document;
    doc.querySelector('.auth-tab[data-mode="register"]').click();
    doc.getElementById("auth-username").value = "bob";
    doc.getElementById("auth-password").value = "123";
    doc.getElementById("auth-password2").value = "123";
    doc.getElementById("btn-auth-submit").click();
    await sleep(80);
    check("密码过短提示", doc.getElementById("auth-error").textContent.includes("至少 6 位"));
  }

  console.log("== T22b 忘记密码（安全问题） ==");
  {
    const { window, requests } = await boot({ noAuth: true });
    const doc = window.document;
    doc.getElementById("btn-auth-forgot").click();
    await sleep(60);
    check("重置弹窗打开", !doc.getElementById("overlay-reset").hidden);
    doc.getElementById("reset-username").value = "tester";
    doc.getElementById("btn-reset-next").click();
    await sleep(80);
    check("安全问题显示", !doc.getElementById("reset-question").hidden);
    check("答案与新密码输入显示", !doc.getElementById("reset-pw").hidden);
    doc.getElementById("reset-answer").value = "杭州";
    doc.getElementById("reset-pw").value = "newpass1";
    doc.getElementById("reset-pw2").value = "newpass1";
    doc.getElementById("btn-reset-ok").click();
    await sleep(80);
    check("重置请求发出", requests.some((r) => r.method === "POST" && r.u === "/api/auth/reset-password"));
    check("重置后弹窗关闭", doc.getElementById("overlay-reset").hidden);
  }
  {
    const { window, requests } = await boot({ noAuth: true });
    const doc = window.document;
    doc.querySelector('.auth-tab[data-mode="register"]').click();
    await sleep(40);
    check("注册页不显示安全问题", doc.getElementById("auth-security-row").hidden);
    doc.getElementById("auth-username").value = "alice";
    doc.getElementById("auth-nickname").value = "爱丽丝";
    doc.getElementById("auth-password").value = "secret1";
    doc.getElementById("auth-password2").value = "secret1";
    doc.getElementById("btn-auth-submit").click();
    await sleep(80);
    const reg = requests.find((r) => r.method === "POST" && r.u === "/api/auth/register");
    check("注册不带安全问题", !!reg && !JSON.parse(reg.body).security_question);
  }
  {
    // 登录后通过账号管理设置安全问题
    const { window, requests } = await boot();
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="me"]').click();
    await sleep(80);
    doc.getElementById("btn-toggle-account").click();
    await sleep(60);
    doc.getElementById("btn-toggle-security").click();
    await sleep(60);
    doc.getElementById("security-question").value = "你最喜欢的城市是？";
    doc.getElementById("security-answer").value = "杭州";
    doc.getElementById("btn-save-security").click();
    await sleep(80);
    check("安全问题设置请求发出", requests.some((r) => r.method === "POST" && r.u === "/api/auth/security"));
  }

  console.log("== T23 登录流程 ==");
  {
    const { window } = await boot({ noAuth: true });
    const doc = window.document;
    doc.getElementById("auth-username").value = "tester";
    doc.getElementById("auth-password").value = "secret123";
    doc.getElementById("btn-auth-submit").click();
    await sleep(80);
    check("登录后进入应用", doc.getElementById("view-auth").hidden && !doc.getElementById("nav").hidden);
  }
  {
    const { window } = await boot({ noAuth: true });
    const doc = window.document;
    doc.getElementById("auth-username").value = "tester";
    doc.getElementById("auth-password").value = "bad";
    doc.getElementById("btn-auth-submit").click();
    await sleep(80);
    check("密码错误提示", doc.getElementById("auth-error").textContent.includes("用户名或密码不正确"));
  }

  console.log("== T24 登出 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    doc.getElementById("btn-logout").click();
    await sleep(60);
    check("登出需确认弹窗", !doc.getElementById("overlay-confirm").hidden);
    doc.getElementById("btn-confirm-ok").click();
    await sleep(80);
    check("登出后回登录页", !doc.getElementById("view-auth").hidden);
    check("token 已清除", window.localStorage.getItem("yizhuxiang-token") === null);
    check("离线队列已清（防串账号）", window.localStorage.getItem("fd_queue") === null);
  }

  console.log("== T25 登录过期（me 401）→ 回登录页 ==");
  {
    const { window } = await boot({ me401: true });
    const doc = window.document;
    check("登录页可见", !doc.getElementById("view-auth").hidden);
    check("token 已清除", window.localStorage.getItem("yizhuxiang-token") === null);
  }

  console.log("== T26 我的页：身份卡 + 履历 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="me"]`).click();
    await sleep(80);
    check("我的页可见", !doc.getElementById("view-me").hidden);
    check("身份卡昵称", doc.getElementById("profile-nickname").textContent === "测试");
    check("用户名", doc.getElementById("profile-username").textContent === "@tester");
    check("注册日期", doc.getElementById("profile-joined").textContent.includes("注册于"));
    check("累计专注分钟", doc.getElementById("pf-focus").textContent === "320");
    check("靠自己完成", doc.getElementById("pf-selfrate").textContent === "75%");
    check("账号管理默认收起", doc.getElementById("account-panel").hidden);
    check("展开按钮存在", !!doc.getElementById("btn-toggle-account"));
  }

  console.log("== T27 改昵称 ==");
  {
    const { window, requests } = await boot();
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="me"]`).click();
    await sleep(80);
    doc.getElementById("btn-toggle-account").click();
    doc.getElementById("profile-nick-input").value = "新名字";
    doc.getElementById("btn-save-nick").click();
    await sleep(80);
    check("PATCH /me 已发", requests.some((r) => r.method === "PATCH" && r.u === "/api/auth/me"));
    check("昵称已更新", doc.getElementById("profile-nickname").textContent === "新名字");
  }

  console.log("== T28 改密码 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="me"]`).click();
    await sleep(80);
    doc.getElementById("btn-toggle-account").click();
    doc.getElementById("pw-old").value = "secret123";
    doc.getElementById("pw-new").value = "newpass1";
    doc.getElementById("pw-new2").value = "newpass1";
    doc.getElementById("btn-change-pw").click();
    await sleep(80);
    check("改密码后回登录页", !doc.getElementById("view-auth").hidden);
    check("token 已清", window.localStorage.getItem("yizhuxiang-token") === null);
  }
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="me"]`).click();
    await sleep(80);
    doc.getElementById("pw-old").value = "bad";
    doc.getElementById("pw-new").value = "newpass1";
    doc.getElementById("pw-new2").value = "newpass1";
    doc.getElementById("btn-change-pw").click();
    await sleep(80);
    check("旧密码错提示", doc.getElementById("profile-msg").textContent.includes("旧密码不正确"));
  }

  console.log("== T30 账号管理展开/收起 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector(`#nav .nav-btn[data-view="me"]`).click();
    await sleep(80);
    const btn = doc.getElementById("btn-toggle-account");
    check("默认收起", doc.getElementById("account-panel").hidden);
    btn.click();
    check("点击后展开", !doc.getElementById("account-panel").hidden);
    check("按钮文案变化", btn.textContent === "收起账号管理");
    btn.click();
    check("再点收起", doc.getElementById("account-panel").hidden);
    check("按钮文案恢复", btn.textContent === "账号管理");
  }

  console.log("== T29 登出入口位置 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    check("品牌栏无登出按钮", !doc.querySelector("#brandbar #btn-logout"));
    check("登出按钮在账号管理区内", !!doc.querySelector("#account-panel #btn-logout"));
    check("账号管理区默认隐藏", doc.getElementById("account-panel").hidden);
  }

  console.log("== T30 待办：分区 + 每日任务打卡 + 从待办开始 + 完成联动 ==");
  {
    const { window, requests } = await boot({
      todos: [
        { id: 1, text: "写周报", sort_order: 0, done: false, is_daily: false, streak: 0 },
        { id: 2, text: "读 20 页", sort_order: -1, done: false, is_daily: false, streak: 0 },
        { id: 3, text: "晨跑", sort_order: -2, done: false, is_daily: true, streak: 0 },
      ],
    });
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="todo"]').click();
    await sleep(60);
    check("待办页可见", !doc.getElementById("view-todo").hidden);
    check("普通区渲染 2 条", doc.querySelectorAll("#todo-list .todo-item").length === 2);
    check("每日区渲染 1 条", doc.querySelectorAll("#todo-daily-list .todo-item").length === 1);
    check("每日区含每日标记", !!doc.querySelector('#todo-daily-list .todo-item[data-id="3"] .todo-badge'));
    check("无类型切换按钮", doc.querySelectorAll('[data-op="daily"]').length === 0);

    doc.getElementById("todo-daily-input").value = "冥想";
    doc.getElementById("btn-todo-daily-add").click();
    await sleep(60);
    check("每日添加请求带 is_daily", requests.some((r) => r.method === "POST" && r.u === "/api/todos" && /"is_daily":true/.test(r.body)));
    check("每日区 2 条", doc.querySelectorAll("#todo-daily-list .todo-item").length === 2);

    doc.getElementById("todo-input").value = "写方案";
    doc.getElementById("btn-todo-add").click();
    await sleep(60);
    check("普通添加请求不带 is_daily", requests.some((r) => r.method === "POST" && r.u === "/api/todos" && !/"is_daily":true/.test(r.body || "")));
    check("普通区 3 条", doc.querySelectorAll("#todo-list .todo-item").length === 3);

    doc.querySelector('#todo-daily-list .todo-item[data-id="3"] .todo-check').click();
    await sleep(60);
    check("打卡项保留在每日区", doc.querySelectorAll('#todo-daily-list .todo-item[data-id="3"]').length === 1);
    check("打卡项标今日已完成", !!doc.querySelector('#todo-daily-list .todo-item[data-id="3"] .todo-done-mark'));
    check("已打卡 1 天显示", doc.querySelector('#todo-daily-list .todo-item[data-id="3"] .todo-streak').textContent === "已打卡 1 天");

    doc.querySelector('#todo-list .todo-item[data-id="2"] .todo-start').click();
    await sleep(150);
    check("从待办开始进入专注", !doc.getElementById("home-running").hidden);
    check("任务名来自待办", doc.getElementById("running-task").textContent === "读 20 页");

    doc.getElementById("btn-complete").click();
    check("自评弹窗出现", !doc.getElementById("overlay-review").hidden);
    doc.getElementById("btn-submit-review").click();
    await sleep(150);
    check("完成联动标记待办", requests.some((r) => /^\/api\/todos\/\d+$/.test(r.u) && r.method === "PATCH" && /"done":true/.test(r.body)));

    doc.querySelector('#nav .nav-btn[data-view="todo"]').click();
    await sleep(60);
    check("普通待办完成消失", doc.querySelectorAll('#todo-list .todo-item[data-id="2"]').length === 0);

    doc.querySelector('#todo-daily-list .todo-item[data-id="3"] [data-op="del"]').click();
    await sleep(60);
    check("删除需确认弹窗", !doc.getElementById("overlay-confirm").hidden);
    doc.getElementById("btn-confirm-ok").click();
    await sleep(60);
    check("每日任务删除", doc.querySelectorAll('#todo-daily-list .todo-item[data-id="3"]').length === 0);
  }

console.log("== T30b 待办分区折叠 ==");
  {
    const { window } = await boot({
      todos: [
        { id: 1, text: "晨跑", sort_order: 0, done: false, is_daily: true, streak: 0 },
        { id: 2, text: "写周报", sort_order: -1, done: false, is_daily: false, streak: 0 },
      ],
    });
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="todo"]').click();
    await sleep(60);
    check("默认两个区域折叠", doc.getElementById("todo-daily-body").hidden && doc.getElementById("todo-normal-body").hidden);
    doc.querySelector('.todo-collapse[data-target="todo-daily-body"]').click();
    await sleep(40);
    check("点右侧按钮展开每日任务", !doc.getElementById("todo-daily-body").hidden);
    check("展开后按钮标记", !doc.querySelector('.todo-collapse[data-target="todo-daily-body"]').classList.contains("collapsed"));
    doc.querySelector('.todo-collapse[data-target="todo-daily-body"]').click();
    await sleep(40);
    check("再点折叠每日任务", doc.getElementById("todo-daily-body").hidden);
    doc.querySelector('.todo-collapse[data-target="todo-normal-body"]').click();
    await sleep(40);
    check("普通待办可展开", !doc.getElementById("todo-normal-body").hidden);
  }

  console.log("== T31 计时器工具：卡片入口 + 全屏倒计时 + 返回即结束 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="me"]').click();
    await sleep(60);
    check("工具面板默认收起", doc.getElementById("tools-panel").hidden);
    const tbtn = doc.getElementById("btn-toggle-tools");
    tbtn.click();
    await sleep(60);
    check("工具面板展开", !doc.getElementById("tools-panel").hidden);
    check("按钮文案变为收起工具", tbtn.textContent === "收起工具");
    check("计时器卡片存在", !!doc.getElementById("tool-card-timer"));

    doc.getElementById("tool-card-timer").click();
    await sleep(60);
    check("进入全屏计时页", !doc.getElementById("view-tool-timer").hidden);
    check("全屏时导航隐藏", doc.getElementById("nav").hidden);
    check("全屏时品牌栏隐藏", doc.getElementById("brandbar").hidden);
    check("进入显示时长设置", !doc.getElementById("timer-settings").hidden);
    check("默认显示 15:00", doc.getElementById("timer-display").textContent === "15:00");
    check("未开始按钮为开始", doc.getElementById("btn-timer-start").textContent === "开始");

    doc.querySelector('#timer-chips .chip[data-min="25"]').click();
    await sleep(30);
    check("选 25 后标签更新", doc.getElementById("timer-minutes-label").textContent === "25");
    doc.getElementById("btn-timer-start").click();
    await sleep(60);
    check("开始后时长设置收起", doc.getElementById("timer-settings").hidden);
    check("开始后显示 25:00", doc.getElementById("timer-display").textContent === "25:00");
    check("开始后按钮为暂停", doc.getElementById("btn-timer-start").textContent === "暂停");

    doc.getElementById("btn-timer-start").click();
    await sleep(30);
    check("暂停后按钮变继续", doc.getElementById("btn-timer-start").textContent === "继续");
    doc.getElementById("btn-timer-start").click();
    await sleep(30);
    check("继续后按钮变暂停", doc.getElementById("btn-timer-start").textContent === "暂停");

    doc.getElementById("btn-timer-reset").click();
    await sleep(30);
    check("重置回 25:00 并暂停", doc.getElementById("timer-display").textContent === "25:00");

    doc.getElementById("btn-timer-start").click();
    await sleep(30);
    window.__fd.timer.endAt = Date.now() + 700;
    window.__fd.timer.running = true;
    await sleep(1400);
    check("到点显示 00:00", doc.getElementById("timer-display").textContent === "00:00");
    check("到点状态提示", doc.getElementById("timer-status").textContent === "时间到");

    doc.getElementById("btn-timer-back").click();
    await sleep(60);
    check("返回后回我的页", !doc.getElementById("view-me").hidden);
    check("返回后导航恢复", !doc.getElementById("nav").hidden);
    check("返回后计时结束", window.__fd.timer.running === false && window.__fd.timer.remainingMs === 0);

    const sound = doc.getElementById("timer-sound");
    sound.checked = false;
    sound.dispatchEvent(new window.Event("change"));
    check("声音偏好已保存", window.localStorage.getItem("yizhuxiang-timer-sound") === "0");
  }

  console.log("== T31b 日记工具：卡片入口 + 全屏页 + 保存 + 日期切换 ==");
  {
    const { window, requests } = await boot();
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="me"]').click();
    doc.getElementById("btn-toggle-tools").click();
    await sleep(60);
    doc.getElementById("tool-card-diary").click();
    await sleep(100);
    check("日记全屏页打开", !doc.getElementById("view-tool-diary").hidden);
    check("日期标题非空", doc.getElementById("diary-date-label").textContent !== "");
    doc.getElementById("diary-input").value = "今天状态不错";
    doc.getElementById("btn-diary-save").click();
    await sleep(100);
    const put = requests.find((r) => r.method === "PUT" && r.u === "/api/diary");
    check("保存请求发出", !!put && JSON.parse(put.body).content === "今天状态不错", put ? put.body : "none");
    doc.getElementById("btn-diary-prev").click();
    await sleep(100);
    check("日期切换后请求加载", requests.some((r) => r.u.startsWith("/api/diary?date=")));
    doc.getElementById("diary-date-label").click();
    await sleep(80);
    check("日历弹窗打开", !doc.getElementById("overlay-diary-cal").hidden);
    check("日历标题为当前年月", doc.getElementById("cal-title").textContent !== "");
    doc.querySelector("#cal-grid .cal-day:not(.blank)").click();
    await sleep(100);
    check("选日期后日历关闭", doc.getElementById("overlay-diary-cal").hidden);
    doc.getElementById("btn-diary-today").click();
    await sleep(100);
    check("今天按钮回今天", doc.getElementById("diary-date-label").textContent !== "");
    doc.getElementById("btn-diary-back").click();
    await sleep(80);
    check("返回我的页", !doc.getElementById("view-me").hidden);
  }

  console.log("== T31c 日记搜索：按内容查找并跳转 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="me"]').click();
    await sleep(60);
    doc.getElementById("btn-toggle-tools").click();
    await sleep(60);
    doc.getElementById("tool-card-diary").click();
    await sleep(100);
    doc.getElementById("btn-diary-search").click();
    await sleep(60);
    check("搜索模式打开", !doc.getElementById("diary-search").hidden);
    check("搜索时日期导航让位", doc.getElementById("diary-date").hidden);
    doc.getElementById("diary-search-input").value = "爬山";
    doc.getElementById("btn-diary-search-go").click();
    await sleep(100);
    check("搜索结果 1 条", doc.querySelectorAll("#diary-search-results .diary-result").length === 1);
    check("结果日期正确", doc.querySelector("#diary-search-results .diary-result-date").textContent === "2026-08-01");
    doc.querySelector("#diary-search-results .diary-result").click();
    await sleep(100);
    check("点击结果关闭搜索", doc.getElementById("diary-search").hidden);
    check("跳到该日期", doc.getElementById("diary-date-label").textContent.includes("8/1"));
  }

  console.log("== T32 头像入口：点击头像打开文件选择 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="me"]').click();
    await sleep(80);
    check("头像按钮存在", !!doc.getElementById("avatar-btn"));
    check("默认显示香章", !doc.getElementById("profile-seal").hidden);
    doc.getElementById("avatar-btn").click();
    check("点击头像按钮不报错", true);
  }

  console.log("== T33 黑名单：添加/删除进程 ==");
  {
    const { window, requests } = await boot({ settings: { blacklist: ["bilibili"] } });
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="settings"]').click();
    await sleep(80);
    check("黑名单列表渲染", doc.querySelectorAll("#blacklist-list .blacklist-item").length === 1);
    check("删除进程按钮存在", !!doc.querySelector("#blacklist-list .blacklist-item .btn"));
    doc.getElementById("blacklist-input").value = "douyin";
    doc.getElementById("btn-blacklist-add").click();
    await sleep(30);
    check("添加后 2 条", doc.querySelectorAll("#blacklist-list .blacklist-item").length === 2);
    check("添加后自动保存", requests.some((r) => r.u === "/api/settings" && r.method === "PUT" && /"douyin"/.test(r.body)));
    doc.querySelector("#blacklist-list .blacklist-item .btn").click();
    await sleep(30);
    check("删除后剩 1 条", doc.querySelectorAll("#blacklist-list .blacklist-item").length === 1);
    doc.getElementById("btn-save-settings").click();
    await sleep(80);
    const saved = requests.filter((r) => r.u === "/api/settings" && r.method === "PUT").pop();
    check("保存带黑名单数组", !!saved && JSON.parse(saved.body).blacklist.join(",") === "douyin", saved ? saved.body : "none");
  }

  console.log("== T34 自定义时长：专注页与待办页 ==");
  {
    const { window, requests } = await boot({ todos: [ { id: 1, text: "写周报", sort_order: 0, done: false, is_daily: false, streak: 0 } ] });
    const doc = window.document;
    doc.getElementById("minutes-input").value = "90";
    doc.getElementById("minutes-input").dispatchEvent(new window.Event("input"));
    await sleep(30);
    check("专注页标签 90", doc.getElementById("minutes-label").textContent === "90");
    check("滑块钳到 60", doc.getElementById("minutes-slider").value === "60");
    doc.getElementById("task-input").value = "深度阅读";
    doc.getElementById("btn-start").click();
    await sleep(150);
    const post = requests.find((r) => r.u === "/api/sessions" && r.method === "POST");
    check("直接开始，专注会话时长为 90", !!post && JSON.parse(post.body).planned_minutes === 90, post ? post.body : "none");

    doc.getElementById("btn-abandon").click();
    await sleep(80);
    check("放弃需确认弹窗", !doc.getElementById("overlay-confirm").hidden);
    doc.getElementById("btn-confirm-ok").click();
    await sleep(80);
    check("确认后弹复盘窗", !doc.getElementById("overlay-reflect").hidden);
    doc.getElementById("btn-reflect-skip").click();
    await sleep(80);
    doc.querySelector('#nav .nav-btn[data-view="todo"]').click();
    await sleep(60);
    doc.getElementById("todo-minutes-input").value = "45";
    doc.getElementById("todo-minutes-input").dispatchEvent(new window.Event("input"));
    await sleep(30);
    check("待办页标签 45", doc.getElementById("todo-minutes-label").textContent === "45");
    doc.querySelector("#todo-list .todo-start").click();
    await sleep(150);
    const post2 = requests.filter((r) => r.u === "/api/sessions" && r.method === "POST").pop();
    check("待办会话时长为 45", !!post2 && JSON.parse(post2.body).planned_minutes === 45, post2 ? post2.body : "none");
  }

  console.log("== T35 今天建议专注分钟 ==");
  {
    const { window } = await boot({ weeklyOpts: { focusMinutes: 60, completedSessions: 3 } });
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="stats"]').click();
    await sleep(80);
    check("建议 20 分钟", doc.getElementById("suggest-target").textContent === "20");
  }
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="stats"]').click();
    await sleep(80);
    check("无数据时显示 —", doc.getElementById("suggest-target").textContent === "—");
  }

  console.log("== T36 刷新停留在当前页面 ==");
  {
    const { window } = await boot({ view: "todo" });
    const doc = window.document;
    check("刷新后留在待办页", !doc.getElementById("view-todo").hidden && doc.getElementById("view-home").hidden);
    doc.querySelector('#nav .nav-btn[data-view="stats"]').click();
    await sleep(60);
    check("切换后记录视图", window.localStorage.getItem("yizhuxiang-view") === "stats");
  }

  console.log("== T37 修行手册：入口 + 全屏页 + 我明白了 ==");
  {
    const { window } = await boot();
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="me"]').click();
    await sleep(60);
    doc.getElementById("btn-toggle-manual").click();
    await sleep(60);
    check("手册页打开", !doc.getElementById("view-manual").hidden);
    check("手册为全屏（导航隐藏）", doc.getElementById("nav").hidden);
    check("手册共 9 节", doc.querySelectorAll(".manual-item").length === 9);
    doc.getElementById("btn-manual-done").click();
    await sleep(60);
    check("我明白了返回我的页", doc.getElementById("view-manual").hidden && !doc.getElementById("view-me").hidden);
    check("已读标记写入", window.localStorage.getItem("yizhuxiang-manual-read") === "tester");
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
