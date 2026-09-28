"""Typed questions for Jev and the code that turns its answers into a priority and a verdict.

Jev answers small, atomic questions with calibrated probabilities. Every number that
combines those answers is computed here, so the rules stay visible and easy to change.
"""
import datetime as dt
import re
from collections import Counter

KIND_CRITERIA = {
    "bugfix": "Fixes incorrect or broken existing behavior",
    "feature": "Adds a new capability or option users can use",
    "performance": "Makes existing behavior faster or lighter without changing what it does",
    "security": "Closes a security, privacy or permission hole",
    "refactor": "Restructures code without changing behavior",
    "docs": "Changes documentation only",
    "tests_ci": "Changes only tests, CI, or build tooling",
    "chore_deps": "Dependency bumps, formatting, renames, housekeeping",
    "experimental": "Prototype, spike, work in progress, or revert",
}

KIND_LABELS = {
    "bugfix": "Фикс", "feature": "Фича", "performance": "Производительность", "security": "Безопасность", "refactor": "Рефакторинг",
    "docs": "Документация", "tests_ci": "Тесты и CI", "chore_deps": "Обслуживание", "experimental": "Эксперимент",
}

QUESTION_LABELS = {
    "kind": "Тип изменения", "area": "Часть системы", "bug_severity": "Серьёзность бага (0–4)", "feature_value": "Ценность фичи (0–4)",
    "relevance": "Релевантность вашему использованию (0–3)", "general": "Полезно всем, не костыль", "clear": "Описаны проблема и решение",
    "tests": "Есть тесты", "risky": "Рискованная область", "runs_fail": "Без изменения ломается основное", "data_loss": "Без изменения теряются данные",
    "crash": "Без изменения падает приложение", "security_hole": "Закрывает дыру в безопасности", "common_case": "Случается в обычной работе",
    "new_capability": "Даёт новую возможность", "quality": "Качество кода (0–3)", "matches": "Код соответствует описанию",
    "suspicious": "Подозрительный код", "scope_creep": "Посторонние изменения", "real_tests": "Настоящие тесты в дифе",
    "changes_defaults": "Меняет поведение по умолчанию", "promo": "Продвигает сторонний сервис",
}

# Answers where a high value is bad news (drawn in red in the UI).
NEGATIVE = ["suspicious", "scope_creep", "promo", "risky", "changes_defaults", "runs_fail", "data_loss", "crash"]


def stage1_questions(cfg):
    name = cfg.get("name") or cfg["repo"]
    profile = cfg.get("profile") or f"A typical self-hosted user of {name}."
    return {
        "kind": {"type": "choice", "instructions": "What kind of change is this pull request?", "criteria": KIND_CRITERIA},
        "area": {"type": "choice", "instructions": f"Which part of {name} does this pull request mainly change? Use the changed file paths.", "criteria": cfg["areas"]},
        "bug_severity": {"type": "score", "instructions": f"If this pull request fixes a bug, how bad is that bug for users of {name}? Rate 0 if it does not fix a bug.", "criteria": [
            "Not a bug fix",
            "Cosmetic: wrong text, styling, or a harmless glitch",
            "Minor misbehavior with an easy workaround",
            "Breaks a user workflow, blocks a setting, or wastes work",
            "Core functionality fails or hangs, data is lost or corrupted, the application crashes, or a security hole is open",
        ]},
        "feature_value": {"type": "score", "instructions": f"If this pull request adds a feature, how valuable is it for people who use {name}? Rate 0 if it adds no feature.", "criteria": [
            "Not a feature",
            "Niche: useful to very few users or tied to one company's private setup",
            "Nice to have: small convenience",
            "Clearly useful to most users",
            "Major new capability that changes what users can do",
        ]},
        "relevance": {"type": "score", "instructions": {
            "question": f"How much does this pull request matter for the way `our_setup` uses {name}?",
            "our_setup": profile,
        }, "criteria": [
            "Irrelevant: it only touches parts that `our_setup` does not use",
            "Indirect: general code `our_setup` runs, but rarely noticeable",
            "Affects features `our_setup` uses sometimes",
            "Directly affects what `our_setup` relies on every day",
        ]},
        "general": {"type": "noul", "instructions": f"The change is useful to {name} users in general, not only to one company's private setup or internal workflow."},
        "clear": {"type": "noul", "instructions": "The description explains a concrete problem and how this change fixes or adds it."},
        "tests": {"type": "noul", "instructions": "The pull request adds or updates automated tests."},
        "risky": {"type": "noul", "instructions": "The change is risky to merge: it changes the database schema or migrations, authentication or permissions logic, or rewrites a large core subsystem."},
        "runs_fail": {"type": "noul", "instructions": "Without this change, core functionality fails, hangs, or loops, or users are blocked from their work."},
        "data_loss": {"type": "noul", "instructions": "Without this change, user data, configuration, or credentials are lost, overwritten, or corrupted."},
        "crash": {"type": "noul", "instructions": "Without this change, the application crashes, fails to start, or a page fails to load."},
        "security_hole": {"type": "noul", "instructions": "This change closes a security, privacy, or permission hole that exists today."},
        "common_case": {"type": "noul", "instructions": "The problem this change addresses happens in common everyday use, not only in a rare edge case, an unusual configuration, or a specific operating system."},
        "new_capability": {"type": "noul", "instructions": "This change lets users do something important that they cannot do at all today."},
    }


