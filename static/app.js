/* 篆香 前端逻辑：会话、计时、归因、离线队列、统计、设置、主题、印章 */
"use strict";

const $ = (id) => document.getElementById(id);
const IDLE_MS = 3 * 60 * 1000; // 电脑端无操作阈值
const QKEY = "fd_queue";
const FD_THEME_KEY = "yizhuxiang-theme";
const MIDKEY = "fd_idmap";
const LOCAL_SESSION = "fd_local_session";
const TOKEN_KEY = "yizhuxiang-token";
const VIEW_KEY = "yizhuxiang-view";
const MANUAL_KEY = "yizhuxiang-manual-read";
const HIT_POLL_MS = 2000;     // 常规轮询监控命中状态间隔
const REMIND_SECONDS = 120;   // 分心提醒档位：每满 2 分钟提醒一次
const DISTRACT_NOTIFY_SECONDS = 12; // 命中持续超过 12 秒才发系统通知，避免手滑误触

const state = {
  session: null,
  settings: null,
  view: "home",
  hiddenAt: null,
  idleFlag: false,
  lastActivity: Date.now(),
  attrDuration: 0,
  attrTimer: null,
  reviewCompletion: 60,
  reviewFlow: 3,
  reviewReliance: "self",  // 自评：self 靠自己 / product 靠产品
  sessionDistractions: 0,  // 本场分心次数（完成复盘是否询问的依据）
  user: null,               // 当前登录用户
  authMode: "login",
  device: isTouch() ? "phone" : "desktop",
  distractLastMin: -1,
  distractSince: null,   // 当前连续命中的 since，变化时视为重新计时
  distractNotified: false, // 本连续段是否已发过系统通知
  ritualBusy: false,     // 回神仪式完成防抖
  ritualStage: 1,        // 回神仪式档位：1 受训 / 2 过渡 / 3 预备毕业
  ritualTodayCount: 0,   // 今天分心次数（L1 反馈用）
  graduated: false,      // 是否已毕业（自由专注模式：只记录，不干预）
  incenseReminded: false, // 香尽提醒已触发（只提醒一次）
  incenseDistracted: false, // 破功后香冻结（熄灭断烟）
};

function isTouch() {
  return "ontouchstart" in window && navigator.maxTouchPoints > 0;
}

function isNakedDay() {
  const day = state.settings && state.settings.naked_day;
  if (!day) return false;
  const iso = new Date().getDay() === 0 ? 7 : new Date().getDay(); // JS getDay: 0=周日 → ISO 7=周日
  return iso === Number(day);
}

