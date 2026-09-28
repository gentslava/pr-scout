"""PR Scout: classify open pull requests of any GitHub repository with Jev and show the results."""
import asyncio
import base64
import concurrent.futures as cf
import datetime as dt
import hashlib
import json
import os
import random
import re
import secrets
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from queue import Queue

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from scoring import (KIND_LABELS, NEGATIVE, QUESTION_LABELS, STAGE2_QUESTIONS, auto_areas, cost_comparison,
                     mark_duplicates, score_pr, stage1_questions, stage1_state, verdict)
import triage
from triage import (FORK_KIND_LABELS, ISSUE_KIND_LABELS, ISSUE_KINDS, ISSUE_QUESTION_LABELS, apply_rival, fork_questions,
                    issue_questions, rival_question, score_fork, score_issue)
import llm
from report import build_report


def env(name, default=""):
    """An environment variable; docker compose passes unset ones as empty strings, so empty means default."""
    return os.environ.get(name) or default


APP_DIR = Path(__file__).parent
DATA = Path(env("DATA_DIR", "/data"))
PRESETS = APP_DIR.parent / "presets"
# Jev is served by two providers, the same model behind different endpoints:
#   TypeSafe   https://api.typesafe.ai/v1/systemone   TYPESAFE_API_KEY    yes/no questions are `noul`
#   NordRouter https://nordrouter.com/v1/evaluate     NORDROUTER_API_KEY  yes/no questions are `boolean`
# JEV_PROVIDER picks one. Unset, TypeSafe wins whenever its key is present, so an existing setup keeps
# talking to TypeSafe, and a key only ever goes to the provider it belongs to.
JEV_PROVIDERS = {
    "typesafe": {"name": "TypeSafe", "url": "https://api.typesafe.ai/v1/systemone", "model": "jev-latest", "key": "TYPESAFE_API_KEY", "price": 0.042},
    "nordrouter": {"name": "NordRouter", "url": "https://nordrouter.com/v1/evaluate", "model": "typesafe-ai/jev", "key": "NORDROUTER_API_KEY", "price": 0.05},
}
JEV_PROVIDER = env("JEV_PROVIDER", "nordrouter" if env("NORDROUTER_API_KEY") and not env("TYPESAFE_API_KEY") else "typesafe").lower()
if JEV_PROVIDER not in JEV_PROVIDERS:
    print(f"JEV_PROVIDER={JEV_PROVIDER!r} is unknown, falling back to typesafe", flush=True)
    JEV_PROVIDER = "typesafe"
_JEV = JEV_PROVIDERS[JEV_PROVIDER]
JEV_URL = env("JEV_API_URL", _JEV["url"])
JEV_MODEL = env("JEV_MODEL", _JEV["model"])
JEV_KEY = env(_JEV["key"])
JEV_LABEL = f"{JEV_MODEL} · {_JEV['name']}"  # what the run history shows as the model
# USD per 1M input tokens, for the cost panel: TypeSafe lists 0.042, NordRouter charges 0.05 (X-Charged-USD).
PRICE_PER_MTOK = float(env("JEV_PRICE_PER_MTOK", str(_JEV["price"])))
GH_TOKEN = env("GITHUB_TOKEN")
PASSWORD = env("APP_PASSWORD")
# NordRouter allows 15 rps on /v1/evaluate; stage 1 is ~1.1 s per PR, so 14 workers stay under it.
STAGE1_WORKERS = int(env("JEV_STAGE1_WORKERS", "14"))
STAGE2_WORKERS = int(env("JEV_STAGE2_WORKERS", "10"))
# Descriptions of PRs whose author wrote nothing come from an LLM provider (llm.py); cloud
# endpoints take this many parallel requests, a local Ollama two.
DESCRIBER_WORKERS = int(env("DESCRIBER_WORKERS", "6"))
# Stage 2 git work (fetch branch, test merge, diff) runs in parallel worktrees instead of one PR
# at a time, which cost 32 of 48 minutes on a 3000-PR run while Jev answered in 21 s. Git is
# CPU and disk bound here, so the default stays at a typical small server's core count.
MERGE_WORKERS = int(env("JEV_MERGE_WORKERS", "4"))
# Fork mining walks every fork with the compare API and asks Jev about the deltas.
FORK_REST_WORKERS = int(env("FORK_REST_WORKERS", "16"))
# Fork list: REST pages are numbered, so they can be pulled several at a time.
FORK_LIST_WORKERS = int(env("FORK_LIST_WORKERS", "8"))

app = FastAPI(title="PR Scout")
lock = threading.RLock()
projects: dict[str, dict] = {}  # slug -> {"config", "prs", "stage1", "stage2", "runs", "rows", "finalists", "included"}
job = {"running": None, "project": None, "done": 0, "total": 0, "started": None}
listeners: list[asyncio.Queue] = []
loop: asyncio.AbstractEventLoop | None = None


# ---------- storage ----------
def slug_of(repo):
    return repo.replace("/", "__")


def pdir(slug):
    return DATA / "projects" / slug


def read_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False))
    tmp.replace(path)


def save(slug, name):
    write_json(pdir(slug) / f"{name}.json", projects[slug][name])


def preset_for(repo):
    return read_json(PRESETS / f"{slug_of(repo)}.json", {})


def migrate_legacy():
    """v0 kept a single project's files at the data root. Move them into projects/ using its preset."""
    root_files = [DATA / f"{n}.json" for n in ("prs", "stage1", "stage2", "runs")]
    if not (DATA / "prs.json").exists() or (DATA / "projects").exists():
        return
    repo = os.environ.get("LEGACY_REPO", "paperclipai/paperclip")
    target = pdir(slug_of(repo))
    target.mkdir(parents=True, exist_ok=True)
    for f in root_files:
        if f.exists():
            shutil.move(str(f), str(target / f.name))
    if (DATA / "repo").exists():
        shutil.move(str(DATA / "repo"), str(target / "repo"))
    cfg = {"repo": repo, "name": repo.split("/")[1], "profile": "", "community_only": True, "exclude_authors": [], "stack_prs": [],
           "stack_prs_url": "", "finalists": 120, "describer": {"enabled": True, "provider": "ollama", "model": "qwen3.5:9b", "min_body": 200}}
    cfg.update(preset_for(repo))
    write_json(target / "config.json", cfg)


def load_project(slug):
    d = pdir(slug)
    p = {"config": read_json(d / "config.json", None)}
    if not p["config"]:
        return
    if "ollama" in p["config"]:  # describer settings lived under `ollama` before other providers existed
        p["config"]["describer"] = describer_config(p["config"])
        p["config"].pop("ollama")
        write_json(d / "config.json", p["config"])
    for name, default in (("prs", []), ("stage1", {}), ("stage2", {}), ("runs", []), ("issues", {}), ("forks", {}),
                          ("rivals", {}), ("stack", {}), ("map", {})):
        p[name] = read_json(d / f"{name}.json", default)
    p["prs"] = {x["number"]: x for x in p["prs"]} if isinstance(p["prs"], list) else {int(k): v for k, v in p["prs"].items()}
    projects[slug] = p
    p["included"] = load_included(p["config"])
    recompute(slug)


def load_included(cfg):
    nums = set(cfg.get("stack_prs") or [])
    if cfg.get("stack_prs_url"):
        try:
            with urllib.request.urlopen(cfg["stack_prs_url"], timeout=15) as r:
                text = r.read().decode()
            nums |= {int(m) for m in re.findall(r"^\s*(\d+)", re.sub(r"#.*", "", text), re.M)}
        except Exception:
            pass
    return nums


def recompute(slug):
    with lock:
        P = projects[slug]
        cfg, now, rows = P["config"], dt.datetime.now(dt.timezone.utc), {}
        for n, pr in P["prs"].items():
            res = P["stage1"].get(str(n))
            base = {k: pr.get(k) for k in ("number", "title", "author", "updated", "additions", "deletions", "issues")}
            base.update(files=len(pr["files"]), included=n in P["included"], classified=bool(res), ai_description=bool(pr.get("ai_description")))
            if res:
                base.update(score_pr(pr, res["answers"], now))
            rows[n] = base
        classified = [r for r in rows.values() if r["classified"]]
        mark_duplicates(classified, P["included"])
        ranked = sorted(classified, key=lambda r: -r["score"])
        for i, r in enumerate(ranked, 1):
            r["rank"] = i
        finalists = [r["number"] for r in ranked if r["track"] in ("fix", "feature") and not r["duplicate_of"]
                     and not r["included"] and r["relevance"] >= 1.5][: cfg.get("finalists", 120)]
        for n in finalists:
            rows[n]["finalist"] = True
            s2 = P["stage2"].get(str(n))
            if s2:
                rows[n].update(verdict(rows[n], s2))
        P["rows"], P["finalists"] = rows, finalists
        P["issue_rows"] = issue_rows(P)
        P["fork_rows"] = fork_rows(P)


def issue_rows(P):
    """Rows for the open issues: who is already fixing them, and what Jev thinks of them."""
    covered, mentioned = {}, {}
    for n, pr in P["prs"].items():
        for i in pr.get("issues") or []:
            covered.setdefault(i, []).append(n)
        for i in {int(x) for x in re.findall(r"#(\d+)", pr.get("body") or "")}:
            mentioned.setdefault(i, []).append(n)
    rows = {}
    for k, v in (P.get("issues") or {}).items():
        meta, res = v.get("meta"), v.get("answers")
        if not meta:
            continue
        row = {kk: meta.get(kk) for kk in ("number", "title", "author", "created", "updated", "comments", "labels")}
        row.update(classified=bool(res), open_pr=sorted(covered.get(meta["number"]) or []), kind_label=None)
        if res:
            row.update(score_issue(meta, res, has_pr=bool(covered.get(meta["number"])), mentioned_by=mentioned.get(meta["number"]) or ()))
            row["kind_label"] = ISSUE_KIND_LABELS.get(row.get("kind"), row.get("kind"))
        rows[meta["number"]] = row
    ranked = sorted([r for r in rows.values() if r["classified"]], key=lambda r: -r["score"])
    for i, r in enumerate(ranked, 1):
        r["rank"] = i
    return rows


def fork_rows(P):
    """Rows for the forks that carry commits upstream does not have."""
    rows = {}
    for k, v in (P.get("forks") or {}).items():
        if not v.get("scanned"):
            continue
        row = {kk: v.get(kk) for kk in ("fork", "owner", "branch", "pushed", "stars", "ahead", "behind", "lines",
                                        "status", "truncated", "commits", "files", "note")}
        row["classified"] = bool(v.get("answers"))
        if v.get("answers"):
            row.update(score_fork(v, v["answers"]))
            row["kind_label"] = FORK_KIND_LABELS.get(row.get("kind"), row.get("kind"))
        rows[k] = row
    mark_fork_clusters(rows)
    ranked = sorted([r for r in rows.values() if r["classified"] and not r.get("duplicate_of")], key=lambda r: -r["score"])
    for i, r in enumerate(ranked, 1):
        r["rank"] = i
    return rows


