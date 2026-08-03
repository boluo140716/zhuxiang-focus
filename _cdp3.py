# -*- coding: utf-8 -*-
"""Chrome 无头 + CDP（浏览器级端点）冒烟测试 FocusDojo 前端。"""
import base64
import json
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path

from websocket import create_connection

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PORT = 9224
USER_DIR = r"D:\Focus_Project\.chrome_tmp3"
OUT_DIR = Path(r"C:\Users\20486\.codex\visualizations\2026\08\03\019fc80b-cbba-76f3-b1e8-ce1e994f3871")

proc = subprocess.Popen(
    [CHROME, "--headless=new", f"--remote-debugging-port={PORT}", f"--user-data-dir={USER_DIR}",
     "--no-first-run", "--disable-gpu", "--remote-allow-origins=*",
     "--window-size=420,860", "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)

def http_json(url, method="GET", data=None):
    req = urllib.request.Request(url, method=method, data=data)
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)

report = {}
try:
    version = None
    for _ in range(60):
        try:
            version = http_json(f"http://127.0.0.1:{PORT}/json/version")
            break
        except Exception:
            time.sleep(0.25)
    if version is None:
        raise SystemExit("chrome debug endpoint not up")

    ws = create_connection(version["webSocketDebuggerUrl"], timeout=30)
    ws.settimeout(0.15)
    msg_id = 0
    errors = []

    def recv_until_id(target, timeout=25):
        end = time.time() + timeout
        while time.time() < end:
            try:
                m = json.loads(ws.recv())
            except Exception:
                continue
            if m.get("id") == target:
                return m
            if "method" in m:
                p = m.get("params", {})
                if m["method"] in ("Runtime.exceptionThrown", "Log.entryAdded"):
                    errors.append(m)
                elif m["method"] == "Runtime.consoleAPICalled" and p.get("type") == "error":
                    errors.append(m)
        return None

    def cmd(method, params=None, session=None):
        global msg_id
        msg_id += 1
        payload = {"id": msg_id, "method": method, "params": params or {}}
        if session:
            payload["sessionId"] = session
        ws.send(json.dumps(payload))
        return recv_until_id(msg_id)

    # 创建页面目标并附加
    target_url = "http://127.0.0.1:8000/"
    created = cmd("Target.createTarget", {"url": "about:blank"})
    target_id = created["result"]["targetId"]
    attached = cmd("Target.attachToTarget", {"targetId": target_id, "flatten": True})
    session = attached["result"]["sessionId"]

    cmd("Page.enable", session=session)
    cmd("Runtime.enable", session=session)
    cmd("Log.enable", session=session)
    cmd("Page.navigate", {"url": target_url}, session=session)
    time.sleep(4.0)

    def ev(expr):
        r = cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True}, session=session)
        try:
            return r["result"]["result"].get("value")
        except Exception:
            return "EVAL_ERR"

    report["title"] = ev("document.title")
    report["nav_buttons"] = ev("document.querySelectorAll('#nav .nav-btn').length")
    report["start_btn"] = ev("!document.querySelector('#btn-start').hidden")
    report["today_focus"] = ev("document.querySelector('#today-focus').textContent")

    ev("document.querySelector('#btn-start').click()")
    time.sleep(0.5)
    report["startup_overlay_shown"] = ev("!document.querySelector('#overlay-startup').hidden")
    ev("document.querySelector('#startup-task').value='CDP冒烟任务'")
    ev("document.querySelector('#startup-slider').value=15")
    ev("document.querySelector('#btn-confirm-start').click()")
    time.sleep(1.5)
    report["running_view"] = ev("!document.querySelector('#home-running').hidden")
    report["timer_text"] = ev("document.querySelector('#timer').textContent")
    report["running_task"] = ev("document.querySelector('#running-task').textContent")

    ev("document.querySelector('#btn-distract').click()")
    time.sleep(0.5)

    ev("document.querySelector('#btn-complete').click()")
    time.sleep(0.5)
    report["review_overlay_shown"] = ev("!document.querySelector('#overlay-review').hidden")
    ev("document.querySelector('#completion-slider').value=80")
    ev("document.querySelector('#btn-submit-review').click()")
    time.sleep(1.5)
    report["back_to_idle"] = ev("!document.querySelector('#home-idle').hidden")

    shot = cmd("Page.captureScreenshot", {"format": "png"}, session=session)
    img = base64.b64decode(shot["result"]["data"])
    (OUT_DIR / "focus-home.png").write_bytes(img)

    ev("document.querySelectorAll('#nav .nav-btn')[1].click()")
    time.sleep(1.5)
    report["stats_rate"] = ev("document.querySelector('#week-rate').textContent")
    report["stats_target"] = ev("document.querySelector('#next-target').textContent")

    with urllib.request.urlopen("http://127.0.0.1:8000/api/stats/daily", timeout=5) as r:
        daily = json.load(r)
    report["server_completed"] = daily["completed_sessions"]
    report["server_focus_min"] = daily["focus_minutes"]
    with urllib.request.urlopen("http://127.0.0.1:8000/api/stats/insights", timeout=5) as r:
        ins = json.load(r)
    report["server_distractions"] = ins["total_distractions"]

    report["js_errors"] = [e.get("method") for e in errors][:5]
    print(json.dumps(report, ensure_ascii=False, indent=2))
    ws.close()
finally:
    proc.terminate()
    time.sleep(1)
    try:
        proc.kill()
    except Exception:
        pass
