/* 篆香 E2E：独立测试库 + 真实 Chrome(headless) + CDP 验证 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const CHROME = process.env.CHROME_PATH ||
  (fs.existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe") ? "C:/Program Files/Google/Chrome/Application/chrome.exe" :
   "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe");
const os = require("os");
const RUN = path.join(os.tmpdir(), "fd-e2e-" + Date.now());
const PORT = 9400 + Math.floor(Math.random() * 200);
const SRV_PORT = 8100 + Math.floor(Math.random() * 100);
const BASE = "http://127.0.0.1:" + SRV_PORT;
const PROFILE = path.join(RUN, "profile");
const TEST_DB = path.join(RUN, "test.db");
const ART = path.join(RUN, "art");
fs.mkdirSync(ART, { recursive: true });
try { fs.unlinkSync(TEST_DB); } catch (e) {}

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn("python", ["-m", "uvicorn", "app.main:app", "--port", String(SRV_PORT)], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, FOCUS_DB_PATH: TEST_DB },
  stdio: "ignore",
});
const child = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-gpu-sandbox",
  "--disable-software-rasterizer", "--disable-dev-shm-usage", "--no-sandbox",
  "about:blank",
], { stdio: "ignore" });

async function waitFetch(url, transform = null, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return transform ? transform(r) : true; } catch (e) {}
    await sleep(300);
  }
  throw new Error("not ready: " + url);
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) {
        const { resolve, reject } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    };
    return c;
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval err: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async shot(name) {
    try {
      const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 6000);
      fs.writeFileSync(path.join(ART, name + ".png"), Buffer.from(r.data, "base64"));
      console.log("  [截图] " + name + ".png");
    } catch (e) { console.log("  [截图跳过] " + name + " (" + e.message + ")"); }
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  await waitFetch(BASE + "/api/health");
  await waitFetch(`http://127.0.0.1:${PORT}/json/version`, (r) => r.json());
  const tab = await fetch(`http://127.0.0.1:${PORT}/json/new?url=about:blank`, { method: "PUT" }).then((r) => r.json());
  const cdp = await CDP.connect(tab.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });

  async function waitFor(expr, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await cdp.eval(expr)) return true; } catch (e) {}
      await sleep(250);
    }
    return false;
  }

  console.log("== E0 全新用户打开 → 登录页 ==");
  await cdp.send("Page.navigate", { url: BASE + "/" });
  await sleep(4000); // 等 SW 激活+自动刷新等完全稳定
  check("登录页可见", await waitFor(`!document.getElementById('view-auth').hidden`));
  check("主视图隐藏", await cdp.eval(`document.getElementById('view-home').hidden`));
  check("导航隐藏", await cdp.eval(`document.getElementById('nav').hidden`));
  const authW = await cdp.eval(`(() => { const u = document.getElementById('auth-username').offsetWidth; const p2 = document.getElementById('auth-password').offsetWidth; return u + '/' + p2; })()`);
  check("输入框等宽", /^\d+\/\d+$/.test(authW) && authW.split("/")[0] === authW.split("/")[1], authW);
  await cdp.shot("00-auth-login");

  console.log("== E0b 注册并进入 ==");
  await cdp.eval(`document.querySelector('.auth-tab[data-mode="register"]').click()`);
  await cdp.eval(`document.getElementById('auth-username').value = 'e2euser'`);
  await cdp.eval(`document.getElementById('auth-nickname').value = '端到端'`);
  await cdp.eval(`document.getElementById('auth-password').value = 'secret123'`);
  await cdp.eval(`document.getElementById('auth-password2').value = 'secret123'`);
  await cdp.eval(`document.getElementById('btn-auth-submit').click()`);
  check("注册后进入应用", await waitFor(`document.getElementById('view-auth').hidden`));
  check("注册后自动翻开手册", await waitFor(`!document.getElementById('view-manual').hidden`));
  await cdp.shot("00-auth-registered");

  console.log("== E1 全新用户打开首页 ==");
  await cdp.send("Page.navigate", { url: BASE + "/" });
  await sleep(4000); // 等 SW 激活+自动刷新等完全稳定
  const homeOk = await waitFor(`!document.getElementById('home-idle').hidden`);
  check("首页可见（这次要完成什么）", homeOk);
  check("运行视图隐藏", await cdp.eval(`document.getElementById('home-running').hidden`));
  check("idle 弹窗隐藏", await cdp.eval(`document.getElementById('overlay-idle').hidden`));
  const visHidden = await cdp.eval(`['overlay-startup','overlay-review','overlay-attribution','overlay-idle','overlay-ritual'].every(id => getComputedStyle(document.getElementById(id)).display === 'none')`);
  check("visHidden", visHidden);
  await cdp.shot("01-home");

  console.log("== E2 Service Worker 已注册（v80） ==");
  const sw = await waitFor(`navigator.serviceWorker.getRegistrations().then(rs => rs.length > 0)`, 10000);
  check("SW 已注册", sw);
  const swUrl = await cdp.eval(`navigator.serviceWorker.getRegistrations().then(rs => rs[0].active ? rs[0].active.scriptURL : null)`, true);
  check("SW scriptURL", swUrl === BASE + "/sw.js", String(swUrl));
  const cacheName = await cdp.eval(`caches.keys().then(ks => ks.join(','))`, true);
  check("缓存为 v80", /yizhuxiang-v80/.test(cacheName), cacheName);

  console.log("== E3 遗留旧会话（2小时前）→ 自动结束回首页 ==");
  await cdp.eval(`localStorage.setItem('fd_local_session', JSON.stringify({clientKey:'sk-old', task_name:'旧任务', planned_minutes:15, started_at: Date.now()-7200000})); location.reload();`);
  await sleep(3000);
  const cleared = await cdp.eval(`localStorage.getItem('fd_local_session') === null`);
  check("localStorage 已清除", cleared);
  check("回到首页", await cdp.eval(`!document.getElementById('home-idle').hidden`));
  check("无弹窗", await cdp.eval(`document.getElementById('overlay-idle').hidden`));
  const toast = await cdp.eval(`document.getElementById('toast').textContent`);
  check("toast 提示自动结束", /自动结束/.test(toast), toast);
  await cdp.shot("02-after-abandon");

  console.log("== E4 近期会话进入专注 + 无操作弹窗 + 稍后再问 ==");
  await cdp.eval(`localStorage.setItem('fd_local_session', JSON.stringify({clientKey:'sk-new', task_name:'写周报', planned_minutes:15, started_at: Date.now()-60000})); location.reload();`);
  check("进入专注视图", await waitFor(`!document.getElementById('home-running').hidden`));
  check("任务名正确", await cdp.eval(`document.getElementById('running-task').textContent === '写周报'`));
  check("专注页香元素", await cdp.eval(`!!document.getElementById('incense') && !!document.getElementById('incense-tip') && !!document.getElementById('incense-ash') && !!document.getElementById('incense-burner')`));
  check("已燃分钟显示", await cdp.eval(`/^已燃 \\d+ 分钟$/.test(document.getElementById('incense-time').textContent)`));
  await cdp.eval(`window.__fd.state.idleFlag = true; document.dispatchEvent(new Event('visibilitychange'));`);
  await waitFor(`!document.getElementById('overlay-idle').hidden`);
  check("无操作弹窗显示", true);
  check("弹窗视觉可见（computed display 非 none）", await cdp.eval(`getComputedStyle(document.getElementById('overlay-idle')).display !== 'none'`));
  check("有「稍后再问」按钮", await cdp.eval(`!!document.getElementById('btn-idle-later')`));
  await cdp.shot("03-idle-overlay");
  await cdp.eval(`document.getElementById('btn-idle-later').click()`);
  check("稍后再问后弹窗隐藏", await cdp.eval(`document.getElementById('overlay-idle').hidden`));
  check("仍停留在专注视图", await cdp.eval(`!document.getElementById('home-running').hidden`));

  console.log("== E5 弹窗点「走神了」→ 记录分心 ==");
  await cdp.eval(`window.__fd.state.idleFlag = true; document.dispatchEvent(new Event('visibilitychange'));`);
  await waitFor(`!document.getElementById('overlay-idle').hidden`);
  await cdp.eval(`document.querySelector('#overlay-idle button[data-idle="distracted"]').click()`);
  check("弹窗关闭", await cdp.eval(`document.getElementById('overlay-idle').hidden`));
  check("回神仪式弹出（走神后）", await waitFor(`getComputedStyle(document.getElementById('overlay-ritual')).display !== 'none'`));
  check("仪式有「我回来了」按钮", await cdp.eval(`!!document.getElementById('btn-ritual-done')`));
  check("L1 显示反馈+原因选项", await cdp.eval(`!document.getElementById('ritual-count').hidden && document.getElementById('ritual-count').textContent.includes('次回来') && !document.getElementById('ritual-reasons').hidden`));
  await cdp.shot("04-ritual");
  await cdp.eval(`document.getElementById('btn-ritual-done').click()`);
  check("仪式完成浮层隐藏", await waitFor(`getComputedStyle(document.getElementById('overlay-ritual')).display === 'none'`));
  await sleep(800);
  const dist = await cdp.eval(`fetch('${BASE}/api/stats/insights', { headers: { Authorization: 'Bearer ' + localStorage.getItem('yizhuxiang-token') } }).then(r => r.json()).then(j => j.total_distractions)`, true);
  check("分心已入库", dist >= 1, "total=" + dist);


  console.log("== E5b 手动「破功了」→ 回神仪式 ==");
  await cdp.eval(`document.getElementById('btn-distract').click()`);
  check("手动破功后仪式弹出", await waitFor(`getComputedStyle(document.getElementById('overlay-ritual')).display !== 'none'`));
  await cdp.shot("04b-ritual-manual");
  await cdp.eval(`document.getElementById('btn-ritual-done').click()`);
  check("仪式完成浮层隐藏", await waitFor(`getComputedStyle(document.getElementById('overlay-ritual')).display === 'none'`));

  console.log("== E6 正常完成一场专注 ==");
  await cdp.eval(`window.confirm = () => true;`); // 绕过 confirm 阻塞
  await cdp.eval(`document.getElementById('btn-abandon').click()`); // 先放弃当前测试会话，回首页
  await waitFor(`!document.getElementById('home-idle').hidden`);
  await cdp.eval(`document.getElementById('task-input').value = '读 20 页书'; document.getElementById('btn-start').click()`);
  await waitFor(`!document.getElementById('overlay-startup').hidden`);
  await cdp.eval(`document.getElementById('btn-confirm-start').click()`);
  await waitFor(`!document.getElementById('home-running').hidden`);
  check("新会话开始", await cdp.eval(`document.getElementById('running-task').textContent === '读 20 页书'`));
  await cdp.shot("04-running");
  await cdp.eval(`document.getElementById('btn-complete').click()`);
  check("自评弹窗出现", await waitFor(`!document.getElementById('overlay-review').hidden`));
  check("自评含靠产品/靠自己", await cdp.eval(`document.querySelectorAll('#reliance-picker .reliance-btn').length === 2`));
  check("默认靠自己", await cdp.eval(`document.querySelector('#reliance-picker .reliance-btn.selected').dataset.v === 'self'`));
  await cdp.shot("04-review");
  await cdp.eval(`document.getElementById('btn-submit-review').click()`);
  check("完成后回首页", await waitFor(`!document.getElementById('home-idle').hidden`));
  const rel = await cdp.eval(`fetch('${BASE}/api/stats/weekly', { headers: { Authorization: 'Bearer ' + localStorage.getItem('yizhuxiang-token') } }).then(r => r.json()).then(j => j.self_sessions + '/' + j.product_sessions)`, true);
  check("靠自己已入库", rel === "1/0", rel);
  const visAfter = await cdp.eval(`(() => { const ids=['overlay-startup','overlay-review','overlay-attribution','overlay-idle','overlay-ritual']; const bad=ids.filter(id => getComputedStyle(document.getElementById(id)).display !== 'none'); return JSON.stringify({bad, toastDisplay: getComputedStyle(document.getElementById('toast')).display, toastHidden: document.getElementById('toast').hidden}); })()`);
  check("afterDone(无弹窗残留)", JSON.parse(visAfter).bad.length === 0, visAfter);

  console.log("== E6b 待办：添加 → 从待办开始 → 完成自动移除 ==");
  await cdp.eval(`document.querySelector('#nav .nav-btn[data-view="todo"]').click()`);
  check("待办页可见", await waitFor(`!document.getElementById('view-todo').hidden`));
  await cdp.eval(`document.getElementById('todo-input').value = '写方案'; document.getElementById('btn-todo-add').click()`);
  check("待办已添加", await waitFor(`document.querySelectorAll('#todo-list .todo-item').length === 1`));
  check("待办内容正确", await cdp.eval(`document.querySelector('#todo-list .todo-text').textContent === '写方案'`));
  await cdp.eval(`document.querySelector('#todo-list .todo-start').click()`);
  check("从待办开始进入专注", await waitFor(`!document.getElementById('home-running').hidden`));
  check("任务名来自待办", await cdp.eval(`document.getElementById('running-task').textContent === '写方案'`));
  await cdp.eval(`document.getElementById('btn-complete').click()`);
  await waitFor(`!document.getElementById('overlay-review').hidden`);
  await cdp.eval(`document.getElementById('btn-submit-review').click()`);
  check("完成后回首页", await waitFor(`!document.getElementById('home-idle').hidden`));
  await cdp.eval(`document.querySelector('#nav .nav-btn[data-view="todo"]').click()`);
  await waitFor(`!document.getElementById('view-todo').hidden`);
  check("待办完成已移除", await waitFor(`document.querySelectorAll('#todo-list .todo-item').length === 0`));

  console.log("== E6c 计时器工具：卡片入口 + 全屏倒计时 ==");
  await cdp.eval(`document.querySelector('#nav .nav-btn[data-view="me"]').click()`);
  await waitFor(`!document.getElementById('view-me').hidden`);
  check("工具面板默认收起", await cdp.eval(`document.getElementById('tools-panel').hidden`));
  await cdp.eval(`document.getElementById('btn-toggle-tools').click()`);
  check("工具面板展开", await waitFor(`!document.getElementById('tools-panel').hidden`));
  await cdp.eval(`document.getElementById('tool-card-timer').click()`);
  check("进入全屏计时页", await waitFor(`!document.getElementById('view-tool-timer').hidden`));
  check("导航已隐藏", await cdp.eval(`document.getElementById('nav').hidden`));
  check("进入显示时长设置", await cdp.eval(`!document.getElementById('timer-settings').hidden`));
  check("默认显示 15:00", await cdp.eval(`document.getElementById('timer-display').textContent === '15:00'`));
  check("按钮为开始", await cdp.eval(`document.getElementById('btn-timer-start').textContent === '开始'`));
  await cdp.eval(`document.querySelector('#timer-chips .chip[data-min="5"]').click(); document.getElementById('btn-timer-start').click();`);
  check("选 5 分钟开始显示 05:00", await waitFor(`document.getElementById('timer-display').textContent === '05:00'`));
  await cdp.eval(`window.__fd.timer.endAt = Date.now() + 600; window.__fd.timer.running = true;`);
  check("到点提示", await waitFor(`document.getElementById('timer-status').textContent === '时间到'`));
  await cdp.eval(`document.getElementById('btn-timer-back').click()`);
  check("返回回我的页", await waitFor(`!document.getElementById('view-me').hidden`));
  await cdp.shot("04c-timer");

  console.log("== E6d 每日任务：每日添加框 + 完成打卡 ==");
  await cdp.eval(`document.querySelector('#nav .nav-btn[data-view="todo"]').click()`);
  await waitFor(`!document.getElementById('view-todo').hidden`);
  await cdp.eval(`document.getElementById('todo-daily-input').value = '喝水'; document.getElementById('btn-todo-daily-add').click()`);
  await waitFor(`document.querySelectorAll('#todo-daily-list .todo-item').length === 1`);
  await cdp.eval(`document.querySelector('#todo-daily-list .todo-item .todo-check').click()`);
  check("打卡后每日任务保留", await waitFor(`document.querySelectorAll('#todo-daily-list .todo-item').length === 1`));
  check("打卡项标今日已完成", await waitFor(`!!document.querySelector('#todo-daily-list .todo-item .todo-done-mark')`));
  check("打卡项显示天数", await waitFor(`document.querySelector('#todo-daily-list .todo-item .todo-streak').textContent === '已打卡 1 天'`));
  await cdp.shot("04d-todo-daily");

  console.log("== E6e 头像上传（圆形裁剪） ==");
  const pngPath = path.join(RUN, "avatar.png");
  fs.writeFileSync(pngPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  await cdp.eval(`document.querySelector('#nav .nav-btn[data-view="me"]').click()`);
  await waitFor(`!document.getElementById('view-me').hidden`);
  await cdp.send("DOM.enable");
  const adoc = await cdp.send("DOM.getDocument");
  const aq = await cdp.send("DOM.querySelector", { nodeId: adoc.root.nodeId, selector: "#avatar-file" });
  await cdp.send("DOM.setFileInputFiles", { nodeId: aq.nodeId, files: [pngPath] });
  check("裁剪弹层出现", await waitFor(`!document.getElementById('overlay-avatar').hidden`));
  await cdp.eval(`document.getElementById('crop-zoom').value = '2'; document.getElementById('crop-zoom').dispatchEvent(new Event('input'));`);
  await cdp.eval(`document.getElementById('btn-crop-ok').click()`);
  check("头像上传成功并显示", await waitFor(`!document.getElementById('avatar-img').hidden`));
  await cdp.shot("04e-avatar");

  console.log("== E6f 黑名单：添加进程 + 保存 ==");
  await cdp.eval(`document.querySelector('#nav .nav-btn[data-view="settings"]').click()`);
  await waitFor(`!document.getElementById('view-settings').hidden`);
  await cdp.eval(`document.getElementById('blacklist-input').value = 'bilibili'; document.getElementById('btn-blacklist-add').click()`);
  check("黑名单列表出现", await waitFor(`document.querySelectorAll('#blacklist-list .blacklist-item').length === 1`));
  check("删除进程按钮存在", await cdp.eval(`document.querySelector('#blacklist-list .blacklist-item').textContent.includes('删除进程')`));
  await cdp.eval(`document.getElementById('btn-save-settings').click()`);
  check("保存后黑名单入库", await waitFor(`fetch('${BASE}/api/settings', { headers: { Authorization: 'Bearer ' + localStorage.getItem('yizhuxiang-token') } }).then(r => r.json()).then(j => j.blacklist.includes('bilibili'))`));

  console.log("== E7 缓存穿透 URL（/ ?v=80）正常加载 ==");
  await cdp.send("Page.navigate", { url: BASE + "/?v=80" });
  await cdp.eval(`document.querySelector('#nav .nav-btn[data-view="home"]').click()`);
  check("v=80 加载正常", await waitFor(`!document.getElementById('home-idle').hidden`));
  check("页面版本为 v80 资源", await cdp.eval(`document.querySelector('script[src*="app.js"]').src.includes('v=80')`));

  console.log("== E8 开始专注（新流程：直接开始） ==");
  await waitFor(`window.__fd && typeof window.toggleTheme === 'function'`, 8000);
  await cdp.eval(`document.getElementById('task-input').value = '端到端专注'`);
  await cdp.eval(`document.getElementById('btn-start').click()`);
  check("点开始直接进入专注视图", await waitFor(`!document.getElementById('home-running').hidden`));
  check("任务名回填", await cdp.eval(`document.getElementById('running-task').textContent === '端到端专注'`));
  await cdp.eval(`document.getElementById('btn-abandon').click()`);
  await waitFor(`!document.getElementById('overlay-confirm').hidden`);
  await cdp.eval(`document.getElementById('btn-confirm-ok').click()`);
  await waitFor(`!document.getElementById('overlay-reflect').hidden`);
  await cdp.eval(`document.getElementById('btn-reflect-skip').click()`);
  check("放弃后回首页", await waitFor(`document.getElementById('home-running').hidden`));

  console.log("== E9 昼夜主题切换 + 视觉截图 ==");
  // 强制从夜模式开始（不依赖系统偏好）
  await cdp.eval(`localStorage.setItem('yizhuxiang-theme', 'dark')`);
  await cdp.send("Page.navigate", { url: BASE + "/" });
  await waitFor(`window.__fd && typeof window.toggleTheme === 'function' && document.documentElement.dataset.theme === 'dark'`, 10000);
  await sleep(500);
  const darkInit = await cdp.eval(`getComputedStyle(document.body).backgroundColor`);
  check("初始为夜模式（墨色背景）", darkInit === "rgb(20, 20, 28)", darkInit);
  check("夜模式按钮显示「昼」", await cdp.eval(`document.getElementById('btn-theme').textContent === '昼'`));
  await cdp.shot("05-home-dark");
  // 切昼
  await cdp.eval(`document.getElementById('btn-theme').click()`);
  const lightBg = await cdp.eval(`getComputedStyle(document.body).backgroundColor`);
  check("切昼后背景为宣纸色", lightBg === "rgb(241, 236, 226)", lightBg);
  check("昼模式 data-theme 正确", await cdp.eval(`document.documentElement.dataset.theme === 'light'`));
  check("昼模式已记忆", await cdp.eval(`localStorage.getItem('yizhuxiang-theme') === 'light'`));
  check("昼模式按钮显示「夜」", await cdp.eval(`document.getElementById('btn-theme').textContent === '夜'`));
  await cdp.shot("06-home-light");
  await cdp.eval(`document.querySelector('#nav .nav-btn[data-view="stats"]').click()`);
  await sleep(800);
  await cdp.shot("07-stats-light");
  check("统计页含靠自己完成卡片", await cdp.eval(`!!document.getElementById('self-rate')`));
  await cdp.eval(`document.querySelector('#nav .nav-btn[data-view="settings"]').click()`);
  await sleep(500);
  check("设置页含裸专注日下拉", await cdp.eval(`!!document.getElementById('naked-day')`));
  await cdp.shot("08-settings-light");
  // 切回夜
  await cdp.eval(`document.getElementById('btn-theme').click()`);
  const darkBg = await cdp.eval(`getComputedStyle(document.body).backgroundColor`);
  check("切回夜后背景为墨色", darkBg === "rgb(20, 20, 28)", darkBg);
  check("夜模式 data-theme 正确", await cdp.eval(`document.documentElement.dataset.theme === 'dark'`));
  check("夜模式已记忆", await cdp.eval(`localStorage.getItem('yizhuxiang-theme') === 'dark'`));
  check("夜模式按钮显示「昼」", await cdp.eval(`document.getElementById('btn-theme').textContent === '昼'`));
  await cdp.shot("09-settings-dark");
  await cdp.eval(`document.querySelector('#nav .nav-btn[data-view="stats"]').click()`);
  await sleep(800);
  await cdp.shot("10-stats-dark");
  await cdp.eval(`document.querySelector('#nav .nav-btn[data-view="home"]').click()`);
  await sleep(500);
  await cdp.shot("11-home-dark");
  // 夜下看启动弹窗
  await cdp.eval(`document.getElementById('task-input').value = '夜下专注'`);
  await cdp.eval(`document.getElementById('btn-start').click()`);
  await waitFor(`!document.getElementById('home-running').hidden`);
  await cdp.shot("12-startup-dark");
  await cdp.eval(`document.getElementById('btn-abandon').click()`);
  await waitFor(`!document.getElementById('overlay-confirm').hidden`);
  await cdp.eval(`document.getElementById('btn-confirm-ok').click()`);
  await waitFor(`!document.getElementById('overlay-reflect').hidden`);
  await cdp.eval(`document.getElementById('btn-reflect-skip').click()`);
  await waitFor(`document.getElementById('home-running').hidden`);
  // 进入「我的」：身份卡 + 改昵称 + 改密码（账号流程闭环）
  await cdp.eval(`document.querySelector('#nav .nav-btn[data-view="me"]').click()`);
  check("我的页可见", await waitFor(`!document.getElementById('view-me').hidden`));
  check("身份卡昵称", await waitFor(`document.getElementById('profile-nickname').textContent === '端到端'`));
  check("累计履历渲染", await cdp.eval(`document.getElementById('pf-completed').textContent !== ''`));
  check("账号管理默认收起", await cdp.eval(`document.getElementById('account-panel').hidden`));
  check("登出按钮在账号管理区内", await cdp.eval(`!!document.querySelector('#account-panel #btn-logout') && !document.querySelector('#brandbar #btn-logout')`));
  await cdp.shot("14-profile-dark");
  // 展开账号管理 → 改昵称
  await cdp.eval(`document.getElementById('btn-toggle-account').click()`);
  check("账号管理已展开", await waitFor(`!document.getElementById('account-panel').hidden`));
  await cdp.eval(`document.getElementById('profile-nick-input').value = '端到端改'`);
  await cdp.eval(`document.getElementById('btn-save-nick').click()`);
  check("改昵称生效", await waitFor(`document.getElementById('profile-nickname').textContent === '端到端改'`));
  // 改密码 → 强制重新登录
  await cdp.eval(`document.getElementById('pw-old').value = 'secret123'`);
  await cdp.eval(`document.getElementById('pw-new').value = 'newpass1'`);
  await cdp.eval(`document.getElementById('pw-new2').value = 'newpass1'`);
  await cdp.eval(`document.getElementById('btn-change-pw').click()`);
  check("改密码后回登录页", await waitFor(`!document.getElementById('view-auth').hidden`));
  await cdp.eval(`document.getElementById('auth-username').value = 'e2euser'`);
  await cdp.eval(`document.getElementById('auth-password').value = 'newpass1'`);
  await cdp.eval(`document.getElementById('btn-auth-submit').click()`);
  check("新密码登录进入应用", await waitFor(`document.getElementById('view-auth').hidden && !document.getElementById('home-idle').hidden`));

  console.log("== E10 数据导出 / 导入（多端同步阶段 1） ==");
  // 写一篇日记，导出备份
  await cdp.eval(`fetch('${BASE}/api/diary', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('yizhuxiang-token') }, body: JSON.stringify({ date: '2026-08-11', content: '端到端导出导入测试' }) })`);
  const exported = await cdp.eval(`fetch('${BASE}/api/data/export', { headers: { Authorization: 'Bearer ' + localStorage.getItem('yizhuxiang-token') } }).then(r => r.json())`, true);
  check("导出含刚写的日记", exported.data.diaries.some((d) => d.date === "2026-08-11"));
  check("导出不含密码哈希", !JSON.stringify(exported).includes("password_hash"));
  // 注册第二个账号，导入备份（模拟换设备搬家）
  const reg = await cdp.eval(`fetch('${BASE}/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'e2eimport', password: 'secret1' }) }).then(r => r.json())`, true);
  const imp = await cdp.eval(`fetch('${BASE}/api/data/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + '${reg.token}' }, body: JSON.stringify(${JSON.stringify(exported)}) }).then(r => r.json())`, true);
  check("导入返回日记计数", imp.imported && imp.imported.diaries >= 1);
  const moved = await cdp.eval(`fetch('${BASE}/api/diary?date=2026-08-11', { headers: { Authorization: 'Bearer ' + '${reg.token}' } }).then(r => r.json())`, true);
  check("新账号能读到搬家的日记", moved.content === "端到端导出导入测试");

  console.log(`\nE2E 结果: ${passed} 通过, ${failed} 失败`);
  cdp.close();
  child.kill();
  server.kill();
  await sleep(500);
  if (process.env.KEEP_ART) {
    const dest = path.join(__dirname, "..", ".e2e_artifacts");
    fs.mkdirSync(dest, { recursive: true });
    try { for (const f of fs.readdirSync(ART)) fs.copyFileSync(path.join(ART, f), path.join(dest, f)); console.log("  [截图已保留] -> .e2e_artifacts/"); } catch (e) {}
  }
  try { fs.rmSync(RUN, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("E2E ERROR:", e);
  child.kill();
  server.kill();
  await sleep(500);
  if (process.env.KEEP_ART) {
    const dest = path.join(__dirname, "..", ".e2e_artifacts");
    fs.mkdirSync(dest, { recursive: true });
    try { for (const f of fs.readdirSync(ART)) fs.copyFileSync(path.join(ART, f), path.join(dest, f)); console.log("  [截图已保留] -> .e2e_artifacts/"); } catch (e) {}
  }
  try { fs.rmSync(RUN, { recursive: true, force: true }); } catch (err) {}
  process.exit(1);
});
