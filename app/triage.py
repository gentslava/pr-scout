"""Issue, fork and rival triage: three more questions to ask the same Jev.

Upstream PR Scout answers one question — which open pull request should we take.
These answer the ones the PR list cannot:

* **issues** — what is broken in the project and has no pull request at all;
* **forks**  — which fixes exist in forks and were never sent upstream;
* **rivals** — when several pull requests claim the same issue, which one to take.

Pure logic only (typed questions and the formulas that turn answers into a score),
exactly like scoring.py. All network and git IO lives in main.py.
"""
import datetime as dt

ISSUE_KINDS = {
    "bug": "Something in the product is broken or behaves incorrectly",
    "crash_data": "A crash, a hang, or lost/corrupted data",
    "security": "A security, privacy or permission hole",
    "performance": "It works but is too slow or too heavy",
    "feature_request": "A request for a capability that does not exist yet",
    "ux_confusion": "The product works as coded but users cannot figure it out",
    "docs": "Documentation, examples or onboarding text is wrong or missing",
    "ops_deploy": "Installation, Docker, configuration, upgrade or deployment problem",
    "question": "A support question, not a defect",
    "other": "Anything else",
}

ISSUE_KIND_LABELS = {
    "bug": "Баг", "crash_data": "Падение/данные", "security": "Безопасность", "performance": "Производительность",
    "feature_request": "Запрос фичи", "ux_confusion": "Непонятный UX", "docs": "Документация",
    "ops_deploy": "Деплой и настройка", "question": "Вопрос", "other": "Прочее",
}

RIVAL_LABELS = {"none": "Ни один не подходит"}

# What each issue question asks, for the issue sheet in the UI.
ISSUE_QUESTION_LABELS = {
    "kind": "Что это", "severity": "Насколько больно", "relevance": "Важно для нашего сценария",
    "common_case": "Случается в обычной работе", "actionable": "Закрывается правкой кода", "clear": "Проблема описана понятно",
    "security_or_data": "Безопасность или потеря данных", "by_design": "Так задумано", "reproducible": "Можно воспроизвести",
}

FORK_KINDS = {
    "fix": "Fixes incorrect or broken upstream behaviour",
    "feature": "Adds a capability upstream does not have",
    "security": "Closes a security, privacy or permission hole",
    "performance": "Makes upstream behaviour faster or lighter",
    "refactor": "Restructures code without changing behaviour",
    "ops_deploy": "Deployment, Docker, configuration or upgrade changes",
    "docs": "Documentation only",
    "deps": "Dependency or version bumps, formatting, housekeeping",
    "experiment": "Prototype, personal experiment, work in progress, or revert",
}

FORK_KIND_LABELS = {
    "fix": "Фикс", "feature": "Фича", "security": "Безопасность", "performance": "Производительность",
    "refactor": "Рефакторинг", "ops_deploy": "Деплой", "docs": "Документация", "deps": "Зависимости",
    "experiment": "Эксперимент",
}

# Scale shared by PR/issue/fork relevance: 0 irrelevant → 3 what we rely on daily.
RELEVANCE_CRITERIA = [
    "Irrelevant: it only touches parts that `our_setup` does not use",
    "Indirect: general code `our_setup` runs, but rarely noticeable",
    "Affects features `our_setup` uses sometimes",
    "Directly affects what `our_setup` relies on every day",
]

HARM_CRITERIA = [
    "Not a problem: a question, a duplicate, or already resolved",
    "Cosmetic: wrong text, styling, or a harmless glitch",
    "Minor annoyance with an easy workaround",
    "Blocks a user workflow, a setting, or wastes work",
    "Core functionality fails or hangs, data is lost or corrupted, the application crashes, or a security hole is open",
]

VALUE_CRITERIA = [
    "No value: housekeeping, version bumps, personal settings",
    "Small: a narrow fix or a cosmetic change",
    "Useful: a real fix or a convenience many users want",
    "Important: fixes something that breaks work today",
    "Major: a capability users cannot get upstream at all",
]


def _profile(cfg):
    name = cfg.get("name") or cfg["repo"]
    return name, cfg.get("profile") or f"A typical self-hosted user of {name}."


