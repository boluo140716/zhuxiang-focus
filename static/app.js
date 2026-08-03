/* FocusDojo 前端逻辑：会话、计时、归因、离线队列、统计、设置 */
"use strict";

const $ = (id) => document.getElementById(id);
const IDLE_MS = 3 * 60 * 1000; // 电脑端无操作阈值
const QKEY = "fd_queue";
const MIDKEY = "fd_idmap";
const LOCAL_SESSION = "fd_local_session";

const state = {
  session: null,
  settings: null,
  view: "home",
  hiddenAt: null,
  idleFlag: false,
  lastActivity: Date.now(),
  attrDuration: 0,
  attrTimer: null,
  reviewCompletion: 50,
  reviewFlow: 3,
  device: isTouch() ? "phone" : "desktop",
};

function isTouch() {
  return "ontouchstart" in window && navigator.maxTouchPoints > 0;
}

/* ---------- 工具 ---------- */
function toast(msg, ms = 2600) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function sessionStartTime(s) {
  if (typeof s.started_at === "number") return s.started_at;
  return Date.parse(s.started_at) || Date.now();
}

/* ---------- API 与离线队列 ---------- */
function getQueue() { try { return JSON.parse(localStorage.getItem(QKEY) || "[]"); } catch { return []; } }
function setQueue(q) { localStorage.setItem(QKEY, JSON.stringify(q)); }
function getMap() { try { return JSON.parse(localStorage.getItem(MIDKEY) || "{}"); } catch { return {}; } }
function setMap(m) { localStorage.setItem(MIDKEY, JSON.stringify(m)); }