def mark_fork_clusters(rows):
    """Форки с одинаковым набором коммитов впереди — одна линия работы, размноженная по форкам.

    На живых данных это не редкость: пять форков несли буквально одни и те же мержи
    («Merge pull request #8 from numman-ali/…», «#31 from tylerwince/…») и получали
    похожие баллы. Считаем их одним кандидатом: представителем становится лучший по
    баллу, остальные помечаются duplicate_of — как mark_duplicates делает для PR.
    """
    groups = {}
    for r in rows.values():
        if not r.get("classified"):
            continue
        msgs = sorted(c.get("message", "") for c in (r.get("commits") or []) if c.get("message"))
        if not msgs:
            continue
        groups.setdefault(hashlib.sha1("\n".join(msgs).encode()).hexdigest()[:12], []).append(r)
    for key, members in groups.items():
        if len(members) < 2:
            continue
        best = max(members, key=lambda r: (r.get("score") or 0, r.get("stars") or 0, r.get("pushed") or ""))
        for r in members:
            r["cluster"] = key
            r["cluster_size"] = len(members)
            r["duplicate_of"] = None if r is best else best["fork"]


def get_project(slug):
    if slug not in projects:
        raise HTTPException(404, "Проект не найден")
    return projects[slug]


@app.on_event("startup")
async def startup():
    global loop
    loop = asyncio.get_running_loop()
    migrate_legacy()
    for d in sorted((DATA / "projects").glob("*")):
        load_project(d.name)


# ---------- auth ----------
@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if PASSWORD and request.url.path != "/healthz":
        header, ok = request.headers.get("authorization", ""), False
        if header.startswith("Basic "):
            try:
                ok = secrets.compare_digest(base64.b64decode(header[6:]).decode().split(":", 1)[1], PASSWORD)
            except Exception:
                ok = False
        if not ok:
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="PR Scout"'})
    return await call_next(request)


# ---------- events / jobs ----------
def emit(event):
    if loop is not None:
        for q in list(listeners):
            loop.call_soon_threadsafe(q.put_nowait, event)


def progress(done, total, number=None, **extra):
    with lock:
        job["done"], job["total"] = done, total
    emit({"type": "progress", "project": job["project"], "done": done, "total": total, "number": number, **extra})


def run_job(name, slug, steps):
    with lock:
        if job["running"]:
            raise HTTPException(409, f"Уже идёт задача: {job['running']}")
        job.update(running=name, project=slug, done=0, total=0, started=time.time())
    emit({"type": "start", "job": name, "project": slug})

    def wrapper():
        try:
            for step in steps:
                with lock:
                    job["running"] = step.__name__.replace("_job", "")
                emit({"type": "step", "job": job["running"], "project": slug})
                stats = step(slug)
                if stats:
                    with lock:
                        projects[slug]["runs"].append(stats)
                        save(slug, "runs")
            emit({"type": "done", "job": name, "project": slug, "stats": stats})
        except Exception as e:
            emit({"type": "error", "job": name, "project": slug, "message": str(e)[:500]})
        finally:
            with lock:
                job.update(running=None, project=None)
    threading.Thread(target=wrapper, daemon=True).start()


def now_iso():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


# ---------- external calls ----------
def http_json(url, data=None, headers=None, timeout=120):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


RETRY_CODES = (429, 500, 502, 503, 504, 529)


def backoff(attempt, cap=45.0):
    """Exponential pause with jitter, so parallel workers do not retry in lockstep."""
    time.sleep(min(cap, 1.5 * 2 ** attempt) * (1 + random.random() * 0.4))


def http_json_retry(url, data=None, headers=None, timeout=120, tries=8):
    """Same as http_json but survives rate limits and transient resolver/network blips.

    Docker's embedded DNS occasionally answers `No address associated with hostname`
    for a second or two, and long runs also meet plain connection resets.
    """
    for attempt in range(tries):
        try:
            return http_json(url, data, headers, timeout)
        except urllib.error.HTTPError as e:
            if e.code not in RETRY_CODES or attempt == tries - 1:
                raise
            backoff(attempt)
        except Exception:
            if attempt == tries - 1:
                raise
            backoff(attempt)


def git_fetch(repo, *args, tries=4):
    """`git fetch` with retries: the network fails far more often than local git."""
    r = None
    for attempt in range(tries):
        r = subprocess.run(["git", "-C", str(repo), "fetch", "-q", "--no-tags", *args], capture_output=True, text=True)
        if r.returncode == 0:
            return r
        if attempt < tries - 1:
            backoff(attempt, cap=20.0)
    return r


def fetch_prs(repo, numbers, failed=None):
    """Fetch `pull/N/head` into `pr-N` for every number, in parallel and with retries.

    `+` forces the update: authors force-push, and a rewritten branch would otherwise fail
    the fetch on every rerun. Numbers that could not be fetched land in `failed` (if given).
    """
    def one(n):
        return n, git_fetch(repo, "origin", f"+pull/{n}/head:pr-{n}").returncode != 0
    with cf.ThreadPoolExecutor(MERGE_WORKERS) as ex:
        for n, bad in ex.map(one, numbers):
            if bad:
                if failed is not None:
                    failed[n] = {"merge": "fetch_failed", "conflicts": []}
                emit({"type": "log", "message": f"#{n}: ветку PR не удалось скачать"})


def open_worktrees(repo, prefix, sha):
    """Detached worktrees of `repo` at `sha`, one per parallel git worker, handed out through a queue."""
    subprocess.run(["git", "-C", str(repo), "worktree", "prune"], capture_output=True, text=True)
    pool, made = Queue(), []
    for i in range(max(1, MERGE_WORKERS)):
        wt = repo.parent / f"{prefix}-{i}"
        if wt.exists():
            subprocess.run(["git", "-C", str(repo), "worktree", "remove", "--force", str(wt)], capture_output=True, text=True)
            shutil.rmtree(wt, ignore_errors=True)
        r = subprocess.run(["git", "-C", str(repo), "worktree", "add", "--detach", "--force", str(wt), sha], capture_output=True, text=True)
        if r.returncode:
            emit({"type": "log", "message": f"worktree {wt.name} не создался: {r.stderr[-200:]}"})
            continue
        made.append(wt)
        pool.put(wt)
    if not made:
        raise RuntimeError("Не удалось создать ни одной рабочей копии git (worktree) для тестовых мержей")
    return pool, made


def close_worktrees(repo, made):
    for wt in made:
        subprocess.run(["git", "-C", str(repo), "worktree", "remove", "--force", str(wt)], capture_output=True, text=True)
    subprocess.run(["git", "-C", str(repo), "worktree", "prune"], capture_output=True, text=True)


def jev(state_value, questions, tries=8):
    """Ask Jev typed questions; never raises, a failure comes back as {"error": ...}.

    Retries 429/5xx and network errors with backoff. NordRouter knows yes/no questions
    as `boolean` and answers them with `probability`, TypeSafe calls both `noul`: the
    questions are written for TypeSafe and translated at this boundary.
    """
    payload = {"model": JEV_MODEL, "state": state_value, "questions": to_provider(questions)}
    headers = {"Authorization": f"Bearer {JEV_KEY}", "Content-Type": "application/json"}
    for attempt in range(tries):
        try:
            res = http_json(JEV_URL, payload, headers, 180)
            if res.get("answers"):
                res["answers"] = from_provider(res["answers"])
            return res
        except urllib.error.HTTPError as e:
            if e.code not in RETRY_CODES or attempt == tries - 1:
                return {"error": f"HTTP {e.code}"}
        except Exception as e:
            if attempt == tries - 1:
                return {"error": f"retries exhausted: {str(e)[:120]}"}
        backoff(attempt)
    return {"error": "retries exhausted"}


def to_provider(questions):
    """`noul` -> `boolean` for NordRouter; TypeSafe gets the questions as written."""
    if JEV_PROVIDER != "nordrouter":
        return questions
    return {name: {**q, "type": "boolean"} if q.get("type") == "noul" else q for name, q in questions.items()}


def from_provider(answers):
    """NordRouter's `boolean` answers carry `probability`; expose it as `noul` like TypeSafe does."""
    return {name: {**a, "noul": a["probability"]} if a.get("type") == "boolean" and "probability" in a else a
            for name, a in answers.items()}


def gh_rest(path, timeout=60, tries=6):
    """GitHub REST GET that respects the rate limit instead of dying on it.

    Reads X-RateLimit-Remaining/Reset on every answer and sleeps until the window
    rolls over when the budget is nearly gone: a fork walk over 15k repos needs
    several hourly windows and must survive them. Waiting for the window does not
    use up a retry. Answers that will not change on a retry (a deleted fork, no
    common history) come back as {"error": "HTTP <code>"}.
    """
    attempt = 0
    while True:
        try:
            req = urllib.request.Request(f"https://api.github.com{path}", headers=gh_headers())
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode())
                remaining, reset = r.headers.get("X-RateLimit-Remaining"), r.headers.get("X-RateLimit-Reset")
            if remaining is not None and reset and int(remaining) < 100:
                wait = max(5, int(reset) - int(time.time()) + 5)
                emit({"type": "log", "message": f"GitHub REST: осталось {remaining} запросов, пауза {wait} с до сброса окна"})
                time.sleep(wait)
            return data
        except urllib.error.HTTPError as e:
            headers = e.headers or {}
            reset, remaining = headers.get("X-RateLimit-Reset"), headers.get("X-RateLimit-Remaining")
            if e.code == 429 or (e.code == 403 and remaining == "0"):
                wait = max(5, int(reset) - int(time.time()) + 5) if reset else 60
                emit({"type": "log", "message": f"лимит GitHub исчерпан (HTTP {e.code}), пауза {wait} с"})
                time.sleep(wait)
                continue
            if e.code in (404, 409, 422, 451):
                return {"error": f"HTTP {e.code}"}
            attempt += 1
            if attempt >= tries:
                raise
            backoff(attempt, cap=30.0)
        except Exception:
            attempt += 1
            if attempt >= tries:
                raise
            backoff(attempt, cap=30.0)


def gh_headers(extra=None):
    h = {"Accept": "application/vnd.github+json", **(extra or {})}
    if GH_TOKEN:
        h["Authorization"] = f"Bearer {GH_TOKEN}"
    return h


GQL = """query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){
 defaultBranchRef{name}
 pullRequests(states:OPEN,first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
  pageInfo{hasNextPage endCursor}
  nodes{number title body isDraft createdAt updatedAt additions deletions authorAssociation author{login}
   files(first:100){nodes{path}} closingIssuesReferences(first:10){nodes{number}}}}}}"""