function isFreeMode() {
  return !!state.graduated;
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

function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

async function apiDirect(path, method = "GET", body = null) {
  const opts = { method, headers: {} };
  const token = getToken();
  if (token) opts.headers["Authorization"] = "Bearer " + token;
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    // 登录过期：清凭证回登录页（登录/注册接口自身的 401 由表单处理）
    clearToken();
    showAuth();
    throw new Error("登录已过期，请重新登录");
  }
  if (!res.ok) {
    let detail = `${method} ${path} -> ${res.status}`;
    try { const j = await res.json(); if (j && j.detail) detail = j.detail; } catch (e) {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

function enqueue(item) {
  const q = getQueue();
  q.push(item);
  setQueue(q);
  toast(`同步失败：已暂存 ${q.length} 条，将自动重试`);
  updateOfflineBadge();
}

async function flushQueue() {
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
          reliance: item.reliance,
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
async function startSession(task, minutes, todoId) {
  state.sessionDistractions = 0;
  state.incenseReminded = false;
  const body = { task_name: task, planned_minutes: minutes, device: state.device, stage: "training" };
  if (todoId) body.todo_id = todoId;
  const clientKey = "sk" + Date.now();
  let server = null;
  try { server = await apiDirect("/api/sessions", "POST", body); } catch (e) {}
  if (server) {
    state.session = server;
  } else {
    const local = { clientKey, task_name: task, planned_minutes: minutes, started_at: Date.now(), todo_id: todoId || null };
    localStorage.setItem(LOCAL_SESSION, JSON.stringify(local));
    enqueue({ type: "start", body, clientKey });
    state.session = local;
  }
  enterRunning();
}

async function endSession(action) {
  const s = state.session;
  if (!s) return;
  const todoId = s.todo_id || null;
  const actual = Math.max(1, Math.round((Date.now() - sessionStartTime(s)) / 60000));
  const payload = {
    action,
    completion_score: action === "complete" ? state.reviewCompletion : null,
    flow_score: action === "complete" ? state.reviewFlow : null,
    reliance: action === "complete" ? state.reviewReliance : null,
    actual_minutes: actual,
    reflection: (action === "complete" ? $("review-reflect").value.trim() : $("reflect-input").value.trim()) || null,
  };
  localStorage.removeItem(LOCAL_SESSION);
  if (s.id) {
    const queueItem = { type: "raw", path: `/api/sessions/${s.id}`, method: "PATCH", body: payload };
    const res = await apiWriteQueue(`/api/sessions/${s.id}`, "PATCH", payload, queueItem);
    const autoDistracted = !!(res && res.auto_distracted);
    if (action === "complete" && !autoDistracted && (state.reviewCompletion || 0) >= 80) showEncouragement();
  } else {
    enqueue({ type: "end", clientKey: s.clientKey, ...payload });
  }
  state.session = null;
  state.sessionDistractions = 0;
  if (action === "complete" && todoId) await completeTodo(todoId);
  leaveRunning();
  refreshHome();
  if (action === "complete") checkGraduation();
  silentSync(); // 专注结束触发一轮静默同步
}

const ENCOURAGE_TEXT = ["这一场又稳又干净", "干净利落，心无旁骛", "这一场，漂亮", "专注得很扎实"];
function showEncouragement() {
  let idx = parseInt(localStorage.getItem("yizhuxiang-encourage-idx") || "0", 10) || 0;
  idx = (idx + 1) % ENCOURAGE_TEXT.length;
  localStorage.setItem("yizhuxiang-encourage-idx", String(idx));
  toast(ENCOURAGE_TEXT[idx]);
}

async function checkGraduation() {
  try {
    const g = await apiDirect("/api/settings/graduation");
    if (g && g.eligible && !g.graduated_at) {
      $("grad-date").textContent = "毕业日期：" + new Date().toISOString().slice(0, 10);
      $("overlay-graduation").hidden = false;
    }
  } catch (e) { /* 离线忽略 */ }
}

async function apiWriteQueue(path, method, body, queueItem) {
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
  if (s) state.sessionDistractions = (state.sessionDistractions || 0) + 1;
}

/* ---------- 登录/注册 ---------- */
function showAuth() {
  state.user = null;
  state.session = null;
  localStorage.removeItem(LOCAL_SESSION);
  localStorage.removeItem(QKEY);
  localStorage.removeItem(MIDKEY);
  // 隐藏所有视图
  $("view-auth").hidden = false;
  $("view-home").hidden = true;
  $("view-stats").hidden = true;
  $("view-settings").hidden = true;
  $("view-me").hidden = true;
  $("view-tool-timer").hidden = true;
  $("view-tool-diary").hidden = true;
  $("nav").hidden = true;
  hideOverlay("startup");
  hideOverlay("review");
  hideOverlay("attribution");
  hideOverlay("idle");
  hideOverlay("distract");
  hideOverlay("ritual");
  // 清空登录表单
  $("auth-username").value = "";
  $("auth-password").value = "";
  $("auth-nickname").value = "";
  $("auth-password2").value = "";
  $("auth-error").textContent = "";
  setAuthMode("login");
}

function enterApp() {
  $("view-auth").hidden = true;
  $("nav").hidden = false;
  $("auth-error").textContent = "";
  switchView(restoredView()); // 刷新/登录后留在上次的页面
}

function setAuthMode(mode) {
  state.authMode = mode;
  document.querySelectorAll(".auth-tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const reg = mode === "register";
  $("auth-nickname").hidden = !reg;
  $("auth-pw2-row").hidden = !reg;
  $("auth-security-row").hidden = true; // 注册页不显示安全问题，需要时在账号管理设置
  $("btn-auth-forgot").hidden = reg;
  if (!reg) { $("auth-question").value = ""; $("auth-answer").value = ""; }
  $("auth-title").textContent = reg ? "开卷" : "入定";
  $("auth-subtitle").textContent = reg ? "注册后开始你的专注修行" : "登录后开始今天的专注";
  $("btn-auth-submit").textContent = reg ? "注册并进入" : "进入";
  $("auth-password").autocomplete = reg ? "new-password" : "current-password";
}

async function submitAuth() {
  const mode = state.authMode;
  const username = $("auth-username").value.trim();
  const password = $("auth-password").value;
  $("auth-error").textContent = "";
  if (!username || !password) { $("auth-error").textContent = "用户名和密码都要填"; return; }
  let url, payload;
  if (mode === "register") {
    const nickname = $("auth-nickname").value.trim();
    const password2 = $("auth-password2").value;
    const question = $("auth-question").value;
    const answer = $("auth-answer").value.trim();
    if (password.length < 6) { $("auth-error").textContent = "密码至少 6 位"; return; }
    if (password !== password2) { $("auth-error").textContent = "两次密码不一致"; return; }
    if (question && !answer) { $("auth-error").textContent = "选了安全问题，答案也要填"; return; }
    url = "/api/auth/register";
    payload = { username, nickname, password };
    if (question && answer) { payload.security_question = question; payload.security_answer = answer; }
  } else {
    url = "/api/auth/login";
    payload = { username, password };
  }
  try {
    const res = await apiDirect(url, "POST", payload);
    setToken(res.token);
    state.user = res.user;
    enterApp();
    await initData();
    if (mode === "register") {
      openManual(); // 新用户首次注册自动翻开手册（手册即欢迎仪式，不再弹 toast）
    } else {
      toast("欢迎回来");
    }
  } catch (e) {
    $("auth-error").textContent = e.message;
  }
}

function logout() {
  clearToken();
  state.session = null;
  localStorage.removeItem(LOCAL_SESSION);
  showAuth();
  toast("已退出登录");
}

/* ---------- 忘记密码（安全问题重置） ---------- */
let resetUser = "";

function openResetOverlay() {
  resetUser = "";
  ["reset-username", "reset-answer", "reset-pw", "reset-pw2"].forEach((id) => $(id).value = "");
  $("reset-question").hidden = true;
  $("reset-answer").hidden = true;
  $("reset-pw").hidden = true;
  $("reset-pw2").hidden = true;
  $("btn-reset-ok").hidden = true;
  $("btn-reset-next").hidden = false;
  $("reset-msg").textContent = "";
  $("overlay-reset").hidden = false;
}

async function resetNext() {
  const username = $("reset-username").value.trim();
  $("reset-msg").textContent = "";
  if (!username) { $("reset-msg").textContent = "请输入用户名"; return; }
  try {
    const r = await apiDirect("/api/auth/security-question?username=" + encodeURIComponent(username));
    resetUser = username;
    $("reset-question").textContent = "安全问题：" + r.question;
    $("reset-question").hidden = false;
    $("reset-answer").hidden = false;
    $("reset-pw").hidden = false;
    $("reset-pw2").hidden = false;
    $("btn-reset-ok").hidden = false;
    $("btn-reset-next").hidden = true;
  } catch (e) {
    $("reset-msg").textContent = e.message;
  }
}

async function resetOk() {
  const answer = $("reset-answer").value.trim();
  const pw = $("reset-pw").value;
  const pw2 = $("reset-pw2").value;
  $("reset-msg").textContent = "";
  if (!answer) { $("reset-msg").textContent = "请回答安全问题"; return; }
  if (pw.length < 6) { $("reset-msg").textContent = "新密码至少 6 位"; return; }
  if (pw !== pw2) { $("reset-msg").textContent = "两次新密码不一致"; return; }
  try {
    await apiDirect("/api/auth/reset-password", "POST", { username: resetUser, answer, new_password: pw });
    $("overlay-reset").hidden = true;
    toast("密码已重置，请用新密码登录");
  } catch (e) {
    $("reset-msg").textContent = e.message;
  }
}

function cancelReset() {
  $("overlay-reset").hidden = true;
}

async function saveSecurity() {
  const question = $("security-question").value;
  const answer = $("security-answer").value.trim();
  $("profile-msg").textContent = "";
  if (!question) { $("profile-msg").textContent = "请选择安全问题"; return; }
  if (!answer) { $("profile-msg").textContent = "请填写答案"; return; }
  try {
    await apiDirect("/api/auth/security", "POST", { question, answer });
    $("profile-msg").textContent = "安全问题已保存";
    setTimeout(() => { $("profile-msg").textContent = ""; }, 1000);
  } catch (e) { $("profile-msg").textContent = e.message; }
}

function homeMinutes() {
  const v = parseInt($("minutes-input").value, 10);
  return Math.min(180, Math.max(1, v)) || parseInt($("minutes-slider").value, 10) || 15;
}

function syncHomeMinutes() {
  const m = homeMinutes();
  $("minutes-label").textContent = m;
  $("minutes-slider").value = Math.min(60, Math.max(5, m));
}

/* ---------- 待办 ---------- */
async function refreshTodos() {
  try {
    const list = await apiDirect("/api/todos");
    renderTodos(list || []);
  } catch (e) { /* 离线时保留现状 */ }
}

function renderTodos(list) {
  const items = list || [];
  const daily = items.filter((t) => t.is_daily);
  const normal = items.filter((t) => !t.is_daily && !t.done);
  const dailyWrap = $("todo-daily-list");
  const normalWrap = $("todo-list");
  dailyWrap.innerHTML = "";
  normalWrap.innerHTML = "";
  $("todo-daily-empty").hidden = daily.length > 0;
  $("todo-empty").hidden = normal.length > 0;
  daily.forEach((t) => dailyWrap.appendChild(buildTodoItem(t, !!t.done)));
  normal.forEach((t) => normalWrap.appendChild(buildTodoItem(t, false)));
}

function buildTodoItem(t, doneToday) {
  const item = document.createElement("div");
  item.className = "todo-item" + (doneToday ? " todo-done" : "");
  item.dataset.id = t.id;
  item.dataset.isDaily = t.is_daily ? "1" : "0";
  const main = document.createElement("div");
  main.className = "todo-main";
  const text = document.createElement("span");
  text.className = "todo-text";
  text.textContent = t.text;
  text.title = t.text;
  main.appendChild(text);
  if (t.is_daily) {
    const badge = document.createElement("span");
    badge.className = "todo-badge";
    badge.textContent = "每日";
    main.appendChild(badge);
    if (t.streak > 0) {
      const st = document.createElement("span");
      st.className = "todo-streak";
      st.textContent = "已打卡 " + t.streak + " 天";
      main.appendChild(st);
    }
  }
  if (doneToday) {
    const mark = document.createElement("span");
    mark.className = "todo-done-mark";
    mark.textContent = "✓ 今日已完成";
    main.appendChild(mark);
  }
  item.appendChild(main);
  if (!doneToday) {
    const start = document.createElement("button");
    start.className = "btn btn-primary btn-sm todo-start";
    start.textContent = "开始专心";
    item.appendChild(start);
    if (t.is_daily) {
      const chk = document.createElement("button");
      chk.className = "btn btn-ghost btn-sm todo-check";
      chk.textContent = "完成打卡";
      item.appendChild(chk);
    }
  }
  const ops = document.createElement("div");
  ops.className = "todo-ops";
  [["edit", "改"], ["del", "删"]].forEach(([op, label]) => {
    const b = document.createElement("button");
    b.className = "btn btn-ghost btn-sm";
    b.dataset.op = op;
    b.setAttribute("aria-label", op);
    b.textContent = label;
    ops.appendChild(b);
  });
  item.appendChild(ops);
  return item;
}
async function addTodo(isDaily = false) {
  const input = isDaily ? $("todo-daily-input") : $("todo-input");
  const text = input.value.trim();
  if (!text) { toast("先写点什么再添加"); return; }
  input.value = "";
  try {
    await apiDirect("/api/todos", "POST", isDaily ? { text, is_daily: true } : { text });
    refreshTodos();
  } catch (e) { toast(e.message); }
}

function todoMinutes() {
  const v = parseInt($("todo-minutes-input").value, 10);
  return Math.min(180, Math.max(1, v)) || parseInt($("todo-minutes-slider").value, 10) || 15;
}

function onTodoMinutesInput() {
  const m = todoMinutes();
  $("todo-minutes-label").textContent = m;
  $("todo-minutes-slider").value = Math.min(60, Math.max(5, m));
}

async function startFromTodo(id, text) {
  await startSession(text, todoMinutes(), id);
  switchView("home");
}

async function deleteTodo(id) {
  showConfirm("删除这条待办？", async () => {
    try {
      await apiDirect(`/api/todos/${id}`, "DELETE");
      refreshTodos();
    } catch (e) { toast(e.message); }
  });
}


async function checkInTodo(id) {
  try {
    await apiWriteQueue(`/api/todos/${id}`, "PATCH", { done: true }, { type: "raw", path: `/api/todos/${id}`, method: "PATCH", body: { done: true } });
    refreshTodos();
  } catch (e) { toast(e.message); }
}
function editTodo(id, current) {
  const item = document.querySelector(`.todo-item[data-id="${id}"]`);
  if (!item) return;
  const textEl = item.querySelector(".todo-text");
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 100;
  input.className = "todo-edit";
  input.value = current;
  textEl.replaceWith(input);
  input.focus();
  let committed = false;
  const commit = async (save) => {
    if (committed) return;
    committed = true;
    const val = input.value.trim();
    if (save && val && val !== current) {
      try { await apiDirect(`/api/todos/${id}`, "PATCH", { text: val }); } catch (e) { toast(e.message); }
    }
    refreshTodos();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
}

async function completeTodo(id) {
  if (!id) return;
  await apiWriteQueue(`/api/todos/${id}`, "PATCH", { done: true }, { type: "raw", path: `/api/todos/${id}`, method: "PATCH", body: { done: true } });
  refreshTodos();
}
function onTodoListClick(e) {
  const btn = e.target.closest("button");
  if (!btn) return;
  const item = btn.closest(".todo-item");
  if (!item) return;
  const id = item.dataset.id;  // UUID 字符串主键，不再 parseInt
  if (btn.classList.contains("todo-start")) {
    startFromTodo(id, item.querySelector(".todo-text").textContent);
    return;
  }
  if (btn.classList.contains("todo-check")) {
    checkInTodo(id);
    return;
  }
  const op = btn.dataset.op;
  if (op === "edit") editTodo(id, item.querySelector(".todo-text").textContent);
  else if (op === "del") deleteTodo(id);
}
/* ---------- 计时器工具（纯前端，不计入统计） ---------- */
const TIMER_SOUND_KEY = "yizhuxiang-timer-sound";
const REMIND_SOUND_KEY = "yizhuxiang-remind-sound";
const REMIND_NOTIFY_KEY = "yizhuxiang-remind-notify";
const REMIND_NOTIFY_DISTRACT_KEY = "yizhuxiang-remind-notify-distract";
const DISTRACT_NOTIFY_GUIDED_KEY = "yizhuxiang-distract-notify-guided";
const timerState = { minutes: 15, endAt: 0, remainingMs: 0, running: false, done: false, started: false };

function timerSecondsLeft() {
  if (!timerState.running) return Math.max(0, timerState.remainingMs);
  return Math.max(0, timerState.endAt - Date.now());
}

function renderTimer() {
  let sec;
  if (!timerState.started && timerState.remainingMs === 0) {
    sec = timerState.minutes * 60; // 尚未开始：显示当前设定时长
  } else {
    sec = Math.ceil(timerSecondsLeft() / 1000);
  }
  const mm = String(Math.floor(sec / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");
  const disp = $("timer-display");
  disp.textContent = mm + ":" + ss;
  disp.classList.toggle("done", timerState.done);
  $("btn-timer-start").textContent = timerState.running ? "暂停" : (timerState.remainingMs > 0 ? "继续" : "开始");
  $("btn-timer-stop").disabled = !timerState.running && !timerState.remainingMs;
  $("timer-status").textContent = timerState.done ? "时间到" : "";
}

function startTimer() {
  startTimerTick(); // 开始后由 tick 驱动倒计时显示
  if (!timerState.started) $("timer-settings").hidden = true; // 开始后收起时长设置
  timerState.started = true;
  if (timerState.done) { timerState.done = false; timerState.remainingMs = 0; }
  if (timerState.running) {
    timerState.remainingMs = Math.max(0, timerState.endAt - Date.now());
    timerState.running = false;
  } else if (timerState.remainingMs > 0) {
    timerState.endAt = Date.now() + timerState.remainingMs;
    timerState.running = true;
  } else {
    const custom = parseInt($("timer-custom").value, 10);
    if (custom > 0) timerState.minutes = Math.min(120, custom);
    timerState.minutes = Math.min(120, Math.max(1, timerState.minutes));
    timerState.remainingMs = timerState.minutes * 60000;
    timerState.endAt = Date.now() + timerState.remainingMs;
    timerState.running = true;
  }
  renderTimer();
}

function resetTimer() {
  if (timerTickId) { clearInterval(timerTickId); timerTickId = null; }
  timerState.running = false;
  timerState.done = false;
  timerState.remainingMs = timerState.minutes * 60000;
  renderTimer();
}

function stopTimer() {
  if (timerTickId) { clearInterval(timerTickId); timerTickId = null; }
  timerState.running = false;
  timerState.done = false;
  timerState.remainingMs = 0;
  renderTimer();
}

function pickTimerChip(b) {
  document.querySelectorAll("#timer-chips .chip").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  timerState.minutes = parseInt(b.dataset.min, 10);
  $("timer-custom").value = "";
  updateTimerMinutesLabel();
  if (!timerState.running) {
    timerState.remainingMs = timerState.minutes * 60000;
    renderTimer();
  }
}

function onTimerCustom(e) {
  const v = parseInt(e.target.value, 10);
  if (v > 0 && !timerState.running) {
    timerState.minutes = Math.min(120, v);
    timerState.remainingMs = timerState.minutes * 60000;
    updateTimerMinutesLabel();
    renderTimer();
  }
}

function toggleTools() {
  const show = $("tools-panel").hidden;
  $("tools-panel").hidden = !show;
  $("btn-toggle-tools").textContent = show ? "收起工具" : "工具";
  if (show) renderTimer();
}

function toggleReflect() {
  const show = $("reflect-panel").hidden;
  $("reflect-panel").hidden = !show;
  $("btn-toggle-reflect").textContent = show ? "收起复盘" : "复盘";
  if (show) {
    apiDirect("/api/stats/reflections").then((d) => renderReflections(d)).catch(() => { /* 离线忽略 */ });
  }
}

let timerTickId = null;
function startTimerTick() {
  if (timerTickId) return;
  timerTickId = setInterval(() => {
    if (!timerState.running) return;
    if (Date.now() >= timerState.endAt) {
      timerState.running = false;
      timerState.remainingMs = 0;
      timerState.done = true;
      finishTimer();
    }
    renderTimer();
  }, 500);
}

function finishTimer() {
  renderTimer();
  if ($("timer-sound").checked) playTimerBeep();
  toast("时间到");
}

let beepCtx = null;
function playTimerBeep() {
  try {
    beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = beepCtx;
    if (ctx.state === "suspended") ctx.resume();
    [0, 0.35, 0.7].forEach((t, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = i === 1 ? 880 : 660;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.3);
    });
  } catch (e) { /* 无音频环境时静默 */ }
}

/* 香尽提醒：柔和钵声 + 系统通知（后端发 Windows toast） */
let bellCtx = null;
function playIncenseBell() {
  try {
    bellCtx = bellCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = bellCtx.currentTime;
    [0, 1, 2].forEach((i) => {
      const osc = bellCtx.createOscillator();
      const gain = bellCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = i === 0 ? 220 : i === 1 ? 440 : 554;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(i === 0 ? 0.2 : 0.06, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
      osc.connect(gain).connect(bellCtx.destination);
      osc.start(t);
      osc.stop(t + 2.8);
    });
  } catch (e) { /* 无音频环境静默 */ }
}

function notifyIncenseDone() {
  if (localOrSetting("remind_sound", REMIND_SOUND_KEY, true)) playIncenseBell();
  if (localOrSetting("remind_notify", REMIND_NOTIFY_KEY, false)) {
    try {
      fetch("/api/notify/toast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "篆香", body: "一炷香已尽，这一场可以收束了。" }),
      }).catch(() => {});
    } catch (e) { /* 忽略 */ }
  }
}

function notifyDistractHit(appName) {
  if (!localOrSetting("remind_notify_distract", REMIND_NOTIFY_DISTRACT_KEY, false)) return;
  try {
    fetch("/api/notify/toast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "篆香", body: `正在使用 ${appName}，回来专注。` }),
    }).catch(() => {});
  } catch (e) { /* 忽略 */ }
}

/* 首次命中时引导开启系统通知（只出现一次，用户点开或跳过都不再打扰） */
function maybeShowDistractNotifyGuide() {
  const guide = $("distract-notify-guide");
  if (!guide || localOrSetting("remind_notify_distract", REMIND_NOTIFY_DISTRACT_KEY, false) || localStorage.getItem(DISTRACT_NOTIFY_GUIDED_KEY)) return;
  localStorage.setItem(DISTRACT_NOTIFY_GUIDED_KEY, "1");
  guide.hidden = false;
}

function loadTimerSound() {
  $("timer-sound").checked = localOrSetting("timer_sound", TIMER_SOUND_KEY, true);
}

function loadReminderPrefs() {
  $("reminder-sound").checked = localOrSetting("remind_sound", REMIND_SOUND_KEY, true);
  $("reminder-notify").checked = localOrSetting("remind_notify", REMIND_NOTIFY_KEY, false);
  $("reminder-notify-distract").checked = localOrSetting("remind_notify_distract", REMIND_NOTIFY_DISTRACT_KEY, false);
}

function updateTimerMinutesLabel() {
  const el = $("timer-minutes-label");
  if (el) el.textContent = timerState.minutes;
}

function openTimerTool() {
  document.querySelectorAll("section[id^='view-']").forEach((el) => { el.hidden = true; });
  $("nav").hidden = true;
  $("brandbar").hidden = true;
  $("view-tool-timer").hidden = false;
  // 进入先选时长，点「开始」才计时
  timerState.minutes = Math.min(120, Math.max(1, timerState.minutes || 15));
  timerState.remainingMs = 0;
  timerState.running = false;
  timerState.started = false;
  timerState.done = false;
  $("timer-settings").hidden = false;
  renderTimer();
}

function closeTimerTool() {
  stopTimer(); // 返回即结束计时
  $("view-tool-timer").hidden = true;
  $("nav").hidden = false;
  $("brandbar").hidden = false;
  switchView("me");
}

/* ---------- 日记工具 ---------- */
const diaryState = { date: null, timer: null, calMonth: null };

function diaryDateKey(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function openDiaryTool() {
  document.querySelectorAll("section[id^='view-']").forEach((el) => { el.hidden = true; });
  $("nav").hidden = true;
  $("brandbar").hidden = true;
  $("view-tool-diary").hidden = false;
  diaryState.date = new Date(); // 默认今天
  loadDiary();
}

function closeDiaryTool() {
  clearTimeout(diaryState.timer);
  // 直接保存，不调用 saveDiary()（避免循环调用）
  if (diaryState.date) {
    const content = $("diary-input").value;
    apiDirect("/api/diary", "PUT", { date: diaryDateKey(diaryState.date), content }).catch(() => {});
  }
  $("view-tool-diary").hidden = true;
  $("nav").hidden = false;
  $("brandbar").hidden = false;
  switchView("me");
}

function renderDiaryDate() {
  const d = diaryState.date;
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  $("diary-date-label").textContent = `${d.getMonth() + 1}/${d.getDate()} 周${week}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dZero = new Date(d); dZero.setHours(0, 0, 0, 0);
  const isFuture = dZero > today;
  $("btn-diary-next").disabled = isFuture;
  $("diary-input").readOnly = isFuture;
  $("diary-input").placeholder = isFuture ? "未来的日子，还不存在" : "静下来，写几句。";
  $("btn-diary-save").hidden = isFuture;
}

async function loadDiary() {
  if (!diaryState.date) return;
  renderDiaryDate();
  clearTimeout(diaryState.timer);
  $("diary-input").value = "";
  $("diary-saved").textContent = "";
  try {
    const d = await apiDirect("/api/diary?date=" + diaryDateKey(diaryState.date));
    $("diary-input").value = d.content || "";
  } catch (e) { /* 离线忽略 */ }
}

async function saveDiary(closeAfter = false) {
  clearTimeout(diaryState.timer);
  if (!diaryState.date) return;
  const content = $("diary-input").value;
  try {
    await apiDirect("/api/diary", "PUT", { date: diaryDateKey(diaryState.date), content });
  } catch (e) { /* 离线忽略 */ }
  if (closeAfter) closeDiaryTool();
}

function shiftDiaryDate(delta) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const next = new Date(diaryState.date);
  next.setDate(next.getDate() + delta);
  next.setHours(0, 0, 0, 0);
  if (next > today) return; // 不允许翻到未来
  diaryState.date.setDate(diaryState.date.getDate() + delta);
  loadDiary();
}

function openDiaryCal() {
  diaryState.calMonth = new Date(diaryState.date.getFullYear(), diaryState.date.getMonth(), 1);
  renderDiaryCal();
  $("overlay-diary-cal").hidden = false;
}

function closeDiaryCal() {
  $("overlay-diary-cal").hidden = true;
}

function renderDiaryCal() {
  const y = diaryState.calMonth.getFullYear();
  const m = diaryState.calMonth.getMonth();
  $("cal-title").textContent = `${y} 年 ${m + 1} 月`;
  const grid = $("cal-grid");
  grid.innerHTML = "";
  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // 周一起始
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayKey = diaryDateKey(today);
  const selectedKey = diaryDateKey(diaryState.date);
  for (let i = 0; i < firstDow; i++) {
    const blank = document.createElement("span");
    blank.className = "cal-day blank";
    grid.appendChild(blank);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const isFuture = key > todayKey;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cal-day" + (key === todayKey ? " today" : "") + (key === selectedKey ? " selected" : "") + (isFuture ? " future" : "");
    btn.textContent = d;
    btn.dataset.key = key;
    if (!isFuture) {
      btn.addEventListener("click", () => {
        diaryState.date = new Date(key + "T00:00:00");
        closeDiaryCal();
        loadDiary();
      });
    }
    grid.appendChild(btn);
  }
}

/* ---------- 时间选择（静修时段） ---------- */
const timePicker = { target: null, hour: 9, minute: 0 };

function openTimePicker(targetId) {
  const input = $(targetId);
  timePicker.target = targetId;
  const parts = (input.value || "09:00").split(":").map(Number);
  timePicker.hour = parts[0] || 9;
  timePicker.minute = parts[1] || 0;
  $("tp-title").textContent = targetId === "deep-start" ? "静修时段 · 开始" : "静修时段 · 结束";
  renderTimePicker();
  $("overlay-time-picker").hidden = false;
}

function renderTimePicker() {
  const hours = $("tp-hours");
  hours.innerHTML = "";
  for (let h = 0; h < 24; h++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tp-num" + (h === timePicker.hour ? " selected" : "");
    b.textContent = String(h).padStart(2, "0");
    b.addEventListener("click", () => { timePicker.hour = h; renderTimePicker(); });
    hours.appendChild(b);
  }
  const mins = $("tp-minutes");
  mins.innerHTML = "";
  for (let m = 0; m < 60; m += 5) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tp-num" + (m === timePicker.minute ? " selected" : "");
    b.textContent = String(m).padStart(2, "0");
    b.addEventListener("click", () => { timePicker.minute = m; renderTimePicker(); });
    mins.appendChild(b);
  }
}

function confirmTimePicker() {
  const v = `${String(timePicker.hour).padStart(2, "0")}:${String(timePicker.minute).padStart(2, "0")}`;
  $(timePicker.target).value = v;
  const btn = $(timePicker.target + "-btn");
  if (btn) btn.textContent = v;
  $("overlay-time-picker").hidden = true;
}

function cancelTimePicker() {
  $("overlay-time-picker").hidden = true;
}

function goDiaryToday() {
  diaryState.date = new Date();
  loadDiary();
}

/* ---------- 日记搜索 ---------- */
function openDiarySearch() {
  $("diary-date").hidden = true;
  $("diary-quick").hidden = true;
  $("diary-input").hidden = true;
  $("diary-foot").hidden = true;
  $("diary-search").hidden = false;
  $("diary-search-results").innerHTML = "";
  $("diary-search-empty").hidden = true;
  $("diary-search-input").value = "";
  $("diary-search-input").focus();
}

function closeDiarySearch() {
  $("diary-search").hidden = true;
  $("diary-date").hidden = false;
  $("diary-quick").hidden = false;
  $("diary-input").hidden = false;
  $("diary-foot").hidden = false;
}

function diarySnippet(content, q) {
  const keywords = q.split(/\s+/).filter(Boolean);
  let idx = -1;
  for (const kw of keywords) {
    const i = content.indexOf(kw);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) idx = 0;
  const start = Math.max(0, idx - 8);
  const snip = content.slice(start, start + 50);
  return (start > 0 ? "…" : "") + snip + (start + 50 < content.length ? "…" : "");
}

async function doDiarySearch() {
  const q = $("diary-search-input").value.trim();
  const list = $("diary-search-results");
  const empty = $("diary-search-empty");
  list.innerHTML = "";
  empty.hidden = true;
  if (!q) { empty.textContent = "输入关键词再搜"; empty.hidden = false; return; }
  try {
    const data = await apiDirect("/api/diary/search?q=" + encodeURIComponent(q));
    const items = (data && data.items) || [];
    if (!items.length) { empty.textContent = "没找到，换个词试试"; empty.hidden = false; return; }
    items.forEach((it) => {
      const div = document.createElement("button");
      div.type = "button";
      div.className = "diary-result";
      const head = document.createElement("span");
      head.className = "diary-result-date";
      head.textContent = it.date;
      const body = document.createElement("span");
      body.className = "diary-result-text";
      body.textContent = diarySnippet(it.content, q);
      div.appendChild(head);
      div.appendChild(body);
      div.addEventListener("click", () => {
        diaryState.date = new Date(it.date + "T00:00:00");
        closeDiarySearch();
        loadDiary();
      });
      list.appendChild(div);
    });
  } catch (e) {
    empty.textContent = "搜索失败（离线？）";
    empty.hidden = false;
  }
}

/* ---------- 修行手册 ---------- */
function openManual() {
  document.querySelectorAll("section[id^='view-']").forEach((el) => { el.hidden = true; });
  $("nav").hidden = true;
  $("brandbar").hidden = true;
  $("view-manual").hidden = false;
}

function closeManual() {
  if (state.user) {
    try { localStorage.setItem(MANUAL_KEY, state.user.username); } catch (e) {}
  }
  $("view-manual").hidden = true;
  $("nav").hidden = false;
  $("brandbar").hidden = false;
  switchView("me");
}

loadTimerSound();

/* ---------- 视图切换 ---------- */
function restoredView() {
  const v = localStorage.getItem(VIEW_KEY);
  return ["home", "todo", "stats", "settings", "me"].includes(v) ? v : "home";
}

function switchView(view) {
  if (!state.user) return; // 未登录不可进入主视图
  state.view = view;
  try { localStorage.setItem(VIEW_KEY, view); } catch (e) {}
  document.querySelectorAll("#nav .nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("view-home").hidden = view !== "home";
  $("view-todo").hidden = view !== "todo";
  $("view-stats").hidden = view !== "stats";
  $("view-settings").hidden = view !== "settings";
  $("view-me").hidden = view !== "me";
  if (view === "stats") refreshStats();
  if (view === "home") refreshHome();
  if (view === "todo") refreshTodos();
  if (view === "me") refreshProfile();
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
    renderSeals(daily, weekly);
    $("naked-banner").hidden = !isNakedDay();
    $("freedom-banner").hidden = !isFreeMode();
    deepTimeReminder();
  } catch (e) { /* 离线时忽略 */ }
}

function renderSeals(daily, weekly) {
  const today = $("today-seal");
  if (today) {
    today.classList.toggle("done", !!daily.qualified);
    today.classList.toggle("empty", !daily.qualified);
  }
  const weekSeals = $("week-seals");
  if (!weekSeals || !weekly.days) return;
  weekSeals.innerHTML = "";
  const dowText = "日一二三四五六";
  const todayStr = daily.date || "";
  weekly.days.forEach((d) => {
    const isToday = d.date === todayStr;
    const wrap = document.createElement("div");
    wrap.className = "seal-wrap";
    const day = new Date(d.date + "T00:00:00");
    const sm = document.createElement("div");
    // 实印=今天（哪一天是今天哪一枚实印）；达标与否请看"今天"旁的大香字印章
    sm.className = "seal-sm " + (isToday ? "done" : "empty");
    sm.textContent = String(day.getDate());
    const dow = document.createElement("div");
    dow.className = "seal-dow";
    dow.textContent = isToday ? "今" : dowText[day.getDay()];
    wrap.appendChild(sm);
    wrap.appendChild(dow);
    weekSeals.appendChild(wrap);
  });
}

function enterRunning() {
  startSessionTimers();
  const s = state.session;
  $("home-idle").hidden = true;
  $("home-running").hidden = false;
  $("running-task").textContent = s.task_name || "专注中";
  $("running-hint").textContent = isFreeMode()
    ? "自由专注：不检测、不提醒，全靠你自己。分心了就点「分心」。"
    : isNakedDay()
      ? "今天是裸专注日：产品不检测、不提醒，全靠你自己。分心了就点「分心」。"
      : state.device === "phone"
        ? "离开页面会被记录并归因。"
        : "正常干活就行，页面切换不算分心。超过 3 分钟没动静会回来问你。";
  updateOfflineBadge();
  tick();
}

function leaveRunning() {
  stopSessionTimers();
  $("home-running").hidden = true;
  $("home-idle").hidden = false;
  hideOverlay("review");
  hideOverlay("attribution");
  hideOverlay("idle");
  hideOverlay("distract");
  hideOverlay("ritual");
  state.ritualBusy = false;
  state.distractLastMin = -1;
  state.distractSince = null;
}

function updateOfflineBadge() {
  const offline = getQueue().length > 0; // 只有真正有待同步数据才提示
  $("offline-badge").hidden = !offline || !state.session;
}

function tick() {
  const s = state.session;
  if (!s) return;
  const elapsed = Math.max(0, (Date.now() - sessionStartTime(s)) / 1000);
  updateIncense(elapsed);
  // 电脑端在岗检测：无操作超阈值 → 标记，回到页面时补问
  if (state.device === "desktop" && !state.idleFlag && !isFreeMode() && state.ritualStage < 2 && Date.now() - state.lastActivity > IDLE_MS) {
    state.idleFlag = true;
  }
}

function updateIncense(elapsedSec) {
  const ash = $("incense-ash"), tip = $("incense-tip"), smoke = $("incense-smoke");
  const burn = $("incense-burn"), fall = $("incense-fall"), heat = $("incense-heat");
  if (!ash || !tip || !burn) return;
  const s = state.session;
  const plannedSec = (s.planned_minutes || 15) * 60;
  const p = Math.min(1, Math.max(0, elapsedSec / plannedSec));
  const pct = Math.round(p * 100);
  const minutes = Math.floor(Math.min(elapsedSec, plannedSec) / 60); // 香尽后不再继续计时
  $("incense-time").textContent = `已燃 ${minutes} 分钟`;
  const done = p >= 1;
  if (done && !state.incenseReminded) {
    state.incenseReminded = true;
    notifyIncenseDone();
  }
  $("incense").classList.toggle("done", done);
  $("incense-done").hidden = !done;
  // 破功：香冻结在破功时刻（灰帽/燃点/烟不再推进），分钟照走
  if (state.incenseDistracted) return;
  // 未燃香身从底部锚定、顶部随进度逐寸消失；燃点/热区/烟/灰烬跟随香头顶端
  burn.style.height = (100 - pct) + "%";
  tip.style.top = pct + "%";
  if (heat) heat.style.top = pct + "%";
  // 烟雾 SVG 的底部路径锚在燃点上，整体向上伸展（152px 为 SVG 内香头到顶端的距离）
  smoke.style.top = "calc(" + pct + "% - 172px)";
  if (fall) fall.style.top = pct + "%";
  tip.style.opacity = done ? "0" : "1";
  if (fall) fall.style.opacity = done ? "0" : "1";
}

function markIncenseDistracted(v) {
  state.incenseDistracted = v;
  const el = $("incense");
  if (el) el.classList.toggle("distracted", v);
  if (!v && state.session) {
    updateIncense(Math.max(0, (Date.now() - sessionStartTime(state.session)) / 1000));
  }
}

/* ---------- 分心提醒（电脑端，页面卡片） ---------- */
function fmtDistractMinutes(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  return m < 1 ? "不到 1" : String(m);
}

async function pollDistract() {
  if (pollDistract._busy) return; // 防止轮询并发重叠
  pollDistract._busy = true;
  try {
    const s = state.session;
    if (!s || state.device !== "desktop" || isNakedDay() || isFreeMode() || state.ritualStage >= 2) return;
    let hit = null;
    try { hit = await apiDirect("/api/monitor/hit"); } catch (e) { return; }
    if (!hit || !hit.hit || !hit.since) {
      // 真切走/未命中：重置提醒档位（卡片保留，等用户回来确认；计时由后端重置）
      state.distractLastMin = -1;
      state.distractSince = null;
      state.distractNotified = false;
      if (!$("overlay-distract").hidden) $("distract-app").textContent = "已回到其他窗口";
      return;
    }
    const elapsed = Math.max(0, Date.now() / 1000 - hit.since);
    const min = Math.floor(elapsed / REMIND_SECONDS);
    // 显示本场累计命中时长（不随切走清零），提醒节奏按连续 2 分钟档位
    const minutesText = fmtDistractMinutes(hit.total || 0);
    const appName = hit.app || "分心应用";
    // 后端重新计时（since 变化）→ 视为新的连续段，重新允许提醒
    if (hit.since !== state.distractSince) {
      state.distractSince = hit.since;
      state.distractLastMin = -1;
      state.distractNotified = false;
    }
    // 命中持续超过阈值才发系统通知（避免手滑点开又关掉也打扰）
    if (!state.distractNotified && elapsed >= DISTRACT_NOTIFY_SECONDS) {
      state.distractNotified = true;
      notifyDistractHit(appName);
    }
    if (min > state.distractLastMin) {
      state.distractLastMin = min;
      $("distract-minutes").textContent = minutesText;
      $("distract-app").textContent = `正在使用：${appName}`;
      $("overlay-distract").hidden = false;
      maybeShowDistractNotifyGuide();
    } else if (!$("overlay-distract").hidden) {
      $("distract-minutes").textContent = minutesText; // 卡片已显示时实时更新分钟
    }
  } finally {
    pollDistract._busy = false;
  }
}
/* ---------- 手机归因 / 电脑补问 ---------- */
function handleVisibility() {
  const s = state.session;
  if (!s) return;
  if (document.hidden) {
    if (state.device === "phone" && !isNakedDay() && !isFreeMode() && state.ritualStage < 3) state.hiddenAt = Date.now();
  } else {
    if (state.device === "phone" && state.hiddenAt) {
      const dur = Math.round((Date.now() - state.hiddenAt) / 60000);
      state.hiddenAt = null;
      if (dur > 0 && !isNakedDay() && !isFreeMode() && state.ritualStage < 3) {
        if (state.ritualStage >= 2) {
          // L2 过渡期：自动记默认原因，不弹归因弹窗
          recordDistraction("phone_pickup", "刷手机", "", dur).then(() => startRitual());
        } else {
          showAttribution(dur);
        }
      }
    }
    if (state.device === "desktop" && state.idleFlag && !isNakedDay() && !isFreeMode() && state.ritualStage < 2) {
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

async function submitAttribution(reason) {
  clearInterval(state.attrTimer);
  hideOverlay("attribution");
  await recordDistraction("phone_pickup", reason, "", state.attrDuration);
  if (reason === "刷手机") startRitual();
  else toast("已记为" + reason);
}

function showIdleOverlay() {
  if (!state.session) return;
  if ($("overlay-attribution").hidden) $("overlay-idle").hidden = false;
}

/* ---------- 回神仪式 ---------- */
function startRitual() {
  markIncenseDistracted(true);
  // L3 预备毕业 / 裸专注日：静默记录，不弹仪式
  if (state.ritualStage >= 3 || isNakedDay() || isFreeMode()) {
    state.ritualBusy = false;
    return;
  }
  $("overlay-ritual").hidden = false;
  const count = state.ritualTodayCount || 0;
  $("ritual-count").textContent = `这是今天第 ${count} 次回来，每一次都是练习`;
  $("ritual-count").hidden = false;
  const showReasons = state.ritualStage === 1;
  $("ritual-reasons").hidden = !showReasons;
  $("ritual-advice").hidden = true;
  if (showReasons) document.querySelectorAll(".ritual-reason").forEach((b) => b.classList.remove("selected"));
}

function finishRitual() {
  hideOverlay("ritual");
  toast("好，继续");
  state.ritualBusy = false;
  markIncenseDistracted(false);
  refreshHome();
}

function pickRitualReason(btn) {
  document.querySelectorAll(".ritual-reason").forEach((b) => b.classList.toggle("selected", b === btn));
  const advice = { tired: "去接杯水，再回来", annoyed: "先做最简单的 5 分钟", zoned: "好，直接继续" }[btn.dataset.reason] || "";
  $("ritual-advice").textContent = advice;
  $("ritual-advice").hidden = !advice;
}

/* ---------- 质量自评 ---------- */
function showReview() {
  state.reviewCompletion = 60;
  state.reviewFlow = 3;
  state.reviewReliance = "self";
  $("completion-slider").value = 60;
  $("completion-label").textContent = "60";
  document.querySelectorAll(".flow-btn").forEach((b) => b.classList.toggle("selected", +b.dataset.v === 3));
  document.querySelectorAll("#reliance-picker .reliance-btn").forEach((b) => b.classList.toggle("selected", b.dataset.v === "self"));
  $("review-reflect").value = "";
  $("review-reflect-row").hidden = !(state.sessionDistractions > 0); // 本场有分心才问
  $("overlay-review").hidden = false;
}

/* ---------- 放弃复盘 ---------- */
function showReflect() {
  $("reflect-input").value = "";
  document.querySelectorAll("#overlay-reflect .reflect-chips .chip").forEach((b) => b.classList.remove("active"));
  $("overlay-reflect").hidden = false;
}

/* ---------- 头像上传（圆形裁剪） ---------- */
const avatarState = { img: null, zoom: 1, dx: 0, dy: 0 };

function onAvatarFile(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (!f.type.startsWith("image/")) { toast("请选择图片文件"); return; }
  if (f.size > 5 * 1024 * 1024) { toast("图片不能超过 5MB"); return; }
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    avatarState.img = img;
    avatarState.zoom = 1;
    avatarState.dx = 0;
    avatarState.dy = 0;
    $("crop-zoom").value = "1";
    $("crop-zoom-label").textContent = "1.0";
    $("overlay-avatar").hidden = false;
    drawCrop();
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast("图片读取失败"); };
  img.src = url;
}

function drawCrop() {
  const cv = $("crop-canvas");
  const size = cv.width;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  const img = avatarState.img;
  if (!img) return;
  const base = size / Math.min(img.naturalWidth, img.naturalHeight);
  const s = base * avatarState.zoom;
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  const maxDx = Math.max(0, (w - size) / 2);
  const maxDy = Math.max(0, (h - size) / 2);
  avatarState.dx = Math.min(maxDx, Math.max(-maxDx, avatarState.dx));
  avatarState.dy = Math.min(maxDy, Math.max(-maxDy, avatarState.dy));
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, size / 2 - w / 2 + avatarState.dx, size / 2 - h / 2 + avatarState.dy, w, h);
  ctx.restore();
}

function initCropDrag() {
  const stage = $("crop-stage");
  let dragging = false, lastX = 0, lastY = 0;
  stage.addEventListener("pointerdown", (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
  });
  stage.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    avatarState.dx += e.clientX - lastX;
    avatarState.dy += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    drawCrop();
  });
  stage.addEventListener("pointerup", () => { dragging = false; });
  stage.addEventListener("pointercancel", () => { dragging = false; });
}

function confirmAvatarCrop() {
  const img = avatarState.img;
  if (!img) return;
  const out = document.createElement("canvas");
  out.width = out.height = 256;
  const ctx = out.getContext("2d");
  const k = 256 / 260;
  const base = 260 / Math.min(img.naturalWidth, img.naturalHeight);
  const s = base * avatarState.zoom * k;
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  ctx.save();
  ctx.beginPath();
  ctx.arc(128, 128, 128, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, 128 - w / 2 + avatarState.dx * k, 128 - h / 2 + avatarState.dy * k, w, h);
  ctx.restore();
  const ok = $("btn-crop-ok");
  ok.disabled = true;
  out.toBlob(async (blob) => {
    try {
      if (!blob) throw new Error("图片生成失败");
      const fd = new FormData();
      fd.append("file", blob, "avatar.png");
      const res = await fetch("/api/auth/me/avatar", { method: "POST", headers: { Authorization: "Bearer " + getToken() }, body: fd });
      if (!res.ok) {
        let detail = "上传失败";
        try { const j = await res.json(); if (j && j.detail) detail = j.detail; } catch (err) {}
        throw new Error(detail);
      }
      const data = await res.json();
      $("overlay-avatar").hidden = true;
      showAvatar(data.url);
      toast("头像已更新");
    } catch (e) {
      toast(e.message);
    } finally {
      ok.disabled = false;
    }
  }, "image/png");
}

function showAvatar(url) {
  const img = $("avatar-img");
  img.onload = () => { img.hidden = false; $("profile-seal").hidden = true; };
  img.onerror = () => { img.hidden = true; $("profile-seal").hidden = false; };
  img.src = url + "?v=" + Date.now();
}

function loadAvatar() {
  if (!state.user) return;
  showAvatar("/avatars/" + state.user.id + ".png");
}

/* ---------- 个人中心 ---------- */
/* ---------- 个人中心 ---------- */
async function refreshProfile() {
  let me, summary;
  try {
    [me, summary] = await Promise.all([apiDirect("/api/auth/me"), apiDirect("/api/auth/summary")]);
  } catch (e) { toast("个人中心加载失败（离线？）"); return; }
  state.user = me;
  const first = (me.nickname || me.username || "香").trim().charAt(0) || "香";
  $("profile-seal").textContent = first;
  $("profile-nickname").textContent = me.nickname || me.username;
  $("profile-username").textContent = "@" + me.username;
  $("profile-joined").textContent = me.created_at ? "注册于 " + me.created_at.slice(0, 10) : "";
  $("profile-nick-input").value = me.nickname || "";
  $("pf-focus").textContent = summary.total_focus_minutes;
  $("pf-completed").textContent = summary.total_completed;
  $("pf-distractions").textContent = summary.total_distractions;
  $("pf-qualified").textContent = summary.qualified_days;
  $("pf-selfrate").textContent = (summary.self_rate === null || summary.self_rate === undefined) ? "—" : Math.round(summary.self_rate * 100) + "%";
  loadAvatar();
  renderGraduationArchive();
}

async function renderGraduationArchive() {
  const panel = $("graduation-panel");
  if (!panel) return;
  try {
    const g = await apiDirect("/api/settings/graduation");
    const rate = Math.round((g.rate_28d || 0) * 100) + "%";
    const self = g.self_rate_28d === null || g.self_rate_28d === undefined ? "—" : Math.round(g.self_rate_28d * 100) + "%";
    const stageMap = { "受训期": "入门", "过渡期": "渐悟", "预备毕业": "自在" };
    const stages = g.stages && g.stages.length ? g.stages.map(s => stageMap[s] || s).join(" → ") : "—";
    if (g.graduated_at) {
      $("grad-archive").textContent = `已毕业（${g.graduated_at}）· 阶段：${stages} · 靠自己 ${self}`;
      $("btn-retrain").hidden = false;
    } else {
      $("grad-archive").textContent = `近 4 周达标 ${rate} · 靠自己 ${self} · 阶段：${stages}`;
      $("btn-retrain").hidden = true;
    }
    panel.hidden = false;
  } catch (e) { /* 离线忽略 */ }
}

/* ---------- 统计 ---------- */
async function refreshStats() {
  let daily, weekly, insights, next;
  try {
    [daily, weekly, insights] = await Promise.all([
      apiDirect("/api/stats/daily"), apiDirect("/api/stats/weekly"),
      apiDirect("/api/stats/insights"),
    ]);
  } catch (e) { toast("统计加载失败（离线？）"); return; }

  const prevDays = weekly.prev_week_days || [];
  const weekTotal = weekly.days.reduce((a, d) => a + (d.focus_minutes || 0), 0);
  const prevTotal = prevDays.reduce((a, d) => a + (d.focus_minutes || 0), 0);
  const maxMin = Math.max(1, ...weekly.days.map((d) => d.focus_minutes), ...prevDays.map((d) => d.focus_minutes));
  const chart = $("week-chart");
  chart.innerHTML = "";
  weekly.days.forEach((d, i) => {
    const col = document.createElement("div");
    col.className = "day-col";
    const prevBar = document.createElement("div");
    prevBar.className = "day-bar prev";
    prevBar.style.height = `${Math.max(6, ((prevDays[i] && prevDays[i].focus_minutes) || 0) / maxMin * 100)}px`;
    const curBar = document.createElement("div");
    curBar.className = "day-bar" + (d.qualified ? " filled qualified" : "");
    curBar.style.height = `${Math.max(6, (d.focus_minutes / maxMin) * 100)}px`;
    const label = document.createElement("div");
    label.className = "d";
    label.textContent = new Date(d.date + "T00:00:00").getDate() + (d.qualified ? "✓" : "");
    col.appendChild(prevBar);
    col.appendChild(curBar);
    col.appendChild(label);
    chart.appendChild(col);
  });
  const pct = prevTotal > 0 ? Math.round(((weekTotal - prevTotal) / prevTotal) * 100) : null;
  $("week-trend").textContent = `本周专注 ${weekTotal} 分钟` + (pct === null ? "" : ` · 较上周 ${pct >= 0 ? "+" : ""}${pct}%`);
  $("week-rate").textContent = Math.round(weekly.completion_rate * 100) + "%";
  $("week-streak").textContent = weekly.streak;

  const grad = weekly.graduation || { rate_28d: 0, self_rate_28d: null, eligible: false };
  const gradRate = Math.round((grad.rate_28d || 0) * 100) + "%";
  const gradSelf = grad.self_rate_28d === null || grad.self_rate_28d === undefined ? "—" : Math.round(grad.self_rate_28d * 100) + "%";
  $("scroll-text").textContent = `近 4 周达标 ${gradRate} · 靠自己 ${gradSelf}`;
  const progRate = (grad.rate_28d || 0) / 0.6;
  const progSelf = grad.self_rate_28d === null || grad.self_rate_28d === undefined ? 1 : grad.self_rate_28d / 0.5;
  $("scroll-fill").style.width = `${Math.max(0, Math.min(1, progRate, progSelf)) * 100}%`;
  const sr = weekly.self_rate;
  $("self-rate").textContent = sr === null || sr === undefined ? "—" : Math.round(sr * 100) + "%";

  // 今天建议专注分钟 = 最近 7 天完成场次实际时长平均值（就近取 5，范围 5~180）
  const totalMin = weekly.days.reduce((a, d) => a + (d.focus_minutes || 0), 0);
  const totalSessions = weekly.days.reduce((a, d) => a + (d.completed_sessions || 0), 0);
  let suggest = null;
  if (totalSessions > 0) {
    suggest = Math.min(180, Math.max(5, Math.round((totalMin / totalSessions) / 5) * 5));
  }
  $("suggest-target").textContent = suggest || "—";

  if (insights.total_distractions > 0) {
    const worst = insights.worst_hours.map((h) => `${h.hour} 点(${h.count}次)`).join("、");
    $("insight-text").textContent = `最近最常分心的时段：${worst}`;
    $("insight-detail").textContent = `离开页面 ${insights.phone_pickups} 次，自动检测到分心 ${insights.auto_detected} 次，共 ${insights.total_distractions} 次分心。`;
  } else {
    $("insight-text").textContent = "数据不足，先用起来。";
    $("insight-detail").textContent = "";
  }
}

function renderReflections(data) {
  const groups = $("reflect-groups");
  const empty = $("reflect-empty");
  const summary = $("reflect-summary");
  if (!groups || !empty || !summary) return;
  const items = (data && data.items) || [];
  groups.innerHTML = "";
  if (!items.length) {
    summary.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  const s = (data && data.summary) || {};
  if (s.last7d_count > 0) {
    summary.textContent = `最近 7 天 · ${s.last7d_count} 次复盘` + (s.top_reason ? ` · 最常写「${s.top_reason.text}」` : "");
    summary.hidden = false;
  } else {
    summary.hidden = true;
  }
  // 按自然周（周一起）分组
  const weekMap = new Map();
  items.forEach((it) => {
    const d = new Date(it.date + "T00:00:00");
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const key = monday.getFullYear() + "-" + String(monday.getMonth() + 1).padStart(2, "0") + "-" + String(monday.getDate()).padStart(2, "0");
    if (!weekMap.has(key)) weekMap.set(key, []);
    weekMap.get(key).push(it);
  });
  const keys = [...weekMap.keys()];
  keys.forEach((key, i) => {
    const list = weekMap.get(key);
    const group = document.createElement("div");
    group.className = "reflect-group";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "reflect-group-head";
    const m = new Date(key + "T00:00:00");
    const title = document.createElement("span");
    const weekEnd = new Date(m);
    weekEnd.setDate(weekEnd.getDate() + 6);
    title.textContent = `${m.getMonth() + 1}/${m.getDate()} – ${weekEnd.getMonth() + 1}/${weekEnd.getDate()}`;
    const count = document.createElement("span");
    count.className = "reflect-count";
    count.textContent = list.length + " 条";
    head.appendChild(title);
    head.appendChild(count);
    const body = document.createElement("div");
    body.className = "reflect-group-body";
    body.hidden = i !== 0; // 默认只展开最近一周
    head.classList.toggle("collapsed", body.hidden);
    list.forEach((it) => {
      const div = document.createElement("div");
      div.className = "reflection-item";
      const itemHead = document.createElement("div");
      itemHead.className = "reflection-head";
      const t = document.createElement("span");
      t.textContent = it.date.slice(5) + " · " + it.task_name;
      itemHead.appendChild(t);
      if (it.status === "abandoned") {
        const badge = document.createElement("span");
        badge.className = "reflection-badge";
        badge.textContent = "放弃";
        itemHead.appendChild(badge);
      } else if (it.distracted) {
        const badge = document.createElement("span");
        badge.className = "reflection-badge";
        badge.textContent = "分心";
        itemHead.appendChild(badge);
      }
      const bodyText = document.createElement("div");
      bodyText.textContent = "「" + it.reflection + "」";
      div.appendChild(itemHead);
      div.appendChild(bodyText);
      body.appendChild(div);
    });
    head.addEventListener("click", () => {
      body.hidden = !body.hidden;
      head.classList.toggle("collapsed", body.hidden);
    });
    group.appendChild(head);
    group.appendChild(body);
    groups.appendChild(group);
  });
}

/* ---------- 黑名单列表 ---------- */
function renderBlacklist(list) {
  state.blacklist = list || [];
  const wrap = $("blacklist-list");
  wrap.innerHTML = "";
  $("blacklist-empty").hidden = state.blacklist.length > 0;
  state.blacklist.forEach((item) => {
    const row = document.createElement("div");
    row.className = "blacklist-item";
    const text = document.createElement("span");
    text.className = "blacklist-key";
    text.textContent = item;
    const del = document.createElement("button");
    del.className = "btn btn-ghost btn-sm";
    del.textContent = "删除进程";
    del.addEventListener("click", () => {
      state.blacklist = state.blacklist.filter((x) => x !== item);
      renderBlacklist(state.blacklist);
      saveBlacklist();
    });
    row.appendChild(text);
    row.appendChild(del);
    wrap.appendChild(row);
  });
}

function saveBlacklist() {
  const body = { blacklist: state.blacklist || [] };
  apiWriteQueue("/api/settings", "PUT", body, { type: "raw", path: "/api/settings", method: "PUT", body }).then((res) => {
    if (res) state.settings = res;
  });
}

function addBlacklistItem() {
  const input = $("blacklist-input");
  const v = input.value.trim();
  if (!v) { toast("先输入关键词"); return; }
  input.value = "";
  if (!state.blacklist.includes(v)) state.blacklist = [...state.blacklist, v];
  renderBlacklist(state.blacklist);
  saveBlacklist();
}

/* ---------- 设置 ---------- */
/* 设置读取：localStorage 优先（老用户迁移兜底），其次后端设置，最后默认值 */
function localOrSetting(backendKey, lsKey, fallback) {
  const ls = localStorage.getItem(lsKey);
  if (ls === "0" || ls === "1") return ls === "1";
  if (state.settings && state.settings[backendKey] !== undefined) return !!state.settings[backendKey];
  return fallback;
}

function themeFromSettings() {
  const ls = localStorage.getItem(FD_THEME_KEY);
  if (ls === "light" || ls === "dark") return ls;
  return (state.settings && state.settings.theme) || "light";
}

function saveSettingPartial(patch) {
  apiWriteQueue("/api/settings", "PUT", patch, { type: "raw", path: "/api/settings", method: "PUT", body: patch })
    .then((res) => { if (res) state.settings = res; });
}

function applySettingsToForm() {
  const s = state.settings;
  if (!s) return;
  $("blacklist-input").value = "";
  renderBlacklist(s.blacklist || []);
  $("deep-start").value = s.deep_start || "09:00";
  $("deep-end").value = s.deep_end || "11:00";
  $("deep-start-btn").textContent = $("deep-start").value;
  $("deep-end-btn").textContent = $("deep-end").value;
  $("reminder-enabled").checked = !!s.reminder_enabled;
  $("naked-day").value = String(s.naked_day || 0);
}

/* ---------- 数据导出 / 导入（阶段 1） ---------- */
async function exportData() {
  try {
    const res = await apiDirect("/api/data/export");
    if (!res || !res.data) throw new Error("导出失败");
    const blob = new Blob([JSON.stringify(res, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `篆香数据备份-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("已导出数据备份");
  } catch (e) {
    toast(e.message || "导出失败");
  }
}

function importData() {
  showConfirm("导入将合并备份数据：日记与设置以备份为准，待办重复项跳过。确定继续？", () => {
    $("import-file").click();
  }, { seal: "导", title: "导入数据", okText: "导入" });
}

async function handleImportFile(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (payload.schema_version !== 1) throw new Error("备份文件版本不兼容");
    const res = await apiDirect("/api/data/import", "POST", payload);
    const n = (res && res.imported) || {};
    const extra = res && res.skipped ? `，跳过 ${res.skipped} 条重复` : "";
    toast(`导入完成：专注 ${n.sessions || 0} 场、待办 ${n.todos || 0} 条、日记 ${n.diaries || 0} 篇${extra}`);
    setTimeout(() => location.reload(), 900); // 刷新后自动回到当前页
  } catch (err) {
    toast(err.message || "导入失败，请检查文件格式");
  }
}

async function saveSettings() {
  const body = {
    blacklist: state.blacklist || [],
    deep_start: $("deep-start").value,
    deep_end: $("deep-end").value,
    reminder_enabled: $("reminder-enabled").checked,
    naked_day: parseInt($("naked-day").value, 10) || null,
  };
  const res = await apiWriteQueue("/api/settings", "PUT", body, { type: "raw", path: "/api/settings", method: "PUT", body });
  if (res) state.settings = res;
  toast("设置已保存");
}

/* ---------- 云同步（阶段 4） ---------- */
async function loadSyncStatus() {
  try {
    const s = await apiDirect("/api/sync/status");
    state.cloudBound = !!(s && s.bound);
    if (!s || !s.bound) {
      $("sync-unbound").hidden = false;
      $("sync-bound").hidden = true;
      return;
    }
    $("sync-unbound").hidden = true;
    $("sync-bound").hidden = false;
    $("sync-username-label").textContent = s.username;
    $("sync-status-text").textContent = s.last_sync_at
      ? `最近同步：${new Date(s.last_sync_at).toLocaleString()}`
      : "尚未同步";
  } catch (e) {
    state.cloudBound = false;
  }
}

async function bindSync() {
  const url = $("sync-url").value.trim();
  const username = $("sync-username").value.trim();
  const password = $("sync-password").value;
  if (!url || !username || !password) { toast("请填写云端地址、账号和密码"); return; }
  try {
    const res = await apiDirect("/api/sync/bind", "POST", { url, username, password });
    toast(res && res.sync && res.sync.synced ? "云同步已启用，数据已同步" : "已绑定，但本轮同步未完成");
    $("sync-password").value = "";
    await loadSyncStatus();
  } catch (e) {
    toast(e.message || "绑定失败");
  }
}

async function syncNow(manual = true) {
  try {
    const res = await apiDirect("/api/sync/now", "POST");
    if (manual) {
      if (res && res.synced) toast(`已同步：推送 ${res.pushed} 条、拉取 ${res.pulled} 条`);
      else toast((res && res.reason) || "同步未完成");
      await loadSyncStatus();
    }
  } catch (e) { if (manual) toast(e.message || "同步失败"); }
}

function silentSync() { syncNow(false); }  // 后台静默同步：失败不打扰

function unbindSync() {
  showConfirm("解绑后本机数据不再同步到云端，确定？", async () => {
    try { await apiDirect("/api/sync/unbind", "POST"); toast("已解绑"); await loadSyncStatus(); } catch (e) { toast(e.message); }
  }, { seal: "解", title: "解除云同步", okText: "解绑" });
}

function exitApp() {
  showConfirm("退出后需要重新启动应用。确定退出？", async () => {
    try { await apiDirect("/api/system/shutdown", "POST"); } catch (e) { toast(e.message); }
    setTimeout(() => { try { window.close(); } catch (_) {} }, 300);
  }, { seal: "止", title: "退出应用", okText: "退出" });
}

/* ---------- 深度时段提醒 ---------- */
function deepTimeReminder() {
  const s = state.settings;
  if (!s || !s.reminder_enabled || state.session) return;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = parseTime(s.deep_start);
  const end = parseTime(s.deep_end);
  if (cur >= start && cur <= end) toast("现在是静修时段，该开始今天的专注了");
}
function parseTime(t) {
  const [h, m] = (t || "09:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/* ---------- 昼夜主题 ---------- */
function currentTheme() {
  if (document.documentElement.dataset.theme) return document.documentElement.dataset.theme;
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
  return "light";
}
function initTheme() {
  document.documentElement.dataset.theme = themeFromSettings();
  updateThemeButton();
}
function updateThemeButton() {
  $("btn-theme").textContent = currentTheme() === "dark" ? "昼" : "夜";
}
function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(FD_THEME_KEY, next);
  saveSettingPartial({ theme: next });
  updateThemeButton();
}

/* ---------- 事件绑定 ---------- */
function hideOverlay(id) { $(`overlay-${id}`).hidden = true; }

/* 页面内确认浮层，替代浏览器 confirm() */
function showConfirm(message, onOk, opts = {}) {
  const { seal = "删", title = "确认删除", okText = "删除" } = opts;
  $("confirm-seal").textContent = seal;
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("btn-confirm-ok").textContent = okText;
  $("overlay-confirm").hidden = false;
  const okBtn = $("btn-confirm-ok");
  const cancelBtn = $("btn-confirm-cancel");
  const cleanup = () => {
    okBtn.removeEventListener("click", handleOk);
    cancelBtn.removeEventListener("click", handleCancel);
  };
  const handleOk = () => { cleanup(); hideOverlay("confirm"); onOk(); };
  const handleCancel = () => { cleanup(); hideOverlay("confirm"); };
  okBtn.addEventListener("click", handleOk);
  cancelBtn.addEventListener("click", handleCancel);
}

function bindEvents() {
  document.querySelectorAll("#nav .nav-btn").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

  $("btn-theme").addEventListener("click", toggleTheme);
  $("btn-logout").addEventListener("click", () => {
    showConfirm("确定要退出登录吗？", logout, { seal: "退", title: "确认退出", okText: "退出" });
  });
  $("btn-toggle-account").addEventListener("click", () => {
    const show = $("account-panel").hidden;
    $("account-panel").hidden = !show;
    $("btn-toggle-account").textContent = show ? "收起账号管理" : "账号管理";
  });
  $("btn-save-nick").addEventListener("click", async () => {
    const nickname = $("profile-nick-input").value.trim();
    $("profile-msg").textContent = "";
    if (!nickname) { $("profile-msg").textContent = "昵称不能为空"; return; }
    try {
      const me = await apiDirect("/api/auth/me", "PATCH", { nickname });
      state.user = me;
      refreshProfile();
    } catch (e) { $("profile-msg").textContent = e.message; }
  });
  $("btn-change-pw").addEventListener("click", async () => {
    const oldPw = $("pw-old").value, newPw = $("pw-new").value, newPw2 = $("pw-new2").value;
    $("profile-msg").textContent = "";
    if (!oldPw || !newPw) { $("profile-msg").textContent = "旧密码和新密码都要填"; return; }
    if (newPw.length < 6) { $("profile-msg").textContent = "新密码至少 6 位"; return; }
    if (newPw !== newPw2) { $("profile-msg").textContent = "两次新密码不一致"; return; }
    try {
      await apiDirect("/api/auth/password", "POST", { old_password: oldPw, new_password: newPw });
      clearToken();
      showAuth();
      toast("密码已修改，请用新密码重新登录");
    } catch (e) { $("profile-msg").textContent = e.message; }
  });
  $("btn-toggle-security").addEventListener("click", () => {
    const show = $("security-body").hidden;
    $("security-body").hidden = !show;
    $("btn-toggle-security").textContent = show ? "收起安全问题" : "安全问题（忘记密码用）";
  });
  $("btn-save-security").addEventListener("click", saveSecurity);
  $("btn-auth-forgot").addEventListener("click", openResetOverlay);
  $("btn-reset-next").addEventListener("click", resetNext);
  $("btn-reset-ok").addEventListener("click", resetOk);
  $("btn-reset-cancel").addEventListener("click", cancelReset);
  $("btn-toggle-pw").addEventListener("click", () => {
    const body = $("pw-change-body");
    body.hidden = !body.hidden;
    $("btn-toggle-pw").textContent = body.hidden ? "修改密码" : "收起";
  });
  document.querySelectorAll(".auth-tab").forEach((b) => b.addEventListener("click", () => setAuthMode(b.dataset.mode)));
  $("btn-auth-submit").addEventListener("click", submitAuth);
  ["auth-username", "auth-password", "auth-nickname", "auth-password2"].forEach((id) =>
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); }));
  // 密码可见切换
  const eyeOpen = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const eyeClosed = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
  document.querySelectorAll(".auth-pw-toggle").forEach((btn) => {
    btn.innerHTML = eyeOpen;
    btn.addEventListener("click", () => {
      const input = $(btn.dataset.target);
      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      btn.innerHTML = isPassword ? eyeClosed : eyeOpen;
    });
  });

  $("btn-start").addEventListener("click", () => {
    const m = homeMinutes();
    const task = $("task-input").value.trim() || "未命名任务";
    startSession(task, m);
  });
  $("btn-cancel-start").addEventListener("click", () => hideOverlay("startup"));
  $("btn-confirm-start").addEventListener("click", () => {
    const task = $("startup-task").value.trim() || "未命名任务";
    const minutes = state.pendingMinutes || parseInt($("startup-slider").value, 10);
    hideOverlay("startup");
    startSession(task, minutes);
  });
  ["minutes-slider", "startup-slider"].forEach((id) => {
    $(id).addEventListener("input", (e) => {
      const target = id === "minutes-slider" ? "minutes-label" : "startup-minutes";
      $(target).textContent = e.target.value;
      if (id === "minutes-slider") $("minutes-input").value = e.target.value;
      else state.pendingMinutes = parseInt(e.target.value, 10);
    });
  });

  document.querySelectorAll(".todo-collapse").forEach((btn) => btn.addEventListener("click", () => {
    const body = $(btn.dataset.target);
    body.hidden = !body.hidden;
    btn.classList.toggle("collapsed", body.hidden);
  }));
  $("btn-todo-add").addEventListener("click", () => addTodo(false));
  $("todo-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(false); });
  $("btn-todo-daily-add").addEventListener("click", () => addTodo(true));
  $("todo-daily-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(true); });
  $("todo-minutes-slider").addEventListener("input", (e) => { $("todo-minutes-label").textContent = e.target.value; $("todo-minutes-input").value = e.target.value; });
  $("todo-list").addEventListener("click", onTodoListClick);
  $("todo-daily-list").addEventListener("click", onTodoListClick);

  $("btn-toggle-tools").addEventListener("click", toggleTools);
  $("btn-toggle-manual").addEventListener("click", openManual);
  $("btn-manual-back").addEventListener("click", closeManual);
  $("btn-manual-done").addEventListener("click", closeManual);
  $("btn-toggle-reflect").addEventListener("click", toggleReflect);
  $("btn-timer-start").addEventListener("click", startTimer);
  $("btn-timer-reset").addEventListener("click", resetTimer);
  $("btn-timer-stop").addEventListener("click", stopTimer);
  document.querySelectorAll("#timer-chips .chip").forEach((b) => b.addEventListener("click", () => pickTimerChip(b)));
  $("timer-custom").addEventListener("input", onTimerCustom);
  $("timer-sound").addEventListener("change", (e) => {
    localStorage.setItem(TIMER_SOUND_KEY, e.target.checked ? "1" : "0");
    saveSettingPartial({ timer_sound: e.target.checked });
  });
  $("reminder-sound").addEventListener("change", (e) => {
    localStorage.setItem(REMIND_SOUND_KEY, e.target.checked ? "1" : "0");
    saveSettingPartial({ remind_sound: e.target.checked });
  });
  $("reminder-notify").addEventListener("change", (e) => {
    localStorage.setItem(REMIND_NOTIFY_KEY, e.target.checked ? "1" : "0");
    saveSettingPartial({ remind_notify: e.target.checked });
  });
  $("reminder-notify-distract").addEventListener("change", (e) => {
    localStorage.setItem(REMIND_NOTIFY_DISTRACT_KEY, e.target.checked ? "1" : "0");
    saveSettingPartial({ remind_notify_distract: e.target.checked });
  });
  $("btn-distract-notify-on").addEventListener("click", () => {
    localStorage.setItem(REMIND_NOTIFY_DISTRACT_KEY, "1");
    localStorage.setItem(DISTRACT_NOTIFY_GUIDED_KEY, "1");
    $("reminder-notify-distract").checked = true;
    $("distract-notify-guide").hidden = true;
    saveSettingPartial({ remind_notify_distract: true });
    toast("已开启：分心时将发送系统通知");
  });
  $("tool-card-timer").addEventListener("click", openTimerTool);
  $("tool-card-diary").addEventListener("click", openDiaryTool);
  $("btn-timer-back").addEventListener("click", closeTimerTool);
  $("btn-diary-back").addEventListener("click", closeDiaryTool);
  $("btn-diary-prev").addEventListener("click", () => shiftDiaryDate(-1));
  $("btn-diary-next").addEventListener("click", () => shiftDiaryDate(1));
  $("diary-date-label").addEventListener("click", openDiaryCal);
  $("btn-cal-prev").addEventListener("click", () => { diaryState.calMonth.setMonth(diaryState.calMonth.getMonth() - 1); renderDiaryCal(); });
  $("btn-cal-next").addEventListener("click", () => { diaryState.calMonth.setMonth(diaryState.calMonth.getMonth() + 1); renderDiaryCal(); });
  $("btn-cal-today").addEventListener("click", () => { goDiaryToday(); closeDiaryCal(); });
  $("btn-cal-close").addEventListener("click", closeDiaryCal);
  $("btn-diary-today").addEventListener("click", goDiaryToday);
  $("btn-diary-search").addEventListener("click", openDiarySearch);
  $("btn-diary-search-go").addEventListener("click", doDiarySearch);
  $("diary-search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") doDiarySearch(); });
  $("btn-diary-search-cancel").addEventListener("click", closeDiarySearch);
  $("deep-start-btn").addEventListener("click", () => openTimePicker("deep-start"));
  $("deep-end-btn").addEventListener("click", () => openTimePicker("deep-end"));
  $("btn-tp-ok").addEventListener("click", confirmTimePicker);
  $("btn-tp-cancel").addEventListener("click", cancelTimePicker);
  $("btn-diary-save").addEventListener("click", () => saveDiary(true));
  $("diary-input").addEventListener("input", () => {
    clearTimeout(diaryState.timer);
    diaryState.timer = setTimeout(saveDiary, 1500); // 停顿 1.5s 自动保存
  });
  $("minutes-input").addEventListener("input", syncHomeMinutes);
  $("todo-minutes-input").addEventListener("input", onTodoMinutesInput);
  $("btn-blacklist-add").addEventListener("click", addBlacklistItem);
  $("blacklist-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addBlacklistItem(); });
  $("avatar-btn").addEventListener("click", () => $("avatar-file").click());
  $("avatar-file").addEventListener("change", onAvatarFile);
  $("crop-zoom").addEventListener("input", (e) => {
    avatarState.zoom = parseFloat(e.target.value) || 1;
    $("crop-zoom-label").textContent = avatarState.zoom.toFixed(1);
    drawCrop();
  });
  $("btn-crop-ok").addEventListener("click", confirmAvatarCrop);
  $("btn-crop-cancel").addEventListener("click", () => { $("overlay-avatar").hidden = true; avatarState.img = null; });
  initCropDrag();

  $("btn-complete").addEventListener("click", showReview);
  $("btn-abandon").addEventListener("click", () => {
    showConfirm("确定放弃这场专注？", () => showReflect(), { seal: "弃", title: "确认放弃", okText: "放弃" });
  });
  $("btn-distract").addEventListener("click", async () => {
    if (state.ritualBusy) return; // 仪式进行中不重复触发
    state.ritualBusy = true;
    await recordDistraction("manual", "走神", "", 0);
    startRitual();
  });
  $("btn-distract-back").addEventListener("click", () => {
    hideOverlay("distract");
    // 本连续段内不再提醒；真正切走重计时（since 变化）后才重新可弹
    state.distractLastMin = Infinity;
    startRitual();
  });
  $("btn-distract-quit").addEventListener("click", () => {
    showConfirm("确定结束这场专注？", () => {
      hideOverlay("distract");
      state.distractLastMin = -1;
      showReflect();
    });
  });
  document.querySelectorAll(".ritual-reason").forEach((b) => b.addEventListener("click", () => pickRitualReason(b)));
  $("btn-ritual-done").addEventListener("click", finishRitual);
  $("btn-grad-claim").addEventListener("click", async () => {
    try { await apiDirect("/api/settings/graduation/claim", "POST"); } catch (e) {}
    state.graduated = true;
    hideOverlay("graduation");
    toast("恭喜毕业，已进入自由专注模式");
    refreshHome();
    refreshProfile();
  });
  $("btn-retrain").addEventListener("click", async () => {
    showConfirm("确定重新训练？毕业记录会清空，档位回到入门。", async () => {
      try { await apiDirect("/api/settings/graduation/retrain", "POST"); } catch (e) {}
      state.graduated = false;
      toast("重新训练开始");
      refreshProfile();
    });
  });

  $("completion-slider").addEventListener("input", (e) => {
    state.reviewCompletion = +e.target.value;
    $("completion-label").textContent = e.target.value;
  });
  document.querySelectorAll(".flow-btn").forEach((b) => b.addEventListener("click", () => {
    state.reviewFlow = +b.dataset.v;
    document.querySelectorAll(".flow-btn").forEach((x) => x.classList.toggle("selected", x === b));
  }));
  document.querySelectorAll("#reliance-picker .reliance-btn").forEach((b) => b.addEventListener("click", () => {
    state.reviewReliance = b.dataset.v;
    document.querySelectorAll("#reliance-picker .reliance-btn").forEach((x) => x.classList.toggle("selected", x === b));
  }));
  $("btn-submit-review").addEventListener("click", () => endSession("complete"));
  document.querySelectorAll("#review-reflect-row .reflect-chips .chip, #overlay-reflect .reflect-chips .chip").forEach((b) => b.addEventListener("click", () => {
    const input = b.closest("#review-reflect-row") ? $("review-reflect") : $("reflect-input");
    input.value = b.dataset.text;
  }));
  $("btn-reflect-save").addEventListener("click", () => { hideOverlay("reflect"); endSession("abandon"); });
  $("btn-reflect-skip").addEventListener("click", () => { hideOverlay("reflect"); endSession("abandon"); });

  document.querySelectorAll("#overlay-attribution .btn").forEach((b) =>
    b.addEventListener("click", () => submitAttribution(b.dataset.reason)));
  document.querySelectorAll("#overlay-idle .btn").forEach((b) => b.addEventListener("click", async () => {
    hideOverlay("idle");
    resetIdle();
    if (b.dataset.idle === "distracted") {
      await recordDistraction("manual", "走神", "", 0);
      startRitual();
    } else {
      toast("好，继续");
    }
  }));
  const idleLaterBtn = $("btn-idle-later");
  if (idleLaterBtn) idleLaterBtn.addEventListener("click", () => {
    hideOverlay("idle");
    resetIdle();
    toast("好，等会儿再问");
  });

  $("btn-save-settings").addEventListener("click", saveSettings);
  $("btn-export-data").addEventListener("click", exportData);
  $("btn-import-data").addEventListener("click", importData);
  $("import-file").addEventListener("change", handleImportFile);
  $("btn-sync-bind").addEventListener("click", bindSync);
  $("btn-sync-now").addEventListener("click", () => syncNow(true));
  $("btn-sync-unbind").addEventListener("click", unbindSync);
  $("btn-exit-app").addEventListener("click", exitApp);
  $("btn-refresh-stats").addEventListener("click", refreshStats);

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
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // 新 SW 接管时自动刷新一次，确保拿到最新代码
      if (!window.__fd.reloaded) { window.__fd.reloaded = true; location.reload(); }
    });
  }
}

/* ---------- 启动 ---------- */
async function init() {
  bindEvents();
  initTheme();
  registerSW();
  if (!getToken()) { showAuth(); startTimers(); return; }
  let me = null;
  try { me = await apiDirect("/api/auth/me"); } catch (e) {}
  if (!me) { clearToken(); showAuth(); startTimers(); return; }
  state.user = me;
  enterApp();
  await initData();
  startTimers();
  tick();
}

async function initData() {
  try { state.settings = await apiDirect("/api/settings"); } catch (e) {}
  if (state.settings) applySettingsToForm();
  loadReminderPrefs();
  try {
    const rs = await apiDirect("/api/settings/ritual-stage");
    state.ritualStage = rs.stage || 1;
    state.ritualTodayCount = rs.today_count || 0;
  } catch (e) {}
  const stageNames = { 1: "入门", 2: "渐悟", 3: "自在" };
  const stageLabel = $("ritual-stage-label");
  if (stageLabel) stageLabel.textContent = stageNames[state.ritualStage] || "受训期";
  try {
    const g = await apiDirect("/api/settings/graduation");
    state.graduated = !!(g && g.graduated_at);
  } catch (e) {}

  let server = null;
  try { server = await apiDirect("/api/sessions/current"); } catch (e) {}
  let local = null;
  try { local = JSON.parse(localStorage.getItem(LOCAL_SESSION) || "null"); } catch (e) {}
  state.session = server || local;
  if (state.session) {
    if (isStaleSession(state.session)) {
      resetIdle();
      autoAbandon(state.session);
    } else {
      enterRunning();
    }
  } else {
    refreshHome();
  }
  loadSyncStatus().then(() => { if (state.cloudBound) syncNow(false); }); // 启动时静默同步
}

function startTimers() {
  setInterval(flushQueue, 20000);
  setInterval(() => { if (state.cloudBound) syncNow(false); }, 300000); // 5 分钟静默同步
}

/* 会话驱动的定时器：只在专注进行中跑，空闲时不空转 */
let sessionTickId = null;
let sessionPollId = null;
function startSessionTimers() {
  if (sessionTickId) return;
  sessionTickId = setInterval(tick, 1000);
  if (state.device === "desktop") sessionPollId = setInterval(pollDistract, HIT_POLL_MS);
}
function stopSessionTimers() {
  if (sessionTickId) { clearInterval(sessionTickId); sessionTickId = null; }
  if (sessionPollId) { clearInterval(sessionPollId); sessionPollId = null; }
}

function isStaleSession(s) {
  // 会话超过"计划时长×2 或 30 分钟"仍未结束，视为遗留旧会话（统一阈值，避免误杀进行中的离线会话）
  const elapsedMin = (Date.now() - sessionStartTime(s)) / 60000;
  const planned = s.planned_minutes || 15;
  return elapsedMin > Math.max(planned * 2, 30);
}

async function autoAbandon(s) {
  stopSessionTimers();
  state.session = null;
  localStorage.removeItem(LOCAL_SESSION);
  const actual = Math.max(1, Math.round((Date.now() - sessionStartTime(s)) / 60000));
  const payload = { action: "abandon", completion_score: null, flow_score: null, reliance: null, actual_minutes: actual };
  if (s.id) {
    const queueItem = { type: "raw", path: `/api/sessions/${s.id}`, method: "PATCH", body: payload };
    await apiWriteQueue(`/api/sessions/${s.id}`, "PATCH", payload, queueItem);
  } else {
    enqueue({ type: "end", clientKey: s.clientKey, ...payload });
  }
  toast("检测到一场遗留的旧会话，已自动结束");
  refreshHome();
}

function resetIdle() {
  state.idleFlag = false;
  state.lastActivity = Date.now();
}

window.__fd = { state, reloaded: false, timer: timerState }; // 调试/测试钩子

init();