async function apiDirect(path, method = "GET", body = null) {
  const opts = { method, headers: {} };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

function enqueue(item) {
  const q = getQueue();
  q.push(item);
  setQueue(q);
  toast(`离线中：已暂存 ${q.length} 条，联网后自动同步`);
  updateOfflineBadge();
}

async function flushQueue() {
  if (!navigator.onLine) return;
  const q = getQueue();
  if (!q.length) return;
  const map = getMap();
  const remaining = [];
  for (const item of q) {
    try {
      if (item.type === "start") {
        const r = await apiDirect("/api/sessions", "POST", item.body);
        if (r && r.id) map[item.clientKey] = r.id;
      } else if (item.type === "end") {
        const sid = map[item.clientKey];
        if (!sid) { remaining.push(item); continue; }
        await apiDirect(`/api/sessions/${sid}`, "PATCH", {
          action: item.action,
          completion_score: item.completion_score,
          flow_score: item.flow_score,
          actual_minutes: item.actual_minutes,
        });
      } else {
        await apiDirect(item.path, item.method, item.body);
      }
    } catch (e) { remaining.push(item); }
  }
  setMap(map);
  setQueue(remaining);
  updateOfflineBadge();
  if (remaining.length) toast(`还有 ${remaining.length} 条待同步`);
  else toast("离线数据已同步");
}

/* ---------- 会话流程 ---------- */
async function startSession(task, minutes) {
  const body = { task_name: task, planned_minutes: minutes, device: state.device, stage: "training" };
  const clientKey = "sk" + Date.now();
  let server = null;
  if (navigator.onLine) {
    try { server = await apiDirect("/api/sessions", "POST", body); } catch (e) {}
  }
  if (server) {
    state.session = server;
  } else {
    const local = { clientKey, task_name: task, planned_minutes: minutes, started_at: Date.now() };
    localStorage.setItem(LOCAL_SESSION, JSON.stringify(local));
    enqueue({ type: "start", body, clientKey });
    state.session = local;
  }
  enterRunning();
}

async function endSession(action) {
  const s = state.session;
  if (!s) return;
  const actual = Math.max(1, Math.round((Date.now() - sessionStartTime(s)) / 60000));
  const payload = {
    action,
    completion_score: action === "complete" ? state.reviewCompletion : null,
    flow_score: action === "complete" ? state.reviewFlow : null,
    actual_minutes: actual,
  };
  localStorage.removeItem(LOCAL_SESSION);
  if (s.id) {
    const queueItem = { type: "raw", path: `/api/sessions/${s.id}`, method: "PATCH", body: payload };
    await apiWriteQueue(`/api/sessions/${s.id}`, "PATCH", payload, queueItem);
  } else {
    enqueue({ type: "end", clientKey: s.clientKey, ...payload });
  }
  state.session = null;
  leaveRunning();
  refreshHome();
}

async function apiWriteQueue(path, method, body, queueItem) {
  if (!navigator.onLine) { enqueue(queueItem); return null; }
  try { return await apiDirect(path, method, body); }
  catch (e) { enqueue(queueItem); return null; }
}

async function recordDistraction(source, reason, appName, duration) {
  const s = state.session;
  const body = { source, app_name: appName || "", resolved_reason: reason, duration_minutes: duration || 0 };
  if (s && s.id) {
    const path = `/api/sessions/${s.id}/distractions`;
    await apiWriteQueue(path, "POST", body, { type: "raw", path, method: "POST", body });
  } else {
    await apiWriteQueue("/api/distractions", "POST", body, { type: "raw", path: "/api/distractions", method: "POST", body });
  }
}

/* ---------- 视图切换 ---------- */
function switchView(view) {
  state.view = view;
  document.querySelectorAll("#nav .nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("view-home").hidden = view !== "home";
  $("view-stats").hidden = view !== "stats";
  $("view-settings").hidden = view !== "settings";
  if (view === "stats") refreshStats();
  if (view === "home") refreshHome();
}

/* ---------- 主页 ---------- */
async function refreshHome() {
  if (!state.session) {
    $("home-running").hidden = true;
    $("home-idle").hidden = false;
  }
  try {
    const [daily, weekly] = await Promise.all([apiDirect("/api/stats/daily"), apiDirect("/api/stats/weekly")]);
    $("today-focus").textContent = daily.focus_minutes;
    $("today-sessions").textContent = daily.completed_sessions;
    $("today-distractions").textContent = daily.distractions;
    $("streak-num").textContent = weekly.streak;
    const rebound = !daily.qualified;
    $("rebound-area").hidden = !rebound;
    deepTimeReminder();
  } catch (e) { /* 离线时忽略 */ }
}

function enterRunning() {
  const s = state.session;
  $("home-idle").hidden = true;
  $("home-running").hidden = false;
  $("running-task").textContent = s.task_name || "专注中";
  $("running-hint").textContent = state.device === "phone"
    ? "把手机放下。中途拿起手机会被记录并归因。"
    : "正常干活就行，页面切换不算分心。超过 3 分钟没动静会回来问你。";
  updateOfflineBadge();
  tick();
}

function leaveRunning() {
  $("home-running").hidden = true;
  $("home-idle").hidden = false;
  hideOverlay("review");
  hideOverlay("attribution");
  hideOverlay("idle");
}

function updateOfflineBadge() {
  const offline = !navigator.onLine || getQueue().length > 0;
  $("offline-badge").hidden = !offline || !state.session;
}

function tick() {
  const s = state.session;
  if (!s) return;
  const elapsed = Math.max(0, (Date.now() - sessionStartTime(s)) / 1000);
  const remain = Math.max(0, s.planned_minutes * 60 - elapsed);
  const mm = String(Math.floor(remain / 60)).padStart(2, "0");
  const ss = String(Math.floor(remain % 60)).padStart(2, "0");
  $("timer").textContent = `${mm}:${ss}`;
  // 电脑端在岗检测：无操作超阈值 → 标记，回到页面时补问
  if (state.device === "desktop" && !state.idleFlag && Date.now() - state.lastActivity > IDLE_MS) {
    state.idleFlag = true;
  }
}

/* ---------- 手机归因 / 电脑补问 ---------- */
function handleVisibility() {
  const s = state.session;
  if (!s) return;
  if (document.hidden) {
    if (state.device === "phone") state.hiddenAt = Date.now();
  } else {
    if (state.device === "phone" && state.hiddenAt) {
      const dur = Math.round((Date.now() - state.hiddenAt) / 60000);
      state.hiddenAt = null;
      if (dur > 0) showAttribution(dur);
    }
    if (state.device === "desktop" && state.idleFlag) {
      showIdleOverlay();
    }
  }
}

function showAttribution(dur) {
  state.attrDuration = dur;
  $("attr-duration").textContent = dur;
  $("overlay-attribution").hidden = false;
  let left = 3;
  $("attr-countdown").textContent = `${left} 秒后默认记"刷手机"`;
  clearInterval(state.attrTimer);
  state.attrTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) { clearInterval(state.attrTimer); submitAttribution("刷手机"); }
    else $("attr-countdown").textContent = `${left} 秒后默认记"刷手机"`;
  }, 1000);
}

function submitAttribution(reason) {
  clearInterval(state.attrTimer);
  hideOverlay("attribution");
  recordDistraction("phone_pickup", reason, "", state.attrDuration);
  toast(reason === "刷手机" ? "已记录（不惩罚，回来就好）" : "已记为" + reason);
}

function showIdleOverlay() {
  if ($("overlay-attribution").hidden) $("overlay-idle").hidden = false;
}

/* ---------- 质量自评 ---------- */
function showReview() {
  state.reviewCompletion = 50;
  state.reviewFlow = 3;
  $("completion-slider").value = 50;
  $("completion-label").textContent = "50";
  document.querySelectorAll(".flow-btn").forEach((b) => b.classList.toggle("selected", +b.dataset.v === 3));
  $("overlay-review").hidden = false;
}