def clean_body(body):
    body = re.sub(r"<!--.*?-->|- \[[ x]\] .*|## Checklist.*|## Model Used.*?(?=\n## |\Z)", "", body or "", flags=re.S | re.I)
    return re.sub(r"\n{3,}", "\n\n", body).strip()[:3500]


# ---------- jobs ----------
def fetch_job(slug):
    if not GH_TOKEN:
        raise RuntimeError("Нужен GITHUB_TOKEN (токен GitHub без прав, только чтение публичных репозиториев)")
    P, t0, started = projects[slug], time.time(), now_iso()
    cfg = P["config"]
    owner, name = cfg["repo"].split("/")
    prs, cursor, page = {}, None, 0
    while True:
        res = http_json_retry("https://api.github.com/graphql", {"query": GQL, "variables": {"owner": owner, "name": name, "cursor": cursor}},
                              gh_headers({"Content-Type": "application/json"}), 120)
        if res.get("errors"):
            raise RuntimeError("GitHub: " + "; ".join(e.get("message", "") for e in res["errors"])[:300])
        repo = res["data"]["repository"]
        if not repo:
            raise RuntimeError("Репозиторий не найден или приватный")
        cfg["default_branch"] = (repo.get("defaultBranchRef") or {}).get("name") or "main"
        conn = repo["pullRequests"]
        for p in conn["nodes"]:
            author = (p.get("author") or {}).get("login") or "ghost"
            if p["isDraft"] and not cfg.get("include_drafts"):
                continue
            if author in cfg.get("exclude_authors", []):
                continue
            if cfg.get("community_only") and p["authorAssociation"] in ("OWNER", "MEMBER", "COLLABORATOR"):
                continue
            old = P["prs"].get(p["number"], {})
            prs[p["number"]] = {"number": p["number"], "title": p["title"], "author": author, "created": p["createdAt"], "updated": p["updatedAt"],
                                "additions": p["additions"], "deletions": p["deletions"], "files": [f["path"] for f in p["files"]["nodes"]],
                                "issues": [i["number"] for i in p["closingIssuesReferences"]["nodes"]], "body": clean_body(p["body"]),
                                "association": p["authorAssociation"],
                                **({"ai_description": old["ai_description"]} if old.get("ai_description") and old.get("updated") == p["updatedAt"] else {})}
        page += 1
        progress(len(prs), len(prs), phase="list", page=page)
        if not conn["pageInfo"]["hasNextPage"]:
            break
        cursor = conn["pageInfo"]["endCursor"]
    with lock:
        P["prs"] = prs
        if not cfg.get("custom_areas"):
            cfg["areas"], cfg["area_labels"] = auto_areas(prs.values())
        write_json(pdir(slug) / "config.json", cfg)
        save_prs(slug)
        P["included"] = load_included(cfg)
    recompute(slug)
    return {"stage": "fetch", "started": started, "seconds": round(time.time() - t0), "items": len(prs), "errors": 0, "input_tokens": 0, "cost_usd": 0, "model": "GitHub GraphQL"}


def save_prs(slug):
    write_json(pdir(slug) / "prs.json", list(projects[slug]["prs"].values()))


def describer_config(cfg):
    """The project's describer settings; projects saved before providers existed kept them under `ollama`."""
    d = dict(cfg.get("describer") or cfg.get("ollama") or {})
    d.setdefault("provider", "ollama")
    return d


def describe_job(slug):
    """Write a description from the diff when the author wrote little or nothing.

    Any LLM provider from llm.py writes it: a local Ollama or an OpenAI-compatible endpoint
    (NordRouter, OpenRouter, OpenAI, a custom one), chosen per project in `describer`.
    """
    P, t0, started = projects[slug], time.time(), now_iso()
    cfg = P["config"]
    dc = describer_config(cfg)
    if not dc.get("enabled"):
        return None
    prov = llm.get(dc["provider"])
    if not llm.is_ready(prov):
        raise RuntimeError(f"Для описаний через {prov['name']} нужен {prov['key_env']}")
    model = dc.get("model") or prov.get("model")
    if not model:
        raise RuntimeError(f"Не выбрана модель {prov['name']} для описаний: задайте её в настройках проекта")
    if not GH_TOKEN:
        raise RuntimeError("Для описаний нужен GITHUB_TOKEN (скачиваю дифы)")
    todo = [p for p in P["prs"].values() if len(p.get("body") or "") < dc.get("min_body", 200) and not p.get("ai_description")]
    out_tokens, errors = 0, 0
    progress(0, len(todo), phase="describe")

    def one(pr):
        req = urllib.request.Request(f"https://api.github.com/repos/{cfg['repo']}/pulls/{pr['number']}", headers=gh_headers({"Accept": "application/vnd.github.diff"}))
        with urllib.request.urlopen(req, timeout=60) as r:
            diff = r.read().decode(errors="ignore")[: dc.get("max_diff", 24000)]
        prompt = ("You review a GitHub pull request whose author wrote little or no description. From the title and the diff, "
                  "write a plain English description in 3-5 sentences: what problem it fixes or what it adds, and what the change does. "
                  f"No headings, no bullet points.\n\nTitle: {pr['title']}\n\nAuthor's text: {pr.get('body') or '(none)'}\n\nDiff:\n{diff}")
        text, tokens = llm.complete(prov, model, prompt, max_tokens=dc.get("max_tokens", 400), retry=http_json_retry)
        if not text:
            raise RuntimeError("модель вернула пустой ответ")
        return pr["number"], text, tokens

    done = 0
    # a local model serves one or two requests at a time; a cloud endpoint takes many
    with cf.ThreadPoolExecutor(2 if prov["kind"] == "ollama" else DESCRIBER_WORKERS) as ex:
        for fut in cf.as_completed([ex.submit(one, p) for p in todo]):
            done += 1
            try:
                n, text, toks = fut.result()
                out_tokens += toks
                with lock:
                    P["prs"][n]["ai_description"] = text
                progress(done, len(todo), n, phase="describe", seconds=round(time.time() - t0, 1), preview=text[:160], title=P["prs"][n]["title"])
            except Exception as e:
                errors += 1
                progress(done, len(todo), phase="describe", error=str(e)[:120])
            if done % 20 == 0:
                with lock:
                    save_prs(slug)
    with lock:
        save_prs(slug)
    recompute(slug)
    return {"stage": "describe", "started": started, "seconds": round(time.time() - t0), "items": len(todo), "errors": errors,
            "input_tokens": 0, "output_tokens": out_tokens, "cost_usd": 0, "model": f"{prov['name']} · {model}",
            "local": prov["kind"] == "ollama"}


def stage1_job(slug, limit=None):
    P, t0, started = projects[slug], time.time(), now_iso()
    questions = stage1_questions(P["config"])
    prs = list(P["prs"].values())[: limit or None]
    tokens, done, errors = 0, 0, 0
    progress(0, len(prs), phase="stage1")
    with cf.ThreadPoolExecutor(STAGE1_WORKERS) as ex:
        futures = {ex.submit(jev, stage1_state(p), questions): p["number"] for p in prs}
        for fut in cf.as_completed(futures):
            n, res = futures[fut], fut.result()
            done += 1
            row = None
            if "answers" in res:
                tokens += res["usage"]["input_tokens"]
                with lock:
                    P["stage1"][str(n)] = {"answers": res["answers"], "usage": res["usage"]}
                    row = {**P["rows"].get(n, {}), **score_pr(P["prs"][n], res["answers"])}
            else:
                errors += 1
            progress(done, len(prs), n, phase="stage1", row=row, tokens=tokens, cost=round(tokens * PRICE_PER_MTOK / 1e6, 4), seconds=round(time.time() - t0, 1))
    with lock:
        save(slug, "stage1")
    recompute(slug)
    return {"stage": "stage1", "started": started, "seconds": round(time.time() - t0), "items": len(prs), "errors": errors,
            "input_tokens": tokens, "cost_usd": round(tokens * PRICE_PER_MTOK / 1e6, 4), "model": JEV_LABEL}


SKIP_FILE = re.compile(r"(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|\.snap$|\.svg$|\.png$|\.lock$|/dist/|generated)")


