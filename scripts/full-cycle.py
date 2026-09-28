#!/usr/bin/env python3
"""The whole PR Scout cycle for one repository from the command line, report included.

    python3 scripts/full-cycle.py <owner/repo> [job]

Creates the project if it does not exist (profile and areas come from presets/<owner__repo>.json),
runs `everything` (PRs → descriptions → Jev → test merges → issues → rivals → forks → stack → map),
waits for it and saves the markdown report to reports/. Talks to a running instance; the URL and
password come from the environment or from .env next to docker-compose.yml.
"""
import base64
import json
import os
import pathlib
import re
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOTENV = (ROOT / ".env").read_text() if (ROOT / ".env").exists() else ""


def env(name, default=""):
    if os.environ.get(name):
        return os.environ[name]
    m = re.search(rf"(?m)^{name}=(.*)$", DOTENV)
    return m.group(1).strip() if m and m.group(1).strip() else default


BASE = env("SCOUT_URL", f"http://127.0.0.1:{env('SCOUT_PORT', '8000')}").rstrip("/")
AUTH = {"Authorization": "Basic " + base64.b64encode(f"scout:{env('APP_PASSWORD')}".encode()).decode()} if env("APP_PASSWORD") else {}
if len(sys.argv) < 2:
    raise SystemExit(__doc__)
REPO, JOB = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "everything"
SLUG = REPO.replace("/", "__")
T0 = time.time()


def request(path, method="GET", body=None, timeout=120):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={**AUTH, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()


def api(path, method="GET", body=None):
    raw = request(path, method, body)
    return json.loads(raw) if raw.strip() else {}


def log(msg):
    t = int(time.time() - T0)
    print(f"[{t // 60:02d}:{t % 60:02d}] {msg}", flush=True)


def wait():
    last = ""
    while True:
        time.sleep(10)
        st = api("/api/status")["job"]
        line = f"{st.get('running') or 'готово'} {st.get('done')}/{st.get('total')}"
        if line != last:
            log(line)
            last = line
        if not st.get("running"):
            return


if SLUG not in {p["slug"] for p in api("/api/projects")}:
    log(f"создаю проект {REPO}")
    api("/api/projects", "POST", {"url": f"https://github.com/{REPO}", "run": False})
log(f"запускаю «{JOB}»")
api(f"/api/p/{SLUG}/jobs/{JOB}", "POST", {})
wait()

runs = api(f"/api/p/{SLUG}/summary")["runs"]
for r in runs[-12:]:
    log(f"  {r['stage']:<12} {r.get('items', 0):>6} шт · {r.get('seconds', 0):>5} с · ${r.get('cost_usd') or 0} · ошибок {r.get('errors') or 0}")
out = ROOT / "reports" / f"{time.strftime('%Y-%m-%d')}-{SLUG.replace('__', '-')}.md"
out.parent.mkdir(exist_ok=True)
out.write_text(request(f"/api/p/{SLUG}/report.md", timeout=300))
log(f"отчёт: {out}")