STAGE2_QUESTIONS = {
    "quality": {"type": "score", "instructions": "How good is the code in `diff`?", "criteria": [
        "Hacky or likely broken: special cases, copy-paste, or logic that does not match the goal",
        "Works but messy: hard to follow or more code than needed",
        "Reasonable: clear enough and follows the surrounding code",
        "Clean: minimal, idiomatic, and easy to review",
    ]},
    "matches": {"type": "noul", "instructions": "The code in `diff` does what `title` and `description` say, and nothing unrelated."},
    "suspicious": {"type": "noul", "instructions": "The code in `diff` contains suspicious behavior: requests to unknown external hosts, telemetry, obfuscated or encoded payloads, collecting or sending credentials, or a backdoor."},
    "scope_creep": {"type": "noul", "instructions": "The code in `diff` includes large unrelated changes, mass reformatting, or generated files beyond what `title` describes."},
    "real_tests": {"type": "noul", "instructions": "The code in `diff` adds or changes automated tests that exercise the changed behavior."},
    "changes_defaults": {"type": "noul", "instructions": "The code in `diff` changes existing default behavior in a way that current users would notice without opting in."},
    "promo": {"type": "noul", "instructions": "The change mainly promotes or integrates a specific third-party commercial product or service."},
}

CONTAINER_DIRS = {"packages", "apps", "src", "lib", "libs", "services", "modules", "crates", "plugins", "components", "internal", "pkg", "cmd"}


def auto_areas(prs, limit=13):
    """Areas for a repository: the path prefixes its open PRs touch most often."""
    counts = Counter()
    for pr in prs:
        seen = set()
        for path in pr["files"]:
            parts = path.split("/")
            if len(parts) == 1:
                seen.add("(root files)")
            elif parts[0] in CONTAINER_DIRS and len(parts) > 2:
                seen.add("/".join(parts[:2]))
            else:
                seen.add(parts[0])
        counts.update(seen)
    top = [k for k, _ in counts.most_common(limit)]
    areas = {f"a{i}": ("Changes to files in the repository root" if k == "(root files)" else f"Changes under `{k}/`") for i, k in enumerate(top)}
    labels = {f"a{i}": k for i, k in enumerate(top)}
    areas["other"], labels["other"] = "Anything else", "Прочее"
    return areas, labels


def stage1_state(pr):
    paths = pr["files"]
    body = pr.get("body") or ""
    if len(body) < 200 and pr.get("ai_description"):
        body = (body + "\n\n[Summary of the diff written by a local model]\n" + pr["ai_description"]).strip()
    return {
        "title": pr["title"],
        "changed_files": paths[:40] + ([f"... and {len(paths) - 40} more files"] if len(paths) > 40 else []),
        "linked_issues": [f"#{i}" for i in pr.get("issues", [])],
        "description": body or "(no description)",
    }