def issue_questions(cfg):
    """Typed questions for one issue report."""
    name, profile = _profile(cfg)
    return {
        "kind": {"type": "choice", "instructions": f"What kind of report is this issue in {name}? Use the labels and the text.", "criteria": ISSUE_KINDS},
        "severity": {"type": "score", "instructions": f"How badly does this problem hurt users of {name} today? Rate 0 when it is not a problem at all.",
                     "criteria": HARM_CRITERIA},
        "relevance": {"type": "score", "instructions": {
            "question": f"How much does this problem matter for the way `our_setup` uses {name}?", "our_setup": profile},
            "criteria": RELEVANCE_CRITERIA},
        "common_case": {"type": "noul", "instructions": "This problem happens in everyday use, not only in a rare edge case, an unusual configuration, or a specific operating system."},
        "actionable": {"type": "noul", "instructions": "This issue can be closed by a code change in the repository, not only by a documentation edit or a support answer."},
        "clear": {"type": "noul", "instructions": "The issue explains a concrete problem with enough detail (steps, version, logs) that someone could act on it."},
        "security_or_data": {"type": "noul", "instructions": "This issue is about a security hole, lost or corrupted data, or leaked credentials."},
        "by_design": {"type": "noul", "instructions": "The current behaviour is intentional, so the issue asks for a product decision rather than a fix."},
        "reproducible": {"type": "noul", "instructions": "The issue gives enough information to reproduce the problem, or to find the code responsible for it."},
    }


def score_issue(issue, answers, has_pr=False, mentioned_by=()):
    """Priority 0-100 for one issue: how much it hurts and whether anyone is fixing it."""
    a = answers
    harm = max(a["severity"]["score"] / 4, a["security_or_data"]["noul"])
    rel = a["relevance"]["score"] / 3
    common, action, clear = a["common_case"]["noul"], a["actionable"]["noul"], a["clear"]["noul"]
    design, repro = a["by_design"]["noul"], a["reproducible"]["noul"]
    parts = {"relevance": 40 * rel, "harm_common": 25 * harm * common, "severity": 15 * (a["severity"]["score"] / 4),
             "actionable": 10 * action, "clear": 5 * clear, "no_pr": 5 * (0.0 if has_pr else 1.0)}
    penalties = {"by_design": 20 * design, "covered_by_pr": 10.0 if has_pr else 0.0, "vague": 5 * (1 - repro)}
    return {
        "kind": a["kind"]["choice"], "severity": round(a["severity"]["score"], 2), "relevance": round(a["relevance"]["score"], 2),
        "harm": round(harm, 2), "common_case": round(common, 2), "actionable": round(action, 2), "clear": round(clear, 2),
        "by_design": round(design, 2), "reproducible": round(repro, 2), "security_or_data": round(a["security_or_data"]["noul"], 2),
        "has_pr": bool(has_pr), "mentioned_by": sorted(mentioned_by)[:8],
        "score": round(sum(parts.values()) - sum(penalties.values()), 1),
        "breakdown": {**{k: round(v, 1) for k, v in parts.items()}, **{f"-{k}": round(v, 1) for k, v in penalties.items() if v}},
    }


def fork_questions(cfg):
    """Typed questions for the commits one fork has ahead of upstream."""
    name, profile = _profile(cfg)
    return {
        "kind": {"type": "choice", "instructions": "What do the commits this fork has ahead of upstream mainly do?", "criteria": FORK_KINDS},
        "value": {"type": "score", "instructions": f"If upstream merged exactly these commits, how valuable would that be for users of {name} in general?",
                  "criteria": VALUE_CRITERIA},
        "relevance": {"type": "score", "instructions": {
            "question": f"How much would these commits matter for the way `our_setup` uses {name}?", "our_setup": profile},
            "criteria": RELEVANCE_CRITERIA},
        "general": {"type": "noul", "instructions": f"These commits are useful to {name} users in general, not only to one company's private deployment, branding or internal workflow."},
        "duplicate": {"type": "noul", "instructions": "Upstream already contains an equivalent change, or an open pull request already proposes it."},
        "tests": {"type": "noul", "instructions": "The ahead commits add or update automated tests."},
        "risky": {"type": "noul", "instructions": "These commits are risky: they change the database schema or migrations, authentication or permissions logic, or rewrite a large core subsystem."},
        "secrets": {"type": "noul", "instructions": "The ahead commits contain something that must not go upstream as is: credentials, internal hostnames, customer data, or private branding."},
    }