def stage2_job(slug):
    P, t0, started = projects[slug], time.time(), now_iso()
    cfg = P["config"]
    repo = pdir(slug) / "repo"

    def git(*args, check=False):
        r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
        if check and r.returncode:
            raise RuntimeError(f"git {' '.join(args)}: {r.stderr[-300:]}")
        return r

    recompute(slug)
    finalists, base = list(P["finalists"]), cfg.get("default_branch", "main")
    progress(0, len(finalists), phase="git")
    if not (repo / ".git").exists():
        emit({"type": "log", "message": "Клонирую репозиторий (один раз, пару минут)…"})
        subprocess.run(["git", "clone", "--filter=blob:none", "--no-tags", f"https://github.com/{cfg['repo']}.git", str(repo)], check=True, capture_output=True)
    git("config", "user.email", "scout@localhost"); git("config", "user.name", "PR Scout")
    git("merge", "--abort"); git("reset", "-q", "--hard"); git("clean", "-fdq")
    git("fetch", "-q", "--no-tags", "origin", base, check=True)
    git("checkout", "-q", "-B", "stack", f"origin/{base}", check=True)
    for n in sorted(P["included"]):
        git_fetch(repo, "origin", f"+pull/{n}/head:pr-{n}")
        if git("merge", "-q", "--no-ff", "--no-edit", f"pr-{n}").returncode:
            git("merge", "--abort")
            emit({"type": "log", "message": f"#{n} из «уже взятых» не вливается в свежую {base}"})
    merges, diffs = {}, {}
    # PR branches are fetched in parallel: 120 fetches one after another are minutes of network wait.
    # `+` because authors force-push: without it a rewritten branch fails the fetch on every rerun.
    fetch_prs(repo, finalists, merges)

    # Every finalist's test merge runs in a worktree of its own: parallel merges in one tree
    # would trample each other.
    stack_sha = git("rev-parse", "stack").stdout.strip()
    pool, worktrees = open_worktrees(repo, "merge", stack_sha)

    def wgit(wt, *args):
        return subprocess.run(["git", "-C", str(wt), *args], capture_output=True, text=True)

    def test_merge(args):
        i, n = args
        if n in merges:  # ветка не скачалась
            progress(i, len(finalists), n, phase="merge", merge=merges[n]["merge"])
            return n, merges[n], diff_of(n)
        wt = pool.get()
        try:
            wgit(wt, "reset", "-q", "--hard", stack_sha)
            wgit(wt, "clean", "-fdq")
            m = wgit(wt, "merge", "--no-commit", "--no-ff", f"pr-{n}")
            conflicts = wgit(wt, "diff", "--name-only", "--diff-filter=U").stdout.split() if m.returncode else []
            wgit(wt, "merge", "--abort")
            wgit(wt, "reset", "-q", "--hard", stack_sha)
            wgit(wt, "clean", "-fdq")
            res = {"merge": "clean" if m.returncode == 0 else ("conflict" if conflicts else "error"), "conflicts": conflicts[:10],
                   **({"message": (m.stderr or m.stdout)[-240:]} if m.returncode and not conflicts else {})}
        finally:
            pool.put(wt)
        progress(i, len(finalists), n, phase="merge", merge=res["merge"])
        return n, res, diff_of(n)

    def diff_of(n):
        """Diff of the PR against its merge base. Read-only: safe to run in parallel."""
        mb = git("merge-base", f"origin/{base}", f"pr-{n}").stdout.strip()
        chunks = [c for c in re.split(r"(?=^diff --git )", git("diff", mb, f"pr-{n}").stdout if mb else "", flags=re.M)
                  if c.strip() and not SKIP_FILE.search(c.split("\n", 1)[0])]
        chunks.sort(key=lambda c: ("test" in c.split("\n", 1)[0].lower(), len(c)))
        text = ""
        for c in chunks:
            if len(text) + len(c) <= 90_000:
                text += c
        return text or "(empty diff)"

    try:
        with cf.ThreadPoolExecutor(max(1, len(worktrees))) as ex:
            for n, res, text in ex.map(test_merge, [(i, n) for i, n in enumerate(finalists, 1)]):
                merges[n], diffs[n] = res, text
    finally:
        close_worktrees(repo, worktrees)

    def ci_status(n, previous):
        if not GH_TOKEN:
            return previous
        try:
            runs = http_json(f"https://api.github.com/repos/{cfg['repo']}/commits/{git('rev-parse', f'pr-{n}').stdout.strip()}/check-runs?per_page=100", headers=gh_headers(), timeout=30)["check_runs"]
        except Exception:
            return previous
        failing = [c["name"] for c in runs if c.get("conclusion") in ("failure", "timed_out")]
        return {"pass": sum(c.get("conclusion") == "success" for c in runs), "fail": len(failing),
                "pending": sum(c.get("status") != "completed" for c in runs), "failing": failing[:12], "none": not runs}

    tokens, done = 0, 0
    def review(n):
        pr = P["prs"][n]
        return n, jev({"title": pr["title"], "description": (pr.get("body") or pr.get("ai_description") or "")[:1500], "diff": diffs.get(n, "(no diff)")}, STAGE2_QUESTIONS)
    with cf.ThreadPoolExecutor(STAGE2_WORKERS) as ex:
        for n, res in ex.map(review, finalists):
            done += 1
            if "answers" in res:
                tokens += res["usage"]["input_tokens"]
                with lock:
                    prev = P["stage2"].get(str(n), {})
                    P["stage2"][str(n)] = {"merge": merges[n], "ci": ci_status(n, prev.get("ci")), "review": {"answers": res["answers"], "usage": res["usage"]}}
            progress(done, len(finalists), n, phase="review", tokens=tokens, seconds=round(time.time() - t0, 1))
    with lock:
        save(slug, "stage2")
    recompute(slug)
    return {"stage": "stage2", "started": started, "seconds": round(time.time() - t0), "items": len(finalists), "errors": 0,
            "input_tokens": tokens, "cost_usd": round(tokens * PRICE_PER_MTOK / 1e6, 4), "model": JEV_LABEL}


# ---------- issues, forks, rivals: the same Jev, three more questions ----------
GQL_ISSUES = """query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){
 issues(states:OPEN,first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
  pageInfo{hasNextPage endCursor}
  nodes{number title body createdAt updatedAt comments{totalCount} authorAssociation author{login}
   labels(first:10){nodes{name}}}}}}"""

def fetch_issues_job(slug):
    """All open issues of the upstream repository (metadata only, no Jev yet)."""
    P, t0, started = projects[slug], time.time(), now_iso()
    cfg, owner, name = P["config"], *P["config"]["repo"].split("/")
    excluded = set(cfg.get("exclude_authors") or [])
    issues, cursor, page = {}, None, 0
    while True:
        res = http_json_retry("https://api.github.com/graphql", {"query": GQL_ISSUES, "variables": {"owner": owner, "name": name, "cursor": cursor}},
                              gh_headers({"Content-Type": "application/json"}), 120)
        if res.get("errors"):
            raise RuntimeError("GitHub: " + "; ".join(e.get("message", "") for e in res["errors"])[:300])
        conn = (res.get("data") or {}).get("repository", {}).get("issues")
        if not conn:
            raise RuntimeError("Репозиторий не найден или приватный")
        for i in conn["nodes"]:
            author = (i.get("author") or {}).get("login") or "ghost"
            if author in excluded:
                continue
            issues[i["number"]] = {"number": i["number"], "title": i["title"], "body": clean_body(i["body"]), "author": author,
                                   "association": i["authorAssociation"], "created": i["createdAt"], "updated": i["updatedAt"],
                                   "comments": i["comments"]["totalCount"], "labels": [x["name"] for x in i["labels"]["nodes"]]}
        page += 1
        progress(len(issues), len(issues), phase="issues-list", page=page)
        if not conn["pageInfo"]["hasNextPage"]:
            break
        cursor = conn["pageInfo"]["endCursor"]
    with lock:
        old = P.get("issues") or {}
        P["issues"] = {str(n): {**old.get(str(n), {}), "meta": m} for n, m in issues.items()}
        save(slug, "issues")
    recompute(slug)
    return {"stage": "issues-list", "started": started, "seconds": round(time.time() - t0), "items": len(issues), "errors": 0,
            "input_tokens": 0, "cost_usd": 0, "model": "GitHub GraphQL"}


def issues_job(slug):
    """Ask Jev what every open issue is and how much it hurts — including issues no PR touches."""
    P, t0, started = projects[slug], time.time(), now_iso()
    questions = issue_questions(P["config"])
    todo = [n for n, v in P["issues"].items() if v.get("meta")]
    covered = {i for pr in P["prs"].values() for i in pr.get("issues") or []}
    tokens, done, errors = 0, 0, 0
    progress(0, len(todo), phase="issues")
    with cf.ThreadPoolExecutor(STAGE1_WORKERS) as ex:
        futures = {ex.submit(jev, {"repo": P["config"]["repo"], "number": v["meta"]["number"], "title": v["meta"]["title"],
                                   "labels": v["meta"]["labels"], "created": v["meta"]["created"], "comments": v["meta"]["comments"],
                                   "description": (v["meta"]["body"] or "(no description)")[:2500]}, questions): int(n)
                   for n, v in ((n, v) for n, v in P["issues"].items() if v.get("meta"))}
        for fut in cf.as_completed(futures):
            n, res = futures[fut], fut.result()
            done += 1
            issue = None
            if "answers" in res:
                tokens += res["usage"]["input_tokens"]
                with lock:
                    P["issues"][str(n)]["answers"] = res["answers"]
                    P["issues"][str(n)]["usage"] = res["usage"]
                    meta = P["issues"][str(n)]["meta"]
                sc = score_issue(meta, res["answers"], has_pr=n in covered)
                issue = {"number": n, "title": meta["title"], "score": sc["score"], "kind_label": ISSUE_KIND_LABELS.get(sc["kind"], sc["kind"]),
                         "has_pr": n in covered}
            else:
                errors += 1
            progress(done, len(todo), n, phase="issues", issue=issue, tokens=tokens, cost=round(tokens * PRICE_PER_MTOK / 1e6, 4),
                     seconds=round(time.time() - t0, 1))
    with lock:
        save(slug, "issues")
    recompute(slug)
    return {"stage": "issues", "started": started, "seconds": round(time.time() - t0), "items": len(todo), "errors": errors,
            "input_tokens": tokens, "cost_usd": round(tokens * PRICE_PER_MTOK / 1e6, 4), "model": JEV_LABEL}


def fetch_forks_job(slug):
    """The fork list — REST pages fetched several at a time.

    GraphQL pages by cursor, so 155 pages of 100 forks went strictly one after another
    (~30 minutes); the same list over parallel REST pages takes about a minute. The
    compare stage that follows is limited by GitHub's 5000 requests/hour, not by this.
    """
    P, t0, started = projects[slug], time.time(), now_iso()
    cfg = P["config"]
    owner, name = cfg["repo"].split("/")
    forks = {}
    page, empty_batches = 1, 0
    while True:
        batch = list(range(page, page + FORK_LIST_WORKERS))
        with cf.ThreadPoolExecutor(len(batch)) as ex:
            answers = list(ex.map(lambda pg: gh_rest(f"/repos/{owner}/{name}/forks?per_page=100&page={pg}&sort=newest"), batch))
        got = 0
        for chunk in answers:
            if not isinstance(chunk, list):
                continue
            got += len(chunk)
            for f in chunk:
                forks[f["full_name"]] = {"fork": f["full_name"], "owner": (f.get("owner") or {}).get("login"),
                                         "pushed": f.get("pushed_at"), "stars": f.get("stargazers_count"),
                                         "branch": f.get("default_branch")}
        progress(len(forks), 0, phase="forks-list", page=batch[-1], seconds=round(time.time() - t0, 1))
        empty_batches = empty_batches + 1 if got == 0 else 0
        if empty_batches:
            break
        page += len(batch)
    with lock:
        old = P.get("forks") or {}
        P["forks"] = {k: {**old.get(k, {}), **v} for k, v in forks.items()}
        save(slug, "forks")
    recompute(slug)
    return {"stage": "forks-list", "started": started, "seconds": round(time.time() - t0), "items": len(forks), "errors": 0,
            "input_tokens": 0, "cost_usd": 0, "model": "GitHub REST (parallel pages)"}


def master_oids(slug, cfg, force=False):
    """Every commit OID of the upstream default branch (cached for a day).

    Если head-коммит форка лежит в этом множестве, у форка нет своей работы: head —
    предок master, значит ahead_by = 0 по определению. Это даёт отсев без compare:
    на живых данных 96% форков (193 из 200) отсеиваются так, и правило не пропускает
    ни одного форка с коммитами впереди (проверено настоящим compare).
    """
    branch = cfg.get("default_branch") or "main"
    cache_path = pdir(slug) / "master_oids.json"
    cache = read_json(cache_path, {}) or {}
    fresh = (cache.get("branch") == branch and cache.get("oids") and not force
             and (time.time() - (cache.get("fetched_at") or 0)) < 86400)
    if fresh:
        return set(cache["oids"])
    owner, name = cfg["repo"].split("/")
    oids, cursor, pages = set(), None, 0
    while pages < 400:
        query = ("query($o:String!,$n:String!,$c:String){repository(owner:$o,name:$n){"
                 "defaultBranchRef{target{... on Commit{history(first:100,after:$c){"
                 "pageInfo{hasNextPage endCursor} nodes{oid}}}}}}}")
        res = http_json_retry("https://api.github.com/graphql", {"query": query, "variables": {"o": owner, "n": name, "c": cursor}},
                              gh_headers({"Content-Type": "application/json"}), 120)
        if res.get("errors") or not res.get("data", {}).get("repository"):
            raise RuntimeError(f"Не смог вычитать историю {branch}: {str(res.get('errors'))[:200]}")
        hist = res["data"]["repository"]["defaultBranchRef"]["target"]["history"]
        oids |= {n["oid"] for n in hist["nodes"]}
        pages += 1
        progress(len(oids), 0, phase="forks-history", branch=branch)
        if not hist["pageInfo"]["hasNextPage"]:
            break
        cursor = hist["pageInfo"]["endCursor"]
    write_json(cache_path, {"branch": branch, "fetched_at": time.time(), "oids": sorted(oids)})
    return oids


