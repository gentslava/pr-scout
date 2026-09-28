import { Play, Rocket } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ScoreHistogram } from "@/components/charts"
import { HBars, Pill, ScoreRing } from "@/components/pr-bits"
import { Panel } from "@/components/views/overview"
import { classifiedRows, labelOf, lastRun, useStartJob } from "@/hooks/use-project"
import { ago, count, fmt, money, secs } from "@/lib/format"
import { stepOfJob, TRACK } from "@/lib/labels"
import type { Criteria, PrRow, Summary } from "@/lib/types"
import type { FeedItem } from "@/store/app"
import { useApp } from "@/store/app"

export function RunView({ slug, summary, prs, criteria }: { slug: string; summary: Summary; prs: PrRow[]; criteria: Criteria }) {
  const job = useApp((s) => s.job)
  const live = useApp((s) => s.live)
  const setOpenPr = useApp((s) => s.setOpenPr)
  const start = useStartJob(slug)
  const running = job?.project === slug ? job.running : null
  const step = stepOfJob(running)
  const hasLive = running || live.total > 0

  // idle: show what the last run produced; live: what is happening right now
  const rows = classifiedRows(prs)
  const jev = [lastRun(summary.runs, "stage1"), lastRun(summary.runs, "stage2")].filter((r) => !!r)
  const sum = (k: "seconds" | "items" | "input_tokens" | "cost_usd") => jev.reduce((a, r) => a + (r[k] ?? 0), 0)
  const last = summary.runs.at(-1)
  const stats = hasLive
    ? [[`${fmt(live.done)} / ${fmt(live.total)}`, "готово"], [secs(live.seconds), "прошло"], [fmt(live.seconds ? live.done / live.seconds : 0, 1), "в секунду"], [fmt(live.tokens), "токенов Jev"], [money(live.cost), "стоимость"]]
    : [[fmt(rows.length), "оценено Jev"], [secs(sum("seconds")), "время Jev"], [fmt(sum("seconds") ? sum("items") / sum("seconds") : 0, 1), "PR в секунду"], [fmt(sum("input_tokens")), "токенов Jev"], [money(sum("cost_usd")), "стоимость"]]
  const scores = hasLive ? live.scores : rows.map((r) => r.score ?? 0)
  const areas = hasLive ? live.areas : rows.reduce<Record<string, number>>((a, r) => ((a[r.area ?? "other"] = (a[r.area ?? "other"] ?? 0) + 1), a), {})

  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-0 rounded-2xl px-8 py-8 shadow-card ring-foreground/[0.07]">
        <div className="flex flex-wrap items-center gap-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-semibold tracking-[-0.03em]">{running ? `Идёт: ${step?.title ?? "прогон"}` : "Готов к прогону"}</h2>
            <p className="mt-1.5 text-[13.5px] text-muted-foreground">
              {running
                ? live.message || step?.by
                : `${last ? `Последний прогон ${ago(last.started)}. ` : ""}Полный прогон: сбор PR → описания → классификация Jev → мерж и ревью кода финалистов. Весь цикл добавляет issues, конкурирующие PR, форки, стек и карту мержей.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="lg" className="h-10 rounded-full px-5 shadow-card" disabled={!!job || start.isPending} onClick={() => start.mutate("everything")}>
              <Rocket /> Весь цикл
            </Button>
            <Button size="lg" className="h-10 rounded-full px-5" disabled={!!job || start.isPending} onClick={() => start.mutate("full")}>
              <Play className="fill-current" /> Полный прогон
            </Button>
          </div>
        </div>
        <dl className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-5">
          {stats.map(([v, l]) => (
            <div key={l}>
              <dd className="text-[28px] font-semibold tracking-[-0.035em] tabular">{v}</dd>
              <dt className="text-[13px] text-muted-foreground">{l}</dt>
            </div>
          ))}
        </dl>
        {hasLive && <Progress value={live.total ? (live.done / live.total) * 100 : 0} className="mt-7 h-1.5 [&>*]:bg-brand" />}
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Panel title="Поток ответов" note={live.total ? `${fmt(live.done)} / ${fmt(live.total)}` : undefined}>
          {live.feed.length === 0 ? (
            <Empty className="h-[520px]">
              <EmptyHeader><EmptyDescription>Запустите прогон — здесь в реальном времени появятся PR, issues и форки и то, как их оценил Jev.</EmptyDescription></EmptyHeader>
            </Empty>
          ) : (
            <ScrollArea className="-mx-3 h-[520px]">
              <ul className="flex flex-col gap-0.5 px-3">
                {live.feed.map((it) => {
                  if (it.kind === "issue" || it.kind === "fork") return <li key={it.key}><ExternalFeedItem it={it} repo={summary.config.repo} /></li>
                  const n = it.kind === "row" ? it.row.number : it.number
                  const title = it.kind === "row" ? it.row.title : it.kind === "describe" ? it.title : prs.find((r) => r.number === it.number)?.title
                  return (
                    <li key={it.key}>
                      <button onClick={() => setOpenPr(n)} className="grid w-full animate-in grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-xl px-3 py-3 text-left fade-in slide-in-from-left-2 hover:bg-muted">
                        <span className="font-mono text-xs text-muted-foreground">#{n}</span>
                        <span className="min-w-0">
                          <span className="block leading-snug font-medium">{title}</span>
                          {it.kind === "row" && (
                            <span className="mt-1.5 flex flex-wrap gap-1.5">
                              {it.row.track && <Pill>{TRACK[it.row.track]}</Pill>}
                              <Pill tone="outline">{labelOf(criteria.areas, it.row.area)}</Pill>
                            </span>
                          )}
                          {it.kind === "describe" && <span className="mt-1 line-clamp-2 block text-[12.5px] text-muted-foreground">✎ {it.preview}…</span>}
                        </span>
                        {it.kind === "row" && <ScoreRing score={it.row.score} size={40} />}
                        {it.kind === "describe" && <Pill tone="brand">{summary.config.ollama?.provider === "nordrouter" ? "NordRouter" : "Ollama"}</Pill>}
                        {it.kind === "merge" && <Pill tone={it.clean ? "take" : "danger"}>{it.clean ? "ложится" : "конфликт"}</Pill>}
                        {it.kind === "stack" && <Pill tone={it.result === "merged" ? "take" : it.result === "conflict" ? "danger" : "outline"}>{STACK_RESULT[it.result] ?? it.result}</Pill>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </ScrollArea>
          )}
        </Panel>
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Как распределяются баллы">
            {scores.length ? <ScoreHistogram scores={scores} className="aspect-auto h-48 w-full" /> : <p className="py-10 text-center text-sm text-muted-foreground">Пока нет оценок</p>}
          </Panel>
          <Panel title="По частям системы">
            {Object.keys(areas).length ? <HBars counts={areas} label={(k) => labelOf(criteria.areas, k)} /> : <p className="py-6 text-center text-sm text-muted-foreground">Пока пусто</p>}
          </Panel>
        </div>
      </div>
    </div>
  )
}

const STACK_RESULT: Record<string, string> = { merged: "влился в стек", conflict: "конфликт в стеке", "нет ветки": "нет ветки" }

/** Issues and forks live on GitHub, not in the PR sheet: their feed rows link out. */
function ExternalFeedItem({ it, repo }: { it: Extract<FeedItem, { kind: "issue" | "fork" }>; repo: string }) {
  const href = it.kind === "issue" ? `https://github.com/${repo}/issues/${it.number}` : `https://github.com/${it.fork}`
  return (
    <a href={href} target="_blank" rel="noreferrer"
      className="grid w-full animate-in grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-xl px-3 py-3 text-left fade-in slide-in-from-left-2 hover:bg-muted">
      <span className="truncate font-mono text-xs text-muted-foreground">{it.kind === "issue" ? `issue #${it.number}` : "форк"}</span>
      <span className="min-w-0">
        <span className="block leading-snug font-medium">{it.kind === "issue" ? it.title : it.fork}</span>
        <span className="mt-1.5 flex flex-wrap gap-1.5">
          {it.label && <Pill>{it.label}</Pill>}
          {it.kind === "issue" && <Pill tone={it.hasPr ? "outline" : "consider"}>{it.hasPr ? "есть PR" : "без PR"}</Pill>}
          {it.kind === "fork" && <Pill tone="outline">+{count(it.ahead, "коммит", "коммита", "коммитов")}</Pill>}
        </span>
        {it.kind === "fork" && it.commits.length > 0 && <span className="mt-1 line-clamp-1 block text-[12.5px] text-muted-foreground">{it.commits.at(-1)}</span>}
      </span>
      {it.score != null ? <ScoreRing score={it.score} size={40} /> : <Pill tone="danger">ошибка</Pill>}
    </a>
  )
}
