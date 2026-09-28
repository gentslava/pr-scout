"""The whole cycle of one project as a markdown document.

Pure formatting over the in-memory project (the same structure main.py keeps per slug):
PR verdicts, open issues, forks, rival PRs, the stack and the merge map. No IO here.
"""
import datetime as dt

from scoring import KIND_LABELS, cost_comparison

PLAN_TITLES = {
    "safe": "Безопасный — максимум по баллу без конфликтов внутри",
    "all_in": "Всё в одно — конфликты разбираем руками",
    "top_score": "Топ по баллу — цена поддержки не важна",
    "low_churn": "Минимум поверхности — что реже ломается апстримом",
    "by_area": "По одному на подсистему — шире, а не глубже",
}


def last_cycle(runs):
    """Runs of the latest cycle: everything since the last PR fetch (runs accumulate over time)."""
    cycle = []
    for r in reversed(runs):
        cycle.append(r)
        if r.get("stage") == "fetch":
            break
    return list(reversed(cycle))


def build_report(P):
    cfg = P["config"]
    repo = cfg["repo"]
    areas = cfg.get("area_labels") or {}
    rows = [r for r in P["rows"].values() if r.get("classified")]
    cycle = last_cycle(P["runs"])
    cost = sum(r.get("cost_usd") or 0 for r in cycle)
    tokens = sum(r.get("input_tokens") or 0 for r in cycle)

    def pr_link(n):
        return f"[#{n}](https://github.com/{repo}/pull/{n})"

    def pr_line(r):
        out = [f"**{pr_link(r['number'])}** {r['title']}",
               f"`{KIND_LABELS.get(r.get('kind'), r.get('kind'))}` · {areas.get(r.get('area'), r.get('area'))} · "
               f"@{r.get('author')} · балл **{r.get('score')}** · {r.get('additions', 0)}+{r.get('deletions', 0)} строк"
               + (f" · CI: {r['ci_class']}" if r.get("ci_class") else "")]
        why = r.get("reasons") or {}
        for key, mark in (("skip", "✗"), ("consider", "!"), ("take", "+")):
            out += [f"  - {mark} {item}" for item in why.get(key) or []]
        return "\n".join(out) + "\n"

    by = {"take": [], "consider": [], "skip": [], "none": []}
    for r in sorted(rows, key=lambda r: -(r.get("score") or 0)):
        by[r.get("verdict") if r.get("verdict") in by else "none"].append(r)

    out = [f"# PR Scout: {repo}", "", f"Отчёт от {dt.date.today().isoformat()}. "
           f"PR с баллами: {len(rows)}, финалистов: {len(P['finalists'])}. "
           f"Последний цикл: Jev потратил ${cost:.4f} ({tokens:,} входных токенов).".replace(f"{tokens:,}", f"{tokens:,}".replace(",", " ")), ""]
    for r in cycle:
        out.append(f"- `{r.get('stage')}`: {r.get('items')} шт · {r.get('seconds')} с · ${r.get('cost_usd') or 0} · ошибок {r.get('errors') or 0}")
    comp = cost_comparison(cycle)
    if comp:
        out += ["", "| вариант | цена цикла |", "|---|---:|"]
        out += [f"| {row['name']} | ${row['cost']} |" for row in comp["rows"]]

    out += ["", f"## Берём ({len(by['take'])})", ""] + ([pr_line(r) for r in by["take"]] or ["—"])
    out += ["", f"## Рассмотреть ({len(by['consider'])})", ""] + ([pr_line(r) for r in by["consider"][:60]] or ["—"])
    out += ["", f"## Пропускаем ({len(by['skip'])})", ""] + ([pr_line(r) for r in by["skip"]] or ["—"])

    issues = list((P.get("issue_rows") or {}).values())
    if issues:
        ranked = sorted([i for i in issues if i.get("classified")], key=lambda i: -(i.get("score") or 0))
        open_ = [i for i in ranked if not i.get("open_pr")]
        covered = [i for i in ranked if i.get("open_pr")]
        out += ["", f"# Issues: {len(issues)} открытых, {len(open_)} без единого PR", "", "## Важное, на что PR нет", ""]
        for i in open_[:40]:
            out.append(f"**[#{i['number']}](https://github.com/{repo}/issues/{i['number']})** {i['title']} — "
                       f"балл **{i.get('score')}**, `{i.get('kind_label')}`, серьёзность {i.get('severity')}/4, "
                       f"релевантность {i.get('relevance')}/3, {i.get('comments')} комм.\n")
        out += ["", f"## Уже закрываются открытым PR ({len(covered)})", ""]
        for i in covered[:25]:
            out.append(f"**#{i['number']}** {i['title']} — балл {i.get('score')}, PR: " + ", ".join(pr_link(n) for n in i["open_pr"][:6]) + "\n")

    rivals = P.get("rivals") or {}
    if rivals:
        out += ["", f"# Один issue — несколько PR ({len(rivals)} групп)", ""]
        for issue_no, r in sorted(rivals.items(), key=lambda kv: -(kv[1].get("confidence") or 0)):
            pick = f"берём {pr_link(r['chosen_pr'])}" if r.get("chosen_pr") else "ни один не годится"
            out.append(f"- issue #{issue_no} ({r.get('issue_title') or '—'}): {', '.join(f'#{n}' for n in (r.get('candidates') or [])[:8])} "
                       f"→ **{pick}** (уверенность {r.get('confidence')})")

    forks = list((P.get("fork_rows") or {}).values())
    if forks:
        uniq = sorted([f for f in forks if f.get("classified") and not f.get("duplicate_of")], key=lambda f: -(f.get("score") or 0))
        clones = [f for f in forks if f.get("duplicate_of")]
        out += ["", f"# Форки: проверено {len(forks)}, с работой впереди апстрима {sum(1 for f in forks if (f.get('ahead') or 0) > 0)}",
                f"Уникальных кандидатов после схлопывания клонов: **{len(uniq)}** (клонов: {len(clones)}).", "",
                "## Форки, которые стоит разобрать", ""]
        for f in uniq[:40]:
            out.append(f"**[{f['fork']}](https://github.com/{f['fork']})** — балл **{f.get('score')}**, `{f.get('kind_label')}`, "
                       f"впереди {f.get('ahead')} коммитов, ±{f.get('lines')} строк, ★{f.get('stars')}, пуш {str(f.get('pushed'))[:10]}")
            out += [f"  - `{c.get('sha')}` {c.get('message')}" for c in (f.get("commits") or [])[-5:]]
            out.append("")

    stack = P.get("stack") or {}
    if stack:
        hot, patch = stack.get("hot") or {}, stack.get("patch") or {}
        out += ["", "# Стек: цена поддержки", "",
                f"- собирали: {stack.get('considered')} PR ({', '.join(stack.get('verdicts') or [])}) поверх {len(stack.get('included') or [])} уже взятых",
                f"- влились чисто: **{stack.get('merged')}**, конфликтов: **{stack.get('conflicted')}** ({stack.get('merge_cost')}%)",
                f"- объём патча: {patch.get('files')} файлов, {patch.get('shortstat') or '—'}",
                f"- поверхность будущих конфликтов: **{hot.get('churn_share')}%** правок апстрима за {hot.get('commits_scanned')} коммитов "
                f"приходится на файлы стека", ""]
        for c in stack.get("conflicts") or []:
            out.append(f"- конфликт {pr_link(c['number'])}: " + ", ".join(c.get("files") or []))

    mp = P.get("map") or {}
    if mp:
        plans = mp.get("plans") or {}
        out += ["", "# Карта мёрджей", "",
                f"Кандидатов {len(mp.get('candidates') or [])}, пар {mp.get('pairs')}, тестовых мержей {mp.get('pairs_merged')}, "
                f"смысловых сравнений {mp.get('pairs_semantic')}.", "",
                "| расклад | берём | сумма баллов | конфликтов внутри | файлов | горячих правок |", "|---|---:|---:|---:|---:|---:|"]
        for key, title in PLAN_TITLES.items():
            p = plans.get(key)
            if p:
                out.append(f"| {title} | {p.get('count')} | {p.get('score_sum')} | {p.get('conflicts')} | {p.get('files')} | {p.get('hot_share')}% |")
        safe = plans.get("safe")
        if safe:
            out += ["", "## Безопасный расклад", ""]
            for m in safe.get("members") or []:
                what = f"{pr_link(m['number'])} {m['title']}" if m["kind"] == "pr" else f"форк [{m['repo']}](https://github.com/{m['repo']})"
                out.append(f"- {what} — балл {m.get('score')}")
    return "\n".join(out) + "\n"