def fork_heads(forks):
    """Head commit of every fork, 50 repositories per GraphQL request.

    One request per 50 forks instead of a compare each: 1200 forks fit in 5 requests, and the
    batches run in parallel. Names and branches go in as variables, never into the query text.
    The answer maps fork -> oid, or None when the repository or its branch is gone; forks
    whose batch failed are left out, so the caller still compares them the slow way.
    """
    batch = 50
    groups = [[f for f in forks[i:i + batch] if f.get("branch")] for i in range(0, len(forks), batch)]
    groups = [g for g in groups if g]
    heads = {}

    def one(group):
        decl, parts, variables = [], [], {}
        for j, f in enumerate(group):
            owner, name = f["fork"].split("/", 1)
            decl.append(f"$o{j}:String!,$n{j}:String!,$b{j}:String!")
            parts.append(f"r{j}:repository(owner:$o{j},name:$n{j}){{object(expression:$b{j}){{...on Commit{{oid}}}}}}")
            variables.update({f"o{j}": owner, f"n{j}": name, f"b{j}": f["branch"]})
        query = f"query({','.join(decl)}){{{' '.join(parts)}}}"
        try:
            res = http_json_retry("https://api.github.com/graphql", {"query": query, "variables": variables},
                                  gh_headers({"Content-Type": "application/json"}), 120)
        except Exception as e:
            emit({"type": "log", "message": f"head-коммиты {len(group)} форков не получены ({str(e)[:120]}), сравню их напрямую"})
            return {}
        data = res.get("data")
        if not isinstance(data, dict):
            return {}
        # A missing repository comes back as a null alias plus a NOT_FOUND error; that is "gone".
        # Any other error (rate limit, timeout) leaves the fork unknown rather than gone.
        failed = {e.get("path", [None])[0] for e in res.get("errors") or [] if e.get("type") != "NOT_FOUND"}
        out = {}
        for j, f in enumerate(group):
            if f"r{j}" in failed:
                continue
            out[f["fork"]] = ((data.get(f"r{j}") or {}).get("object") or {}).get("oid")
        return out

    with cf.ThreadPoolExecutor(FORK_LIST_WORKERS) as ex:
        for chunk in ex.map(one, groups):
            heads.update(chunk)
            progress(len(heads), len(forks), phase="forks-heads")
    return heads


def forks_job(slug):
    """Compare every fork with upstream and classify the deltas — streaming, one fork at a time.

    Каждый форк проходит свою цепочку целиком и сразу: compare → (если есть коммиты впереди) Jev →
    строка в отчёте. Раньше это были две фазы (сначала все 15к compare, потом Jev), и первые
    результаты появлялись только через три часа. Сравнения идут в одном пуле, классификация — в
    другом, через очередь: Jev никогда не ждёт сеть и наоборот.

    Один compare на форк; лимит REST 5000/ч, поэтому проход занимает несколько часовых окон —
    gh_rest спит до сброса окна вместо падения. Прогресс и результаты видны по ходу.
    """
    P, t0, started = projects[slug], time.time(), now_iso()
    cfg = P["config"]
    fcfg = cfg.get("forks") or {}
    owner, name = cfg["repo"].split("/")
    base = cfg.get("default_branch") or "main"
    forks = [f for f in P["forks"].values() if f.get("branch")]
    forks.sort(key=lambda f: f.get("pushed") or "", reverse=True)
    if fcfg.get("limit"):
        forks = forks[: int(fcfg["limit"])]
    if fcfg.get("min_stars"):
        forks = [f for f in forks if (f.get("stars") or 0) >= int(fcfg["min_stars"])]
    todo = [f for f in forks if not f.get("scanned")]
    if not todo:
        return {"stage": "forks", "started": started, "seconds": 0, "items": 0, "errors": 0,
                "input_tokens": 0, "cost_usd": 0, "model": "GitHub compare + Jev"}
    # Отсев до compare: compare стоит один REST-запрос на форк (лимит 5000/ч), а head-коммит
    # через GraphQL стоит 1/50 запроса. Если head уже в истории master — своей работы у форка
    # нет (ahead_by = 0 по определению), compare и Jev не нужны. На живых данных так
    # отсеивается 96% форков.
    filtered = {}
    if fcfg.get("prefilter", True):
        oids = master_oids(slug, cfg)
        heads = fork_heads(todo)
        skip, gone = [], []
        for f in todo:
            if f["fork"] not in heads:   # unknown: its batch failed, compare it
                continue
            oid = heads[f["fork"]]
            if oid and oid in oids:
                skip.append(f)
            elif not oid:
                gone.append(f)
        with lock:
            for f in skip:
                P["forks"][f["fork"]].update({"ahead": 0, "behind": None, "commits": [], "files": [], "lines": 0,
                                              "status": "up-to-date", "scanned": now_iso(),
                                              "note": "head-коммит уже в истории upstream — своей работы нет"})
            for f in gone:
                P["forks"][f["fork"]].update({"ahead": 0, "behind": None, "commits": [], "files": [], "lines": 0,
                                              "status": "gone", "scanned": now_iso(),
                                              "note": "репозиторий удалён или ветка недоступна"})
            save(slug, "forks")
        drop = {f["fork"] for f in skip} | {f["fork"] for f in gone}
        filtered = {"up_to_date": len(skip), "gone": len(gone), "history_commits": len(oids)}
        emit({"type": "log", "message": f"Отсев форков без compare: {len(skip)} без своей работы "
                                        f"(head в истории {len(oids)} коммитов master), {len(gone)} удалённых; "
                                        f"осталось проверить {len(todo) - len(drop)}"})
        todo = [f for f in todo if f["fork"] not in drop]
    if not todo:
        recompute(slug)
        return {"stage": "forks", "started": started, "seconds": round(time.time() - t0), "items": 0, "errors": 0,
                "input_tokens": 0, "cost_usd": 0, "model": "GitHub (отсев без compare)", **filtered}
    questions = fork_questions(cfg)
    queue: Queue = Queue(maxsize=max(8, FORK_REST_WORKERS * 8))
    stat = {"compared": 0, "classified": 0, "tokens": 0, "errors": 0, "ahead": 0}
    t_stream = time.time()

    def note():
        progress(stat["compared"], len(todo), phase="forks", ahead=stat["ahead"], classified=stat["classified"],
                 tokens=stat["tokens"], cost=round(stat["tokens"] * PRICE_PER_MTOK / 1e6, 4), seconds=round(time.time() - t_stream, 1))

    def compare(f):
        fork_owner = f["fork"].split("/")[0]
        # per_page caps the answer: compare returns up to 250 commits and 300 files,
        # and all we need are the counts and the commit subjects.
        path = f"/repos/{owner}/{name}/compare/{base}...{fork_owner}:{f['branch']}?per_page={int(fcfg.get('max_commits', 30))}"
        try:
            res = gh_rest(path)
        except Exception as e:  # one broken fork must not end a walk over thousands
            res = {"error": f"ошибка сети: {str(e)[:80]}"}
        if res.get("error"):
            return f, {"status": res["error"], "ahead": 0, "behind": 0, "commits": [], "files": [], "lines": 0}
        commits = [{"sha": c["sha"][:8], "date": (c.get("commit", {}).get("author") or {}).get("date", "")[:10],
                    "message": (c.get("commit", {}).get("message") or "").split("\n")[0][:200]} for c in (res.get("commits") or [])]
        lines = sum((x.get("additions") or 0) + (x.get("deletions") or 0) for x in (res.get("files") or []))
        return f, {"status": res.get("status"), "ahead": res.get("ahead_by", 0), "behind": res.get("behind_by", 0),
                   "truncated": bool(res.get("total_commits", 0) > len(commits)),
                   "commits": commits[-int(fcfg.get("max_commits", 30)):], "files": [x["filename"] for x in (res.get("files") or [])][:20],
                   "lines": lines, "scanned": now_iso()}

    def classify():
        """Второй пул: Jev по дельте форка, сразу за сравнением."""
        while True:
            item = queue.get()
            try:
                if item is None:
                    return
                f, res = item
                ans = jev({"repo": cfg["repo"], "fork": f["fork"], "behind_upstream_by": res.get("behind"),
                           "commits": res["commits"], "files": res["files"]}, questions)
                with lock:
                    if "answers" in ans:
                        P["forks"][f["fork"]]["answers"] = ans["answers"]
                        P["forks"][f["fork"]]["usage"] = ans["usage"]
                        stat["classified"] += 1
                        stat["tokens"] += ans["usage"]["input_tokens"]
                        row = score_fork(P["forks"][f["fork"]], ans["answers"])
                        row["kind_label"] = FORK_KIND_LABELS.get(row["kind"], row["kind"])
                    else:
                        P["forks"][f["fork"]]["error"] = ans.get("error", "ошибка Jev")
                        stat["errors"] += 1
                        row = None
                emit({"type": "fork", "project": slug, "fork": f["fork"], "ahead": res.get("ahead"),
                      "score": (row or {}).get("score"), "kind": (row or {}).get("kind_label"),
                      "commits": [c["message"] for c in res["commits"][-3:]], "done": stat["compared"], "total": len(todo)})
            except Exception as e:
                with lock:
                    stat["errors"] += 1
                emit({"type": "log", "message": f"форк {item[0]['fork'] if item else '?'}: {str(e)[:160]}"})
            finally:
                queue.task_done()

    consumers = cf.ThreadPoolExecutor(STAGE1_WORKERS, thread_name_prefix="jev")
    consumer_futures = [consumers.submit(classify) for _ in range(STAGE1_WORKERS)]
    try:
        with cf.ThreadPoolExecutor(FORK_REST_WORKERS, thread_name_prefix="compare") as ex:
            for fut in cf.as_completed([ex.submit(compare, f) for f in todo]):
                f, res = fut.result()
                with lock:
                    P["forks"][f["fork"]].update(res)
                    stat["compared"] += 1
                    if (res.get("ahead") or 0) > 0:
                        stat["ahead"] += 1
                if (res.get("ahead") or 0) > 0 and res.get("commits"):
                    queue.put((f, res))  # classified right away; blocks while Jev is behind
                with lock:
                    if stat["compared"] % int(fcfg.get("save_every", 25)) == 0:
                        save(slug, "forks")
                note()
    finally:
        for _ in consumer_futures:
            queue.put(None)
        consumers.shutdown(wait=True)
    with lock:
        save(slug, "forks")
    recompute(slug)
    return {"stage": "forks", "started": started, "seconds": round(time.time() - t0), "items": stat["compared"],
            "errors": stat["errors"], "input_tokens": stat["tokens"], "cost_usd": round(stat["tokens"] * PRICE_PER_MTOK / 1e6, 4),
            "jev_calls": stat["classified"], "model": f"GitHub compare + {JEV_LABEL}", **filtered}