def score_fork(fork, answers, now=None):
    """Priority 0-100 for one fork delta: worth mining, or noise."""
    now = now or dt.datetime.now(dt.timezone.utc)
    a = answers
    val, rel = a["value"]["score"] / 4, a["relevance"]["score"] / 3
    gen, dup, tests = a["general"]["noul"], a["duplicate"]["noul"], a["tests"]["noul"]
    risky, sec = a["risky"]["noul"], a["secrets"]["noul"]
    lines = fork.get("lines", 0)
    try:
        pushed = dt.datetime.fromisoformat(str(fork.get("pushed", "")).replace("Z", "+00:00"))
        stale_days = (now - pushed).days
    except ValueError:
        stale_days = 0
    parts = {"relevance": 40 * rel, "value": 30 * val, "general": 15 * gen, "novel": 10 * (1 - dup), "tests": 5 * tests}
    penalties = {"risky": 10 * risky, "secrets": 25 * sec, "huge": 10.0 if lines > 2500 else 0.0, "stale": 5.0 if stale_days > 180 else 0.0}
    return {
        "kind": a["kind"]["choice"], "value": round(a["value"]["score"], 2), "relevance": round(a["relevance"]["score"], 2),
        "general": round(gen, 2), "duplicate": round(dup, 2), "tests": round(tests, 2), "risky": round(risky, 2),
        "secrets": round(sec, 2), "ahead": fork.get("ahead", 0), "lines": lines, "stale_days": stale_days,
        "score": round(sum(parts.values()) - sum(penalties.values()), 1),
        "breakdown": {**{k: round(v, 1) for k, v in parts.items()}, **{f"-{k}": round(v, 1) for k, v in penalties.items() if v}},
    }


def rival_question(cfg, issue, candidates, limit=8):
    """One `choice` question that picks the best of several PRs claiming the same issue."""
    name, _ = _profile(cfg)
    crit = {}
    for c in list(candidates)[:limit]:
        bits = [f"PR #{c['number']} by @{c.get('author')}: {c['title']}",
                f"{c.get('additions', 0)}+{c.get('deletions', 0)} lines over {c.get('files', 0)} files",
                f"stage-1 score {c.get('score')}", f"updated {str(c.get('updated'))[:10]}"]
        if c.get("review"):
            bits.append("code review: " + ", ".join(f"{k}={v}" for k, v in c["review"].items()))
        if c.get("merge_status"):
            bits.append(f"merge into master: {c['merge_status']}")
        if c.get("auto"):
            bits.append("authored by a bot or desktop client")
        crit[f"pr_{c['number']}"] = ", ".join(bits)
    crit["none"] = "None of them is a proper fix: each misses the reported problem or adds unrelated changes"
    body = (issue.get("body") or "").strip()[:1200] if issue else ""
    instructions = (f"Which pull request should we take to resolve issue #{issue['number']} in {name}?"
                    if issue else f"Which pull request best fixes the same problem in {name}? "
                                  f"All of them claim to close issue #{candidates[0].get('issue')}.")
    return {
        "choice": {"type": "choice", "instructions": instructions, "criteria": crit},
        "proper_fix": {"type": "noul", "instructions": "At least one of these pull requests properly fixes the reported problem, rather than only a symptom of it."},
    }, body


def apply_rival(answers, issue=None):
    """Read the answers of rival_question back into a decision."""
    ch = answers["choice"]
    return {
        "issue": issue.get("number") if issue else None,
        "issue_title": (issue.get("title") if issue else None),
        "choice": ch.get("choice"), "chosen_pr": _pr_of(ch.get("choice")),
        "confidence": round(ch.get("confidence", 0), 2),
        "probabilities": {k: round(v, 3) for k, v in (ch.get("probabilities") or {}).items()},
        "proper_fix": round(answers["proper_fix"]["noul"], 2),
    }


