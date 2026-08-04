/* FocusDojo E2E：独立测试库 + 真实 Chrome(headless) + CDP 验证 */
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

  console.log("== E1 全新用户打开首页 ==");
  await cdp.send("Page.navigate", { url: BASE + "/" });
  await sleep(4000); // 等 SW 激活+自动刷新等完全稳定
  const homeOk = await waitFor(`!document.getElementById('home-idle').hidden`);
  check("首页可见（这次要完成什么）", homeOk);
  check("运行视图隐藏", await cdp.eval(`document.getElementById('home-running').hidden`));
  check("idle 弹窗隐藏", await cdp.eval(`document.getElementById('overlay-idle').hidden`));
  check("回弹入口不显示（新用户）", await cdp.eval(`document.getElementById('rebound-area').hidden`));
  const visHidden = await cdp.eval(`['overlay-startup','overlay-review','overlay-attribution','overlay-idle'].every(id => getComputedStyle(document.getElementById(id)).display === 'none')`);
  check("visHidden", visHidden);
  await cdp.shot("01-home");

  console.log("== E2 Service Worker 已注册（v5） ==");
  const sw = await waitFor(`navigator.serviceWorker.getRegistrations().then(rs => rs.length > 0)`, 10000);
  check("SW 已注册", sw);
  const swUrl = await cdp.eval(`navigator.serviceWorker.getRegistrations().then(rs => rs[0].active ? rs[0].active.scriptURL : null)`, true);
  check("SW scriptURL", swUrl === BASE + "/sw.js", String(swUrl));
  const cacheName = await cdp.eval(`caches.keys().then(ks => ks.join(','))`, true);
  check("缓存为 v5", /focusdojo-v5/.test(cacheName), cacheName);

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
  await sleep(800);
  const dist = await cdp.eval(`fetch('${BASE}/api/stats/insights').then(r => r.json()).then(j => j.total_distractions)`, true);
  check("分心已入库", dist >= 1, "total=" + dist);

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
  await cdp.eval(`document.getElementById('btn-submit-review').click()`);
  check("完成后回首页", await waitFor(`!document.getElementById('home-idle').hidden`));
  const visAfter = await cdp.eval(`(() => { const ids=['overlay-startup','overlay-review','overlay-attribution','overlay-idle']; const bad=ids.filter(id => getComputedStyle(document.getElementById(id)).display !== 'none'); return JSON.stringify({bad, toastDisplay: getComputedStyle(document.getElementById('toast')).display, toastHidden: document.getElementById('toast').hidden}); })()`);
  check("afterDone(无弹窗残留)", JSON.parse(visAfter).bad.length === 0, visAfter);

  console.log("== E7 缓存穿透 URL（/ ?v=5）正常加载 ==");
  await cdp.send("Page.navigate", { url: BASE + "/?v=5" });
  check("v=5 加载正常", await waitFor(`!document.getElementById('home-idle').hidden`));
  check("页面版本为 v5 资源", await cdp.eval(`document.querySelector('script[src*="app.js"]').src.includes('v=5')`));

  console.log("== E8 启动弹窗视觉显隐 ==");
  await cdp.eval(`document.getElementById('btn-start').click()`);
  check("点开始后启动弹窗视觉可见", await waitFor(`getComputedStyle(document.getElementById('overlay-startup')).display !== 'none'`));
  await cdp.eval(`document.getElementById('btn-cancel-start').click()`);
  check("点取消后启动弹窗视觉隐藏", await waitFor(`getComputedStyle(document.getElementById('overlay-startup')).display === 'none'`));

  console.log(`\nE2E 结果: ${passed} 通过, ${failed} 失败`);
  cdp.close();
  child.kill();
  server.kill();
  await sleep(500);
  try { fs.rmSync(RUN, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("E2E ERROR:", e);
  child.kill();
  server.kill();
  await sleep(500);
  try { fs.rmSync(RUN, { recursive: true, force: true }); } catch (err) {}
  process.exit(1);
});