def hot_map(git, base, commits=400):
    """Частота правок по файлам в основной ветке — «горячесть» файла для будущих конфликтов."""
    hot = {}
    for line in git("log", "-n", str(commits), "--name-only", "--pretty=format:", base).stdout.splitlines():
        line = line.strip()
        if line:
            hot[line] = hot.get(line, 0) + 1
    return hot


def map_job(slug):
    """Карта мёрджей: попарная совместимость выживших кандидатов и несколько раскладов из неё.

    Что измеряем попарно:
      * наложение — пересечение множеств файлов (и строк, грубо);
      * совместимость — живой тестовый мерж в обе стороны (A поверх B и B поверх A);
      * приоритет — разница баллов плюс ответ Jev «какой из двух лучше, если брать один»;
      * дубль — вопрос Jev «не одно ли и то же они чинят».
    Из матрицы собираются расклады: безопасный, всё-в-одно, топ-по-баллу, минимум-поверхности
    и по одному на подсистему (см. triage.build_plans).
    """
    P, t0, started = projects[slug], time.time(), now_iso()
    cfg = P["config"]
    mcfg = cfg.get("map") or {}
    repo = pdir(slug) / "repo"
    if not (repo / ".git").exists():
        raise RuntimeError("Нет клона репозитория: сначала нужен этап stage2")
    base_branch = cfg.get("default_branch") or "main"
    base = f"origin/{base_branch}"

    def git(*args, check=False):
        r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
        if check and r.returncode:
            raise RuntimeError(f"git {' '.join(args)}: {r.stderr[-300:]}")
        return r

    # ---- кандидаты: выжившие PR и лучшие форки с неотправленной работой
    verdicts = set(mcfg.get("verdicts") or ["take", "consider"])
    cands = []
    for n, row in P["rows"].items():
        if row.get("verdict") in verdicts:
            cands.append({"id": f"pr-{n}", "kind": "pr", "ref": f"pr-{n}", "number": n, "title": row["title"],
                          "score": row.get("score") or 0, "area": row.get("area"), "verdict": row.get("verdict")})
    forks_top = int(mcfg.get("forks_top") or 20)
    for r in sorted((P.get("fork_rows") or {}).values(), key=lambda r: -(r.get("score") or 0)):
        if len([c for c in cands if c["kind"] == "fork"]) >= forks_top:
            break
        if r.get("classified") and not r.get("duplicate_of") and (r.get("ahead") or 0) > 0:
            owner = r["fork"].split("/")[0]
            cands.append({"id": f"fork-{r['fork']}", "kind": "fork", "ref": f"fk-{owner}", "title": r["fork"],
                          "score": r.get("score") or 0, "area": None, "verdict": "fork",
                          "branch": r.get("branch"), "repo": r["fork"]})
    if not cands:
        return {"stage": "map", "started": started, "seconds": 0, "items": 0, "errors": 0, "input_tokens": 0,
                "cost_usd": 0, "model": "git + Jev"}

    # ---- ссылки: PR-ветки уже скачаны stage2, ветки форков тянем сами
    def fetch_ref(c):
        if c["kind"] == "fork":
            # `+`: forks get force-pushed too, and a rerun must pick up the new head
            return c, git_fetch(repo, f"https://github.com/{c['repo']}.git", f"+{c['branch']}:{c['ref']}").returncode != 0
        return c, git("rev-parse", "--verify", "-q", c["ref"]).returncode != 0

    progress(0, len(cands), phase="map-fetch")
    with cf.ThreadPoolExecutor(MERGE_WORKERS) as ex:
        for c, failed in ex.map(fetch_ref, cands):
            if failed:
                c["missing"] = True
    cands = [c for c in cands if not c.get("missing")]
    for c in cands:
        names = git("diff", "--name-only", f"{base}...{c['ref']}").stdout.split()
        c["files"] = names
        shortstat = git("diff", "--shortstat", f"{base}...{c['ref']}").stdout.strip()
        m = re.search(r"(\d+) insertion", shortstat)
        c["lines"] = int(m.group(1)) if m else 0
    hot = hot_map(git, base, int(mcfg.get("hot_commits") or 400))
    hot_total = sum(hot.values()) or 1
    for c in cands:
        c["hot"] = sum(hot.get(f, 0) for f in c["files"])
        c["hot_share_i"] = c["hot"] / hot_total

    # ---- попарно: наложение и тестовый мерж в обе стороны
    pairs = [(a, b) for i, a in enumerate(cands) for b in cands[i + 1:]]
    compat = {}
    for a, b in pairs:
        overlap = len(set(a["files"]) & set(b["files"]))
        compat[triage.pair_key(a["id"], b["id"])] = {"overlap": overlap,
                                                     "both_files": sorted(set(a["files"]) & set(b["files"]))[:10]}
    to_merge = [(a, b) for a, b in pairs if compat[triage.pair_key(a["id"], b["id"])]["overlap"] > 0]
    emit({"type": "log", "message": f"карта мёрджей: {len(cands)} кандидатов, {len(pairs)} пар, "
                                    f"пересекаются файлами {len(to_merge)} (их и мержим живьём)"})
    base_sha = git("rev-parse", base).stdout.strip()
    pool, worktrees = open_worktrees(repo, "map", base_sha) if to_merge else (Queue(), [])

    def merge_pair(args):
        i, (a, b) = args
        key = triage.pair_key(a["id"], b["id"])
        res = {}
        wt = pool.get()
        try:
            for label, order in (("merge", (a, b)), ("merge_rev", (b, a))):
                subprocess.run(["git", "-C", str(wt), "reset", "-q", "--hard", base_sha], capture_output=True, text=True)
                subprocess.run(["git", "-C", str(wt), "clean", "-fdq"], capture_output=True, text=True)
                ok = True
                for c in order:
                    # Мерж коммитим: второй мерж в грязном индексе git отклоняет, и раньше это
                    # выглядело как «конфликт» у каждой пересекающейся пары.
                    m = subprocess.run(["git", "-C", str(wt), "merge", "-q", "--no-ff", "--no-edit", c["ref"]],
                                       capture_output=True, text=True)
                    if m.returncode:
                        ok = False
                        res[f"{label}_files"] = subprocess.run(["git", "-C", str(wt), "diff", "--name-only", "--diff-filter=U"],
                                                              capture_output=True, text=True).stdout.split()[:8]
                        subprocess.run(["git", "-C", str(wt), "merge", "--abort"], capture_output=True, text=True)
                        break
                subprocess.run(["git", "-C", str(wt), "reset", "-q", "--hard", base_sha], capture_output=True, text=True)
                res[label] = "clean" if ok else "conflict"
        finally:
            pool.put(wt)
        progress(i, len(to_merge), phase="map-merge", pair=key, result=res.get("merge"))
        return key, res

    try:
        with cf.ThreadPoolExecutor(max(1, len(worktrees))) as ex:
            for key, res in ex.map(merge_pair, list(enumerate(to_merge, 1))):
                compat[key].update(res)
    finally:
        close_worktrees(repo, worktrees)

    # ---- попарно по смыслу: одно и то же или нет, и какой лучше
    sem_cap = int(mcfg.get("semantic_pairs") or 150)
    sem_targets = [(a, b) for a, b in pairs
                   if (compat[triage.pair_key(a["id"], b["id"])]["overlap"] > 0 or (a.get("area") and a.get("area") == b.get("area")))][:sem_cap]
    tokens, errors = 0, 0
    if sem_targets and JEV_KEY:
        emit({"type": "log", "message": f"смысловое сравнение пар через Jev: {len(sem_targets)} (лимит {sem_cap})"})

        def ask(args):
            idx, (a, b) = args
            q = triage.map_pair_questions(a, b)
            state = {"project": cfg["repo"],
                     "a": {"title": a["title"], "files": a["files"][:15], "lines": a["lines"], "score": a["score"]},
                     "b": {"title": b["title"], "files": b["files"][:15], "lines": b["lines"], "score": b["score"]}}
            return idx, a, b, jev(state, q)

        progress(0, len(sem_targets), phase="map-semantic")
        with cf.ThreadPoolExecutor(STAGE1_WORKERS) as ex:
            for idx, a, b, res in ex.map(ask, list(enumerate(sem_targets, 1))):
                key = triage.pair_key(a["id"], b["id"])
                ans = res.get("answers") or {}
                if "same_problem" in ans:
                    tokens += res["usage"]["input_tokens"]
                    choice = (ans.get("better") or {}).get("choice")
                    compat[key].update({"duplicate": round(ans["same_problem"].get("noul") or 0, 2),
                                        "better": {"a": a["id"], "b": b["id"]}.get(choice, choice)})
                else:
                    errors += 1
                progress(idx, len(sem_targets), phase="map-semantic", tokens=tokens)

    # ---- расклады
    plans = triage.build_plans(cands, compat, hot_total=float(hot_total), top_n=int(mcfg.get("top_n") or 20))
    for p in plans.values():
        p["members"] = [{k: c.get(k) for k in ("id", "kind", "number", "repo", "title", "score", "area", "lines")}
                        | {"files": len(c.get("files") or [])} for c in p["members"]]
    dup_pairs = sorted([{"pair": k, **v} for k, v in compat.items() if (v.get("duplicate") or 0) >= 0.6], key=lambda x: -x["duplicate"])
    conflict_pairs = sorted([{"pair": k, **v} for k, v in compat.items() if v.get("merge") == "conflict" or v.get("merge_rev") == "conflict"],
                            key=lambda x: -x["overlap"])
    result = {
        "candidates": [{k: c.get(k) for k in ("id", "kind", "number", "repo", "title", "score", "area", "verdict", "lines")}
                       | {"files": len(c.get("files") or [])}
                       for c in sorted(cands, key=lambda c: -(c.get("score") or 0))],
        "pairs": len(pairs), "pairs_merged": len(to_merge), "pairs_semantic": len(sem_targets),
        "conflicts": conflict_pairs, "duplicates": dup_pairs, "plans": plans,
        "hot_commits": int(mcfg.get("hot_commits") or 400),
    }
    with lock:
        P["map"] = result
        save(slug, "map")
    recompute(slug)
    return {"stage": "map", "started": started, "seconds": round(time.time() - t0), "items": len(cands),
            "errors": errors, "conflicts": len(conflict_pairs), "input_tokens": tokens, "jev_calls": len(sem_targets) if JEV_KEY else 0,
            "cost_usd": round(tokens * PRICE_PER_MTOK / 1e6, 4), "model": "git + Jev"}