/* ---------- 统计 ---------- */
async function refreshStats() {
  let daily, weekly, insights, next;
  try {
    [daily, weekly, insights, next] = await Promise.all([
      apiDirect("/api/stats/daily"), apiDirect("/api/stats/weekly"),
      apiDirect("/api/stats/insights"), apiDirect("/api/stats/next_target"),
    ]);
  } catch (e) { toast("统计加载失败（离线？）"); return; }

  const maxMin = Math.max(1, ...weekly.days.map((d) => d.focus_minutes));
  const chart = $("week-chart");
  chart.innerHTML = "";
  weekly.days.forEach((d, i) => {
    const bar = document.createElement("div");
    bar.className = "day-bar" + (d.focus_minutes > 0 ? " filled" : "");
    bar.style.height = `${Math.max(6, (d.focus_minutes / maxMin) * 100)}px`;
    const label = document.createElement("div");
    label.className = "d";
    label.textContent = new Date(d.date + "T00:00:00").getDate() + (d.qualified ? "✓" : "");
    bar.appendChild(label);
    chart.appendChild(bar);
  });
  $("week-rate").textContent = Math.round(weekly.completion_rate * 100) + "%";
  $("week-streak").textContent = weekly.streak;
  $("next-target").textContent = next.suggested_target;
  state.suggestedTarget = next.suggested_target;

  if (insights.total_distractions > 0) {
    const worst = insights.worst_hours.map((h) => `${h.hour} 点(${h.count}次)`).join("、");
    $("insight-text").textContent = `最近最常破功的时段：${worst}`;
    $("insight-detail").textContent = `手机拿起 ${insights.phone_pickups} 次，自动检测到分心 ${insights.auto_detected} 次，共 ${insights.total_distractions} 次分心。`;
  } else {
    $("insight-text").textContent = "数据不足，先用起来。";
    $("insight-detail").textContent = "";
  }
}

/* ---------- 设置 ---------- */
function applySettingsToForm() {
  const s = state.settings;
  if (!s) return;
  $("blacklist-input").value = (s.blacklist || []).join("\n");
  $("target-slider").value = s.target_minutes;
  $("target-label").textContent = s.target_minutes;
  $("deep-start").value = s.deep_start || "09:00";
  $("deep-end").value = s.deep_end || "11:00";
  $("reminder-enabled").checked = !!s.reminder_enabled;
}

async function saveSettings() {
  const body = {
    blacklist: $("blacklist-input").value.split("\n").map((x) => x.trim()).filter(Boolean),
    target_minutes: parseInt($("target-slider").value, 10),
    deep_start: $("deep-start").value,
    deep_end: $("deep-end").value,
    reminder_enabled: $("reminder-enabled").checked,
  };
  const res = await apiWriteQueue("/api/settings", "PUT", body, { type: "raw", path: "/api/settings", method: "PUT", body });
  if (res) state.settings = res;
  toast("设置已保存");
}

