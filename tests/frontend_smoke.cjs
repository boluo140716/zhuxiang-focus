/* 一炷香 前端冒烟测试（jsdom）：核心流程 + 遗留会话自动结束 + 弹窗逃生 + 主题/印章/卷轴 */
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
  return { date: "2026-08-04", focus_minutes: 0, completed_sessions: 0, abandoned_sessions: 0, total_sessions: total, distractions: 0, distraction_minutes: 0, distraction_by_hour: [], qualified };
}
function weekly(opts = {}) {
  const days = [];
  const today = new Date(NOW);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - (6 - i) * 86400000);
    const iso = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    days.push({ date: iso, focus_minutes: 0, qualified: !!(opts.qualifiedDays && opts.qualifiedDays.includes(6 - i)) });
  }
  return { days, completion_rate: 0, streak: opts.streak || 0 };
}

async function boot({ current = null, localSession = null, totalSessions = 0, qualified = false, weeklyOpts = {} } = {}) {
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8000/", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  const requests = [];
  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || "GET";
    requests.push({ method, u });
    if (u === "/api/settings") return { ok: true, status: 200, json: async () => ({ blacklist: [], target_minutes: 15, deep_start: "09:00", deep_end: "11:00", reminder_enabled: false }) };
    if (u === "/api/sessions/current") return current ? { ok: true, status: 200, json: async () => current } : { ok: false, status: 404, json: async () => ({}) };
    if (u === "/api/stats/daily") return { ok: true, status: 200, json: async () => daily(totalSessions, qualified) };
    if (u === "/api/stats/weekly") return { ok: true, status: 200, json: async () => weekly(weeklyOpts) };
    if (u === "/api/stats/insights") return { ok: true, status: 200, json: async () => ({ total_distractions: 0, worst_hours: [], phone_pickups: 0, auto_detected: 0 }) };
    if (u === "/api/stats/next_target") return { ok: true, status: 200, json: async () => ({ suggested_target: 15 }) };
    if (u === "/api/sessions" && method === "POST") { const b = JSON.parse(opts.body || "{}"); return { ok: true, status: 201, json: async () => ({ id: 1, task_name: b.task_name, planned_minutes: b.planned_minutes, started_at: NOW, device: "desktop", stage: "training", status: "running" }) }; }
    if (/^\/api\/sessions\/\d+$/.test(u) && method === "PATCH") return { ok: true, status: 200, json: async () => ({ id: 1, status: "abandoned" }) };
    if (/^\/api\/sessions\/\d+\/distractions$/.test(u) && method === "POST") return { ok: true, status: 201, json: async () => ({ id: 1 }) };
    if (u === "/api/distractions" && method === "POST") return { ok: true, status: 201, json: async () => ({ id: 1 }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  if (localSession) window.localStorage.setItem("fd_local_session", JSON.stringify(localSession));
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
    check("回弹入口不显示（无数据）", doc.getElementById("rebound-area").hidden);
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
    check("timer 有内容", /^\d{2}:\d{2}$/.test(doc.getElementById("timer").textContent));
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
    check("启动仪式弹出", !doc.getElementById("overlay-startup").hidden);
    doc.getElementById("btn-confirm-start").click();
    await sleep(80);
    check("进入专注视图", !doc.getElementById("home-running").hidden);
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
    check("无达标时全为空印", doc.querySelectorAll("#week-seals .seal-sm.empty").length === 7);
  }
  {
    const { window } = await boot({ qualified: true, weeklyOpts: { streak: 3, qualifiedDays: [6] } });
    const doc = window.document;
    check("达标为实印", doc.getElementById("today-seal").classList.contains("done"));
    check("今天小印实心", doc.querySelectorAll("#week-seals .seal-sm.done").length === 1);
  }

  console.log("== T10 结业卷轴 ==");
  {
    const { window } = await boot({ weeklyOpts: { streak: 0 } });
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="stats"]').click();
    await sleep(80);
    check("streak=0 距毕业 4 周", doc.getElementById("scroll-text").textContent.includes("距毕业约 4 周"));
    check("进度条 0%", doc.getElementById("scroll-fill").style.width === "0%");
  }
  {
    const { window } = await boot({ weeklyOpts: { streak: 28 } });
    const doc = window.document;
    doc.querySelector('#nav .nav-btn[data-view="stats"]').click();
    await sleep(80);
    check("streak=28 距毕业 0 周", doc.getElementById("scroll-text").textContent.includes("距毕业约 0 周"));
    check("进度条 100%", doc.getElementById("scroll-fill").style.width === "100%");
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