def stack_job(slug):
    """Оценить цену поддержки нашего стека: собрать его вживую и посчитать конфликты.

    Метрика отвечает на вопрос «сколько нам будет стоить мёрдж апстрима, если мы возьмём
    эти PR»:
      1. порядок и конфликты при сборке — выбранные PR вливаются по одному в master,
         конфликтующие пропускаются (их имена и файлы сохраняются);
      2. пересечение с «горячими» файлами upstream — берём последние HOT_COMMITS коммитов
         main-ветки, считаем частоту правок по файлам и смотрим, какая доля правок
         upstream приходится на файлы, которые мы патчим. Это и есть будущая поверхность
         конфликтов: чем выше, тем дороже каждый следующий подтяг апстрима;
      3. объём патча — строки и файлы, чтобы прикинуть стоимость ревью и переноса.
    """
    P, t0, started = projects[slug], time.time(), now_iso()
    cfg = P["config"]
    scfg = cfg.get("stack") or {}
    verdicts = set(scfg.get("verdicts") or ["take", "consider"])
    limit = int(scfg.get("limit") or 0)
    hot_commits = int(scfg.get("hot_commits") or 400)
    repo = pdir(slug) / "repo"
    if not (repo / ".git").exists():
        raise RuntimeError("Нет клона репозитория: сначала нужен этап stage2")
    base = f"origin/{cfg.get('default_branch') or 'main'}"

    def git(*args, check=False):
        r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
        if check and r.returncode:
            raise RuntimeError(f"git {' '.join(args)}: {r.stderr[-300:]}")
        return r

    chosen = sorted([n for n, r in P["rows"].items() if r.get("verdict") in verdicts], key=lambda n: -(P["rows"][n].get("score") or 0))
    if limit:
        chosen = chosen[:limit]
    if not chosen:  # nothing to build is a result too: the UI says so instead of "never run"
        with lock:
            P["stack"] = {"verdicts": sorted(verdicts), "considered": 0, "merged": 0, "conflicted": 0, "skipped": [], "conflicts": [],
                          "merged_prs": [], "included": [], "patch": {"files": 0, "shortstat": ""}, "merge_cost": 0,
                          "hot": {"commits_scanned": hot_commits, "files_in_stack": 0, "hot_in_stack": 0, "hot_top": [], "churn_share": 0}}
            save(slug, "stack")
        return {"stage": "stack", "started": started, "seconds": 0, "items": 0, "errors": 0, "input_tokens": 0,
                "cost_usd": 0, "model": "git"}
    git("config", "user.email", "scout@localhost"); git("config", "user.name", "PR Scout")
    if git_fetch(repo, "origin", cfg.get("default_branch") or "main").returncode:
        raise RuntimeError("Не удалось обновить основную ветку из origin")
    included = sorted(P["included"])
    fetch_prs(repo, included + chosen)
    git("merge", "--abort")
    git("checkout", "-q", "-B", "stack-sim", base, check=True)
    git("reset", "-q", "--hard", base)
    # PRs already taken are the floor of the stack: the new ones have to land on top of them,
    # and they are part of what every upstream pull has to be merged with.
    base_merged = []
    for n in included:
        if git("merge", "-q", "--no-ff", "--no-edit", f"pr-{n}").returncode == 0:
            base_merged.append(n)
        else:
            git("merge", "--abort")
            emit({"type": "log", "message": f"#{n} из «уже взятых» не вливается в свежую основную ветку"})

    merged, conflicted, skipped = [], [], []
    progress(0, len(chosen), phase="stack")
    for i, n in enumerate(chosen, 1):
        if git("rev-parse", "--verify", "-q", f"pr-{n}").returncode:
            skipped.append({"number": n, "why": "нет ветки"})
            progress(i, len(chosen), n, phase="stack", merge="нет ветки")
            continue
        m = git("merge", "-q", "--no-ff", "--no-edit", f"pr-{n}")
        if m.returncode == 0:
            merged.append(n)
            progress(i, len(chosen), n, phase="stack", merge="merged")
        else:
            files = git("diff", "--name-only", "--diff-filter=U").stdout.split()
            git("merge", "--abort")
            conflicted.append({"number": n, "files": files[:15], "message": (m.stderr or m.stdout)[-200:]})
            progress(i, len(chosen), n, phase="stack", merge="conflict")
    # 2. горячие файлы upstream: история основной ветки, а не HEAD — в HEAD уже влиты наши PR,
    #    и их собственные коммиты завысили бы «правки апстрима»
    hot = hot_map(git, base, hot_commits)
    touched = set(git("diff", "--name-only", f"{base}...stack-sim").stdout.split())
    adds = git("diff", "--shortstat", f"{base}...stack-sim").stdout.strip()
    ins, dels = (re.search(rf"(\d+) {w}", adds) for w in ("insertion", "deletion"))
    total_hot = sum(hot.values()) or 1
    hot_overlap = sorted(((f, hot[f]) for f in touched if f in hot), key=lambda kv: -kv[1])
    weight = sum(w for _, w in hot_overlap) / total_hot
    result = {
        "verdicts": sorted(verdicts), "considered": len(chosen), "merged": len(merged), "conflicted": len(conflicted),
        "skipped": skipped, "conflicts": conflicted, "merged_prs": merged, "included": base_merged,
        "patch": {"files": len(touched), "shortstat": adds,
                  "insertions": int(ins.group(1)) if ins else 0, "deletions": int(dels.group(1)) if dels else 0},
        "hot": {"commits_scanned": hot_commits, "files_in_stack": len(touched), "hot_in_stack": len(hot_overlap),
                "hot_top": [{"file": f, "edits": w} for f, w in hot_overlap[:20]],
                "churn_share": round(100 * weight, 2)},
        "merge_cost": round(100 * len(conflicted) / max(1, len(chosen)), 1),
    }
    with lock:
        P["stack"] = result
        save(slug, "stack")
    recompute(slug)
    return {"stage": "stack", "started": started, "seconds": round(time.time() - t0), "items": len(chosen),
            "errors": len(skipped), "conflicts": len(conflicted), "input_tokens": 0, "cost_usd": 0, "model": "git"}


def rivals_job(slug):
    """One issue, several pull requests: ask Jev which one to take."""
    P, t0, started = projects[slug], time.time(), now_iso()
    cfg = P["config"]
    groups = {}
    for n, pr in P["prs"].items():
        for i in (pr.get("issues") or []):
            groups.setdefault(i, []).append(n)
    todo = {i: sorted(v, key=lambda n: -(P["rows"].get(n, {}).get("score") or 0)) for i, v in groups.items() if len(v) > 1}
    rivals, tokens, errors, done = {}, 0, 0, 0
    progress(0, len(todo), phase="rivals")

    def ask(item):
        issue_no, nums = item
        meta = (P["issues"].get(str(issue_no)) or {}).get("meta") or {"number": issue_no, "title": f"issue #{issue_no}", "body": ""}
        cands = []
        for n in nums[:8]:
            row = {**P["rows"].get(n, {}), "number": n, "auto": is_bot(P["prs"][n].get("author"))}
            s2 = P["stage2"].get(str(n)) or {}
            if s2.get("review"):
                row["review"] = {k: round(v, 2) for k, v in _review_numbers(s2["review"]["answers"]).items()}
                row["merge_status"] = (s2.get("merge") or {}).get("merge")
            cands.append(row)
        q, _ = rival_question(cfg, {**meta, "body": (meta.get("body") or "")[:1200]}, cands)
        return issue_no, meta, cands, q

    prepared = [ask(item) for item in todo.items()]
    with cf.ThreadPoolExecutor(STAGE1_WORKERS) as ex:
        futures = {}
        for issue_no, meta, cands, q in prepared:
            futures[ex.submit(jev, {"repo": cfg["repo"], "issue": {"number": meta["number"], "title": meta["title"],
                                                                   "description": (meta.get("body") or "")[:1200]},
                                    "candidates": [c["title"] for c in cands]}, q)] = (issue_no, meta)
        for fut in cf.as_completed(futures):
            (issue_no, meta), res = futures[fut], fut.result()
            done += 1
            if "answers" in res:
                tokens += res["usage"]["input_tokens"]
                with lock:
                    rivals[str(issue_no)] = {**apply_rival(res["answers"], meta), "candidates": todo[issue_no], "usage": res["usage"]}
            else:
                errors += 1
            progress(done, len(todo), issue_no, phase="rivals", tokens=tokens, seconds=round(time.time() - t0, 1))
    with lock:
        P["rivals"] = rivals
        save(slug, "rivals")
    recompute(slug)
    return {"stage": "rivals", "started": started, "seconds": round(time.time() - t0), "items": len(todo), "errors": errors,
            "input_tokens": tokens, "cost_usd": round(tokens * PRICE_PER_MTOK / 1e6, 4), "model": JEV_LABEL}


BOT_AUTHORS = re.compile(r"(\[bot\]$|-bot$|^dependabot|^renovate|^github-actions)", re.I)


def is_bot(author):
    return bool(BOT_AUTHORS.search(author or ""))


def _review_numbers(answers):
    return {k: v.get("score", v.get("noul", 0)) for k, v in answers.items()}


# ---------- API ----------
LIST_FIELDS = ("number", "title", "author", "updated", "additions", "deletions", "files", "included", "classified", "kind", "area", "track",
               "relevance", "bug_severity", "feature_value", "harm", "common_case", "new_capability", "risky", "score", "rank",
               "duplicate_of", "finalist", "verdict", "ci_class", "ai_description", "reasons")


@app.get("/api/projects")
def list_projects():
    with lock:
        out = []
        for slug, P in projects.items():
            rows = P["rows"].values()
            out.append({"slug": slug, "repo": P["config"]["repo"], "name": P["config"].get("name") or P["config"]["repo"],
                        "prs": len(P["prs"]), "classified": sum(r["classified"] for r in rows),
                        "take": sum(r.get("verdict") == "take" for r in rows), "last_run": P["runs"][-1]["started"] if P["runs"] else None})
        return out


def parse_repo(text):
    m = re.search(r"(?:github\.com[/:])?([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", text.strip())
    if not m:
        raise HTTPException(400, "Не понял ссылку. Нужна вида https://github.com/owner/repo")
    return f"{m.group(1)}/{m.group(2)}"