/* ---------- 深度时段提醒 ---------- */
function deepTimeReminder() {
  const s = state.settings;
  if (!s || !s.reminder_enabled || state.session) return;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = parseTime(s.deep_start);
  const end = parseTime(s.deep_end);
  if (cur >= start && cur <= end) toast("现在是深度时段，该开始今天的专注了");
}
function parseTime(t) {
  const [h, m] = (t || "09:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/* ---------- 事件绑定 ---------- */
function hideOverlay(id) { $(`overlay-${id}`).hidden = true; }

function bindEvents() {
  document.querySelectorAll("#nav .nav-btn").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

  $("btn-start").addEventListener("click", () => {
    $("startup-task").value = $("task-input").value;
    $("startup-slider").value = $("minutes-slider").value;
    $("startup-minutes").textContent = $("minutes-slider").value;
    $("overlay-startup").hidden = false;
  });
  $("btn-cancel-start").addEventListener("click", () => hideOverlay("startup"));
  $("btn-confirm-start").addEventListener("click", () => {
    const task = $("startup-task").value.trim() || "未命名任务";
    const minutes = parseInt($("startup-slider").value, 10);
    hideOverlay("startup");
    startSession(task, minutes);
  });
  ["minutes-slider", "startup-slider"].forEach((id) => {
    $(id).addEventListener("input", (e) => {
      const target = id === "minutes-slider" ? "minutes-label" : "startup-minutes";
      $(target).textContent = e.target.value;
    });
  });

  $("btn-rebound").addEventListener("click", () => startSession("回弹任务", 5));
  $("btn-complete").addEventListener("click", showReview);
  $("btn-abandon").addEventListener("click", () => {
    if (confirm("确定放弃这场专注？")) endSession("abandon");
  });
  $("btn-distract").addEventListener("click", () => {
    recordDistraction("manual", "走神", "", 0);
    toast("已记录，不惩罚，回来就好");
  });

  $("completion-slider").addEventListener("input", (e) => {
    state.reviewCompletion = +e.target.value;
    $("completion-label").textContent = e.target.value;
  });
  document.querySelectorAll(".flow-btn").forEach((b) => b.addEventListener("click", () => {
    state.reviewFlow = +b.dataset.v;
    document.querySelectorAll(".flow-btn").forEach((x) => x.classList.toggle("selected", x === b));
  }));
  $("btn-submit-review").addEventListener("click", () => endSession("complete"));

  document.querySelectorAll("#overlay-attribution .btn").forEach((b) =>
    b.addEventListener("click", () => submitAttribution(b.dataset.reason)));
  document.querySelectorAll("#overlay-idle .btn").forEach((b) => b.addEventListener("click", () => {
    hideOverlay("idle");
    state.idleFlag = false;
    state.lastActivity = Date.now();
    if (b.dataset.idle === "distracted") recordDistraction("manual", "走神", "", 0);
    toast(b.dataset.idle === "distracted" ? "已记录" : "好，继续");
  }));
  const idleLaterBtn = $("btn-idle-later");
  if (idleLaterBtn) idleLaterBtn.addEventListener("click", () => {
    hideOverlay("idle");
    state.idleFlag = false;
    state.lastActivity = Date.now();
    toast("好，等会儿再问");
  });

  $("target-slider").addEventListener("input", (e) => { $("target-label").textContent = e.target.value; });
  $("btn-save-settings").addEventListener("click", saveSettings);
  $("btn-refresh-stats").addEventListener("click", refreshStats);
  $("btn-apply-target").addEventListener("click", async () => {
    if (!state.suggestedTarget) return;
    const body = { target_minutes: state.suggestedTarget };
    const res = await apiWriteQueue("/api/settings", "PUT", body, { type: "raw", path: "/api/settings", method: "PUT", body });
    if (res) { state.settings = res; applySettingsToForm(); }
    toast(`目标时长已更新为 ${state.suggestedTarget} 分钟`);
  });

  window.addEventListener("keydown", () => { state.lastActivity = Date.now(); }, { passive: true });
  window.addEventListener("mousemove", () => { state.lastActivity = Date.now(); }, { passive: true });
  window.addEventListener("mousedown", () => { state.lastActivity = Date.now(); }, { passive: true });
  window.addEventListener("touchstart", () => { state.lastActivity = Date.now(); }, { passive: true });
  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("online", () => { flushQueue(); refreshHome(); });
}

/* ---------- PWA ---------- */
function registerSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then((reg) => { try { reg.update(); } catch (e) {} }).catch(() => {});
  }
}

/* ---------- 启动 ---------- */
async function init() {
  bindEvents();
  registerSW();
  try { state.settings = await apiDirect("/api/settings"); } catch (e) {}
  if (state.settings) applySettingsToForm();

  let server = null;
  if (navigator.onLine) {
    try { server = await apiDirect("/api/sessions/current"); } catch (e) {}
  }
  let local = null;
  try { local = JSON.parse(localStorage.getItem(LOCAL_SESSION) || "null"); } catch (e) {}
  state.session = server || local;
  if (state.session) {
    if (isStaleSession(state.session)) autoAbandon(state.session);
    else enterRunning();
  } else {
    refreshHome();
  }

  setInterval(tick, 1000);
  setInterval(() => { if (navigator.onLine) flushQueue(); }, 20000);
  tick();
}

function isStaleSession(s) {
  // 会话超过"计划时长×2 或 30 分钟"仍未结束，视为遗留会话
  const elapsedMin = (Date.now() - sessionStartTime(s)) / 60000;
  const planned = s.planned_minutes || 15;
  return elapsedMin > Math.max(planned * 2, 30);
}

async function autoAbandon(s) {
  state.session = null;
  localStorage.removeItem(LOCAL_SESSION);
  const actual = Math.max(1, Math.round((Date.now() - sessionStartTime(s)) / 60000));
  const payload = { action: "abandon", completion_score: null, flow_score: null, actual_minutes: actual };
  if (s.id) {
    const queueItem = { type: "raw", path: `/api/sessions/${s.id}`, method: "PATCH", body: payload };
    await apiWriteQueue(`/api/sessions/${s.id}`, "PATCH", payload, queueItem);
  } else {
    enqueue({ type: "end", clientKey: s.clientKey, ...payload });
  }
  toast("检测到一场遗留的旧会话，已自动结束");
  refreshHome();
}

init();