def score_pr(pr, answers, now=None):
    """Priority for one PR from its stage-1 answers."""
    now = now or dt.datetime.now(dt.timezone.utc)
    a = answers
    kind = a["kind"]["choice"]
    rel, sev, val = a["relevance"]["score"] / 3, a["bug_severity"]["score"] / 4, a["feature_value"]["score"] / 4
    nz = {k: a[k]["noul"] for k in ("general", "clear", "tests", "risky", "runs_fail", "data_loss", "crash", "security_hole", "common_case", "new_capability")}
    harm = max(nz["runs_fail"], nz["data_loss"], nz["crash"], nz["security_hole"])
    lines = pr["additions"] + pr["deletions"]
    age = (now - dt.datetime.fromisoformat(pr["updated"].replace("Z", "+00:00"))).days
    penalties = {"risky": 12 * nz["risky"], "size": (8 if lines > 1000 else 0) + (10 if lines > 2500 else 0), "stale": 5 if age > 30 else 0}
    if kind in ("bugfix", "security", "performance"):
        track = "fix"
        parts = {"relevance": 40 * rel, "harm_common": 25 * harm * nz["common_case"], "severity": 15 * sev,
                 "general": 10 * nz["general"], "tests": 5 * nz["tests"], "clear": 5 * nz["clear"]}
    elif kind == "feature":
        track = "feature"
        parts = {"relevance": 40 * rel, "value": 30 * val, "new_capability": 15 * nz["new_capability"],
                 "general": 10 * nz["general"], "tests": 5 * nz["tests"]}
    else:
        track = "other"
        parts = {"relevance": 10 * rel}
    score = sum(parts.values()) - sum(penalties.values())
    return {
        "kind": kind, "area": a["area"]["choice"], "track": track, "age_days": age,
        "relevance": round(a["relevance"]["score"], 2), "bug_severity": round(a["bug_severity"]["score"], 2),
        "feature_value": round(a["feature_value"]["score"], 2), "harm": round(harm, 2),
        **{k: round(v, 2) for k, v in nz.items()},
        "score": round(score, 1),
        "breakdown": {**{k: round(v, 1) for k, v in parts.items()}, **{f"-{k}": round(v, 1) for k, v in penalties.items() if v}},
    }


def norm_title(t):
    return re.sub(r"^\w+(\([^)]*\))?!?:\s*", "", t.lower()).strip()


def mark_duplicates(rows, included):
    """PRs that close the same issue or share a normalized title form a group; the best one stays."""
    groups = {}
    for r in rows:
        for k in [f"i{i}" for i in r.get("issues") or []] + [f"t{norm_title(r['title'])}"]:
            groups.setdefault(k, []).append(r)
    for r in rows:
        r["duplicate_of"] = None
    for members in groups.values():
        if len(members) < 2:
            continue
        best = max(members, key=lambda r: (r["number"] in included, r.get("score", 0)))
        for r in members:
            if r is not best:
                r["duplicate_of"] = best["number"]


def ci_class(ci):
    if not ci or ci.get("none"):
        return "no_ci"
    real = [f for f in ci.get("failing", []) if not re.search(r"e2e|review|greptile|trust|security scan|codecov|lint-pr", f, re.I)]
    return "green" if ci.get("fail", 0) == 0 else ("flaky_only" if not real else "red")