@app.post("/api/projects")
async def create_project(request: Request):
    body = await request.json()
    repo = parse_repo(body.get("url", ""))
    slug = slug_of(repo)
    if slug in projects:
        raise HTTPException(409, "Такой проект уже есть")
    preset = preset_for(repo)
    # `ollama` / `ollama_model` are the pre-provider names of these fields, still accepted from scripts
    provider = body.get("describer") if body.get("describer") in llm.PROVIDERS else "ollama"
    model = body.get("describer_model") or body.get("ollama_model") or llm.PROVIDERS[provider].get("model") or ""
    cfg = {"repo": repo, "name": body.get("name") or preset.get("name") or repo.split("/")[1], "profile": body.get("profile", "").strip() or preset.get("profile", ""),
           "community_only": body.get("community_only", True), "include_drafts": False, "exclude_authors": [],
           "stack_prs": [], "stack_prs_url": "", "finalists": int(body.get("finalists") or preset.get("finalists") or 120),
           "describer": {"enabled": bool(body.get("describe", body.get("ollama", True))), "provider": provider, "model": model, "min_body": 200},
           "areas": {"other": "Anything else"}, "area_labels": {"other": "Прочее"}}
    for k in ("areas", "area_labels", "exclude_authors", "stack_prs_url", "default_branch", "forks", "stack", "map"):
        if k in preset:
            cfg[k] = preset[k]
    cfg["custom_areas"] = "areas" in preset
    write_json(pdir(slug) / "config.json", cfg)
    load_project(slug)
    if body.get("run", True):
        run_job("full", slug, [fetch_job, describe_job, stage1_job, stage2_job])
    return {"slug": slug}


@app.put("/api/p/{slug}/config")
async def update_config(slug: str, request: Request):
    P, body = get_project(slug), await request.json()
    with lock:
        cfg = P["config"]
        for k in ("name", "profile", "community_only", "include_drafts", "finalists", "stack_prs_url"):
            if k in body:
                cfg[k] = body[k]
        if "ollama" in body and "describer" not in body:  # the pre-provider name
            body["describer"] = body.pop("ollama")
        for k in ("forks", "stack", "map", "describer"):
            if k in body:
                if not isinstance(body[k], dict):
                    raise HTTPException(400, f"«{k}» должен быть объектом")
                cfg[k] = {**cfg.get(k, {}), **body[k]}
        if cfg.get("describer", {}).get("provider", "ollama") not in llm.PROVIDERS:
            raise HTTPException(400, f"Провайдер «{cfg['describer']['provider']}» не настроен на сервере")
        if "exclude_authors" in body:
            cfg["exclude_authors"] = [a.strip() for a in re.split(r"[,\s]+", body["exclude_authors"]) if a.strip()] if isinstance(body["exclude_authors"], str) else body["exclude_authors"]
        if "stack_prs" in body:
            cfg["stack_prs"] = [int(x) for x in re.findall(r"\d+", str(body["stack_prs"]))]
        write_json(pdir(slug) / "config.json", cfg)
        P["included"] = load_included(cfg)
    recompute(slug)
    return cfg


@app.delete("/api/p/{slug}")
def delete_project(slug: str):
    get_project(slug)
    if job["project"] == slug:
        raise HTTPException(409, "По проекту идёт задача")
    with lock:
        projects.pop(slug)
    shutil.rmtree(pdir(slug), ignore_errors=True)
    return {"ok": True}


@app.get("/api/p/{slug}/prs")
def list_prs(slug: str):
    P = get_project(slug)
    with lock:
        return [{k: r.get(k) for k in LIST_FIELDS} for r in P["rows"].values()]


@app.get("/api/p/{slug}/prs/{n}")
def pr_detail(slug: str, n: int):
    P = get_project(slug)
    with lock:
        pr = P["prs"].get(n)
        if not pr:
            raise HTTPException(404)
        return {"pr": pr, "row": P["rows"].get(n), "stage1": P["stage1"].get(str(n)), "stage2": P["stage2"].get(str(n))}


@app.get("/api/p/{slug}/summary")
def summary(slug: str):
    P = get_project(slug)
    with lock:
        rows = list(P["rows"].values())
        issues = list((P.get("issue_rows") or {}).values())
        forks = list((P.get("fork_rows") or {}).values())
        return {"total": len(rows), "classified": sum(r["classified"] for r in rows), "finalists": len(P["finalists"]),
                "included": sorted(P["included"]), "runs": P["runs"], "job": dict(job), "config": P["config"],
                "issues": {"total": len(issues), "classified": sum(r["classified"] for r in issues),
                           "without_pr": sum(1 for r in issues if r["classified"] and not r.get("open_pr"))},
                "forks": {"scanned": len(forks), "ahead": sum(1 for r in forks if (r.get("ahead") or 0) > 0),
                          "classified": sum(r["classified"] for r in forks),
                          "duplicates": sum(1 for r in forks if r.get("duplicate_of")),
                          "clusters": len({r["cluster"] for r in forks if r.get("cluster")}),
                          "total": len(P.get("forks") or {})},
                "stack": P.get("stack") or {},
                "map": {k: v for k, v in (P.get("map") or {}).items() if k != "candidates"} | {
                    "candidate_list": (P.get("map") or {}).get("candidates") or []} if P.get("map") else {},
                "rivals": {"groups": len(P.get("rivals") or {}),
                           "picked": sum(1 for r in (P.get("rivals") or {}).values() if r.get("chosen_pr")),
                           "list": list((P.get("rivals") or {}).values())},
                "jev_ready": bool(JEV_KEY), "github_ready": bool(GH_TOKEN), "jev": jev_info(), "comparison": cost_comparison(P["runs"])}


@app.get("/api/p/{slug}/issues")
def list_issues(slug: str):
    P = get_project(slug)
    with lock:
        return sorted((P.get("issue_rows") or {}).values(), key=lambda r: -(r.get("score") or 0))


@app.get("/api/p/{slug}/issues/{n}")
def issue_detail(slug: str, n: int):
    """One issue with its text and every answer Jev gave, for the issue sheet."""
    P = get_project(slug)
    with lock:
        item = (P.get("issues") or {}).get(str(n))
        if not item or not item.get("meta"):
            raise HTTPException(404)
        return {"issue": item["meta"], "row": (P.get("issue_rows") or {}).get(n), "answers": item.get("answers"),
                "labels": ISSUE_QUESTION_LABELS, "kinds": {k: ISSUE_KIND_LABELS.get(k, k) for k in ISSUE_KINDS}}


@app.get("/api/p/{slug}/forks")
def list_forks(slug: str):
    P = get_project(slug)
    with lock:
        return sorted((P.get("fork_rows") or {}).values(), key=lambda r: -(r.get("score") or 0))


@app.get("/api/p/{slug}/rivals")
def list_rivals(slug: str):
    P = get_project(slug)
    with lock:
        return (P.get("rivals") or {})


@app.get("/api/p/{slug}/stack")
def get_stack(slug: str):
    P = get_project(slug)
    with lock:
        return (P.get("stack") or {})


@app.get("/api/p/{slug}/map")
def get_map(slug: str):
    P = get_project(slug)
    with lock:
        return (P.get("map") or {})


@app.get("/api/p/{slug}/criteria")
def criteria(slug: str):
    cfg = get_project(slug)["config"]
    return {"setup": cfg.get("profile"), "stage1": stage1_questions(cfg), "stage2": STAGE2_QUESTIONS, "labels": QUESTION_LABELS,
            "areas": cfg.get("area_labels") or {}, "kinds": KIND_LABELS, "finalists": cfg.get("finalists", 120), "negative": NEGATIVE}


@app.get("/api/llm/providers")
def llm_providers():
    return [llm.public(p) for p in llm.PROVIDERS.values()]


@app.get("/api/llm/{provider}/models")
def llm_models(provider: str):
    if provider not in llm.PROVIDERS:
        raise HTTPException(404, "Такого провайдера нет")
    return llm.models(provider)


@app.get("/api/ollama/models")
def get_ollama_models():
    return llm.models("ollama")


# Jobs that never ask Jev (map asks only when a key is set, and works on git alone without one).
NO_JEV_JOBS = ("fetch", "describe", "issues_meta", "forks_meta", "stack", "map")


@app.post("/api/p/{slug}/jobs/{name}")
async def start_job(slug: str, name: str, request: Request):
    get_project(slug)
    if name not in NO_JEV_JOBS and not JEV_KEY:
        raise HTTPException(400, f"Не задан ключ Jev: {_JEV['key']} ({_JEV['name']})")
    body = await request.json() if request.headers.get("content-length") not in (None, "0") else {}
    pipelines = {
        "full": [fetch_job, describe_job, stage1_job, stage2_job],
        "everything": [fetch_job, describe_job, stage1_job, stage2_job, fetch_issues_job, issues_job, rivals_job,
                       fetch_forks_job, forks_job, stack_job, map_job],
        "fetch": [fetch_job], "describe": [describe_job], "stage2": [stage2_job],
        "stage1": [(lambda s: stage1_job(s, body.get("limit")))],
        "issues": [fetch_issues_job, issues_job], "issues_meta": [fetch_issues_job], "issues_jev": [issues_job],
        "forks": [fetch_forks_job, forks_job], "forks_meta": [fetch_forks_job], "forks_compare": [forks_job],
        "rivals": [rivals_job],
        "stack": [stack_job],
        "map": [map_job],
    }
    if name not in pipelines:
        raise HTTPException(404)
    if name == "stage1":
        pipelines["stage1"][0].__name__ = "stage1_job"
    run_job(name, slug, pipelines[name])
    return {"ok": True}


@app.get("/api/status")
def status():
    return {"job": dict(job), "jev_ready": bool(JEV_KEY), "github_ready": bool(GH_TOKEN), "jev": jev_info(),
            "llm_providers": llm_providers(), "ollama_models": llm.models("ollama")}


def jev_info():
    return {"provider": JEV_PROVIDER, "name": _JEV["name"], "model": JEV_MODEL, "key": _JEV["key"], "price_per_mtok": PRICE_PER_MTOK}


@app.get("/api/p/{slug}/report.md")
def report(slug: str):
    """The whole cycle as one markdown document: PR verdicts, issues, forks, rivals, stack and merge map."""
    P = get_project(slug)
    with lock:
        text = build_report(P)
    name = f"pr-scout-{slug.replace('__', '-')}-{dt.date.today().isoformat()}.md"
    return Response(text, media_type="text/markdown; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.get("/api/events")
async def events(request: Request):
    q: asyncio.Queue = asyncio.Queue()
    listeners.append(q)

    async def stream():
        try:
            yield f"data: {json.dumps({'type': 'hello', 'job': dict(job)})}\n\n"
            while not await request.is_disconnected():
                try:
                    yield f"data: {json.dumps(await asyncio.wait_for(q.get(), timeout=15), ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            listeners.remove(q)
    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/")
def index():
    # no-cache: assets are content-hashed, but a stale index.html would keep loading the old build
    return FileResponse(APP_DIR / "static" / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
