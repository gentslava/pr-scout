import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { KindDonut, ScoreHistogram } from "@/components/charts"
import { HBars, Pill, PrTags, Reasons, ScoreRing } from "@/components/pr-bits"
import { StatCards } from "@/components/stat-cards"
import { classifiedRows, jevRuns, labelOf } from "@/hooks/use-project"
import { fmt, money, secs } from "@/lib/format"
import { VERDICT, VERDICT_HINT } from "@/lib/labels"
import type { Criteria, PrRow, Summary, Verdict } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useApp } from "@/store/app"

export function Overview({ summary, prs, criteria }: { summary: Summary; prs: PrRow[]; criteria: Criteria }) {
  return (
    <div className="flex flex-col gap-16">
      <Kpis summary={summary} prs={prs} />
      <Board prs={prs} criteria={criteria} />
      <Insights prs={prs} criteria={criteria} />
    </div>
  )
}

function Kpis({ summary, prs }: { summary: Summary; prs: PrRow[] }) {
  const by = (v: Verdict) => prs.filter((r) => r.verdict === v).length
  const jev = jevRuns(summary.runs)
  const cost = jev.reduce((a, r) => a + (r.cost_usd ?? 0), 0)
  const time = jev.reduce((a, r) => a + (r.seconds ?? 0), 0)
  return (
    <StatCards items={[
      { label: "Открытых PR", value: fmt(summary.total), sub: `${fmt(summary.finalists)} дошли до ревью кода` },
      { label: "Берём", value: fmt(by("take")), sub: "сильные и чистые", dot: "bg-take" },
      { label: "Рассмотреть", value: fmt(by("consider")), sub: `есть оговорки · ${fmt(by("skip"))} пропускаем`, dot: "bg-consider" },
      { label: "Jev обошёлся в", value: money(cost), sub: `за ${secs(time)} работы`, accent: true },
    ]} />
  )
}

const PILL_TONE = { take: "take", consider: "consider", skip: "skip" } as const

function Board({ prs, criteria }: { prs: PrRow[]; criteria: Criteria }) {
  const setOpenPr = useApp((s) => s.setOpenPr)
  const setTab = useApp((s) => s.setTab)
  const finalists = prs.filter((r) => r.verdict).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  if (!finalists.length) {
    return (
      <Empty className="rounded-2xl border bg-card">
        <EmptyHeader>
          <EmptyTitle>Вердиктов пока нет</EmptyTitle>
          <EmptyDescription>Этап 2 ещё не запускался. Запустите «Полный прогон» — финалисты пройдут мерж и ревью кода.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="grid items-start gap-7 lg:grid-cols-3">
      {(["take", "consider", "skip"] as const).map((v) => {
        const list = finalists.filter((r) => r.verdict === v)
        const shown = list.slice(0, v === "skip" ? 12 : 40)
        return (
          <section key={v} className="min-w-0">
            <div className="flex items-center gap-2.5 px-1">
              <h2 className="text-xl font-semibold tracking-[-0.025em]">{VERDICT[v]}</h2>
              <Pill tone={PILL_TONE[v]} className="tabular">{list.length}</Pill>
            </div>
            <p className="mt-1.5 mb-5 px-1 text-[13.5px] text-muted-foreground">{VERDICT_HINT[v]}</p>
            <div className="flex flex-col gap-3">
              {shown.map((r) => (
                <Card key={r.number} role="button" tabIndex={0} onClick={() => setOpenPr(r.number)} onKeyDown={(e) => e.key === "Enter" && setOpenPr(r.number)}
                  className="gap-4 rounded-2xl px-5 py-5 shadow-card ring-foreground/[0.07] transition hover:-translate-y-px hover:shadow-float hover:ring-foreground/15">
                  <div className="flex gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-xs text-muted-foreground">#{r.number} · @{r.author}</p>
                      <h3 className="mt-1.5 text-[15px] leading-snug font-semibold tracking-[-0.012em]">{r.title}</h3>
                    </div>
                    <ScoreRing score={r.score} />
                  </div>
                  <PrTags row={r} area={labelOf(criteria.areas, r.area)} />
                  <Reasons row={r} limit={v === "skip" ? 1 : 2} />
                </Card>
              ))}
              {list.length > shown.length && (
                <button className="px-1 py-2 text-left text-[13px] text-muted-foreground hover:text-foreground" onClick={() => setTab("all")}>
                  …и ещё {list.length - shown.length} во вкладке «Все PR»
                </button>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function Insights({ prs, criteria }: { prs: PrRow[]; criteria: Criteria }) {
  const rows = classifiedRows(prs)
  const count = (key: "area" | "kind") => rows.reduce<Record<string, number>>((a, r) => ((a[r[key] ?? "other"] = (a[r[key] ?? "other"] ?? 0) + 1), a), {})
  return (
    <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-[1.3fr_1fr_1fr]">
      <Panel title="По частям системы" note={`${fmt(rows.length)} PR`}>
        <HBars counts={count("area")} label={(k) => labelOf(criteria.areas, k)} />
      </Panel>
      <Panel title="По типу изменения">
        <KindDonut counts={count("kind")} label={(k) => labelOf(criteria.kinds, k)} />
      </Panel>
      <Panel title="Распределение балла" note="0–100">
        <ScoreHistogram scores={rows.map((r) => r.score ?? 0)} />
      </Panel>
    </div>
  )
}

export function Panel({ title, note, action, children, className }: { title: string; note?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("min-w-0 gap-5 rounded-2xl px-7 py-7 shadow-card ring-foreground/[0.07]", className)}>
      <CardHeader className="flex items-center justify-between gap-3 p-0">
        <CardTitle className="text-[15px] font-semibold tracking-[-0.015em]">{title}</CardTitle>
        {note && <span className="text-[13px] text-muted-foreground">{note}</span>}
        {action}
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  )
}