def _pr_of(label):
    if not label or label == "none":
        return None
    try:
        return int(str(label).replace("pr_", ""))
    except ValueError:
        return None


# ---------------------------------------------------------------- карта мёрджей

def pair_key(a, b):
    return f"{a}|{b}" if a <= b else f"{b}|{a}"


def pair_state(compat, a, b):
    """Что известно про пару: наложение по файлам, результат мержа в обе стороны, дубль."""
    return compat.get(pair_key(a, b)) or {}


def compatible(compat, a, b, cache=None):
    """Пара совместима, если мержа конфликтного не было и файлы не пересекаются."""
    st = pair_state(compat, a, b)
    if st.get("merge") == "conflict" or st.get("merge_rev") == "conflict":
        return False
    if st.get("overlap", 0) == 0 and st.get("merge") in (None, "clean"):
        return True
    return st.get("merge") != "conflict" and st.get("merge_rev") != "conflict"


def plan_metrics(plan, cands, compat, hot_total=1.0):
    """Цифры расклада: сколько берём, сколько внутри конфликтов, сколько файлов патим, как горячо."""
    ids = [c["id"] for c in plan]
    inside_conflicts = []
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            if not compatible(compat, a, b):
                inside_conflicts.append((a, b))
    files = set()
    for c in plan:
        files |= set(c.get("files") or [])
    hot = sum(c.get("hot") or 0 for c in plan) / max(1e-9, hot_total)
    return {
        "count": len(plan), "score_sum": round(sum(c.get("score") or 0 for c in plan), 1),
        "conflicts": len(inside_conflicts), "conflict_pairs": inside_conflicts[:20],
        "files": len(files), "hot_share": round(100 * hot, 2),
        "duplicates": sum(1 for c in plan if c.get("dup_hint")),
        "kinds": {"pr": sum(1 for c in plan if c["kind"] == "pr"), "fork": sum(1 for c in plan if c["kind"] == "fork")},
    }


def build_plans(cands, compat, hot_total=1.0, top_n=20):
    """Несколько раскладов из одной матрицы: каждый отвечает на свой вопрос.

    * `safe`      — максимум по баллу без единого конфликта внутри (что можно взять сегодня);
    * `all_in`    — берём всё, конфликты разбираем руками (сколько их и где — в метриках);
    * `top_score` — первые N по баллу, цена поддержки не важна;
    * `low_churn` — балл против «горячести» файлов: приоритет тому, что реже ломается апстримом;
    * `by_area`   — по одному лучшему на подсистему, чтобы закрыть шире, а не глубже.
    """
    by_score = sorted(cands, key=lambda c: -(c.get("score") or 0))

    def greedy(order):
        chosen = []
        for c in order:
            if all(compatible(compat, c["id"], x["id"]) for x in chosen):
                chosen.append(c)
        return chosen

    plans = {"safe": greedy(by_score), "all_in": list(by_score), "top_score": by_score[:top_n]}
    low = sorted(cands, key=lambda c: (-(c.get("score") or 0) / (1 + 12 * (c.get("hot_share_i") or 0))))
    plans["low_churn"] = greedy(low)
    seen_area, by_area = set(), []
    for c in by_score:
        if c.get("area") and c["area"] not in seen_area:
            seen_area.add(c["area"])
            by_area.append(c)
    rest = [c for c in by_score if c not in by_area]
    plans["by_area"] = by_area + [c for c in greedy(rest) if c not in by_area]
    return {name: plan_metrics(plan, cands, compat, hot_total) | {"plan": [c["id"] for c in plan], "members": plan}
            for name, plan in plans.items()}


def map_pair_questions(a, b):
    """Вопросы про пару кандидатов: не одно ли и то же они чинят и какой лучше."""
    return {
        "same_problem": {"type": "noul", "instructions":
                         "The two changes fix or add the same thing: applying one makes the other unnecessary or contradictory."},
        "better": {"type": "choice", "instructions":
                   "If we could take only one of the two, which is better for the project: smaller and safer wins over larger and broader.",
                   "criteria": {"a": f"First: {a['title'][:120]}", "b": f"Second: {b['title'][:120]}",
                                "equal": "They are equally good, or they do different things"}},
    }