def verdict(row, stage2):
    """take / consider / skip, with human-readable reasons."""
    m, ci, rv = stage2["merge"], stage2.get("ci"), stage2["review"]["answers"]
    q = {"quality": round(rv["quality"]["score"], 2), **{k: round(rv[k]["noul"], 2) for k in ("matches", "suspicious", "scope_creep", "real_tests", "changes_defaults", "promo")}}
    cic = ci_class(ci)
    lines = row["additions"] + row["deletions"]
    skip, consider, take = [], [], []
    if m["merge"] != "clean":
        files = ", ".join(x.split("/")[-1] for x in m.get("conflicts", [])[:3])
        skip.append("конфликт с основной веткой и взятыми PR" + (f": {files}" if files else ""))
    if q["suspicious"] > 0.3:
        skip.append(f"подозрительный код ({q['suspicious']})")
    if q["promo"] > 0.5:
        skip.append(f"продвигает сторонний сервис ({q['promo']})")
    if q["quality"] < 1.5:
        skip.append(f"слабое качество кода ({q['quality']}/3)")
    if q["matches"] < 0.5:
        skip.append(f"код не совпадает с описанием ({q['matches']})")
    if row["track"] == "fix":
        strong = row["harm"] * row["common_case"] >= 0.45 or (row["bug_severity"] >= 3 and row["common_case"] >= 0.6)
        (take if strong else consider).append(
            f"серьёзный баг в обычной работе (вред {row['harm']}, частота {row['common_case']})" if strong else "баг не критичный или редкий")
    else:
        strong = row["feature_value"] >= 3 and row["new_capability"] >= 0.5
        (take if strong else consider).append(
            f"сильная фича (ценность {row['feature_value']}/4, новизна {row['new_capability']})" if strong else "фича полезная, но не ключевая")
    if row["relevance"] >= 2.5:
        take.append(f"прямо про ваше использование ({row['relevance']}/3)")
    if cic == "red":
        failing = [f for f in ci["failing"] if not re.search(r"e2e|review|greptile|trust|security scan|codecov|lint-pr", f, re.I)]
        consider.append("падают тесты CI: " + ", ".join(failing)[:120])
    if row["risky"] >= 0.5:
        consider.append(f"рискованная область ({row['risky']})")
    if q["scope_creep"] >= 0.5:
        consider.append("лишние изменения в дифе")
    if row["track"] == "feature" and q["changes_defaults"] >= 0.6:
        consider.append("фича меняет поведение по умолчанию")
    if lines > 1500:
        consider.append(f"большой PR ({lines} строк)")
    v = "skip" if skip else ("take" if strong and not consider else "consider")
    return {"verdict": v, "review": q, "ci_class": cic, "reasons": {"skip": skip, "consider": consider, "take": take}}


# Anthropic list prices per 1M tokens (input, output), used only for the "Jev vs a generative model" estimate.
LLM_PRICES = {"Claude Opus 5.5": (4.0, 20.0), "Claude Sonnet 5": (2.0, 10.0), "Claude Haiku 4.5": (1.0, 5.0)}
# Tokens a generative model would write per Jev call (JSON + short reasoning), by stage.
OUTPUT_ESTIMATE = {"stage1": 1000, "stage2": 1500, "issues": 800, "forks": 800, "rivals": 400, "map": 300}


def latest_runs(runs):
    """The latest run of every stage, oldest first: what produced the data on screen.

    Runs accumulate over the life of a project, and stages are rerun on their own, so a sum
    over all of them counts reruns and stale data; the latest run per stage does not.
    """
    last = {}
    for r in runs:
        last[r.get("stage")] = r
    return sorted(last.values(), key=lambda r: r.get("started") or "")


def cost_comparison(runs):
    jev = [r for r in latest_runs(runs) if r.get("stage") in OUTPUT_ESTIMATE and r.get("input_tokens")]
    if not jev:
        return None
    inp = sum(r.get("input_tokens", 0) for r in jev)
    # forks and map ask Jev about a subset of their items; runs record that count as jev_calls
    out = sum(OUTPUT_ESTIMATE[r["stage"]] * r.get("jev_calls", r.get("items", 0)) for r in jev)
    rows = [{"name": "Jev (факт)", "cost": round(sum(r.get("cost_usd", 0) for r in jev), 4), "seconds": sum(r.get("seconds", 0) for r in jev), "actual": True}]
    for name, (pi, po) in LLM_PRICES.items():
        c = inp * pi / 1e6 + out * po / 1e6
        rows.append({"name": name, "cost": round(c, 2), "batch": round(c / 2, 2)})
    return {"input_tokens": inp, "output_estimate": out, "rows": rows}
