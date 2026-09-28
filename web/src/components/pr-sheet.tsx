import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight } from "lucide-react"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Bar, Pill, PrTags, Reasons, ScoreRing } from "@/components/pr-bits"
import { labelOf } from "@/hooks/use-project"
import { api, keys } from "@/lib/api"
import { ago, fmt } from "@/lib/format"
import { BREAKDOWN, VERDICT } from "@/lib/labels"
import type { Answer, Criteria } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useApp } from "@/store/app"

export function PrSheet({ slug, repo, criteria }: { slug: string; repo: string; criteria: Criteria }) {
  const n = useApp((s) => s.openPr)
  const setOpenPr = useApp((s) => s.setOpenPr)
  const q = useQuery({ queryKey: keys.pr(slug, n ?? 0), queryFn: () => api.pr(slug, n!), enabled: n != null })
  const d = q.data

  return (
    <Sheet open={n != null} onOpenChange={(o) => !o && setOpenPr(null)}>
      <SheetContent className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
        {!d ? (
          <div className="flex flex-col gap-4 p-10"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-24" /><Skeleton className="h-64" /></div>
        ) : (
          <div className="flex flex-col gap-11 px-10 pt-10 pb-16">
            <SheetHeader className="flex-row items-start gap-5 p-0 pr-8">
              <ScoreRing score={d.row?.score} size={76} />
              <div className="min-w-0 flex-1">
                <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                  <a href={`https://github.com/${repo}/pull/${d.pr.number}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono text-foreground hover:underline">
                    #{d.pr.number} на GitHub<ArrowUpRight className="size-3.5" />
                  </a>
                  <span>@{d.pr.author}</span>
                  <span>обновлён {ago(d.pr.updated)}</span>
                  <span className="tabular">+{fmt(d.pr.additions)} / −{fmt(d.pr.deletions)}</span>
                  <span>{d.pr.files.length} файлов</span>
                </SheetDescription>
                <SheetTitle className="mt-2 mb-3.5 text-2xl leading-tight font-semibold tracking-[-0.03em]">{d.pr.title}</SheetTitle>
                {d.row && <PrTags row={d.row} area={labelOf(criteria.areas, d.row.area)} />}
              </div>
            </SheetHeader>

            {d.row?.verdict && (
              <div className={cn("-mt-4 rounded-2xl px-6 py-5", { take: "bg-take-soft", consider: "bg-consider-soft", skip: "bg-skip-soft" }[d.row.verdict])}>
                <h3 className={cn("mb-3 text-base font-semibold tracking-tight", { take: "text-take", consider: "text-consider", skip: "text-foreground" }[d.row.verdict])}>{VERDICT[d.row.verdict]}</h3>
                <Reasons row={d.row} limit={10} />
              </div>
            )}
            {!d.row?.verdict && d.row?.included && <div className="-mt-4 rounded-2xl bg-take-soft px-6 py-5 font-semibold text-take">Уже взят в сборку</div>}

            {d.row?.breakdown && (
              <Section title={`Из чего сложился балл · место ${d.row.rank ?? "—"}`}>
                <Breakdown values={d.row.breakdown} />
              </Section>
            )}

            {d.stage2 && (
              <Section title="Этап 2 · код и совместимость">
                <div className="mb-3 flex flex-wrap gap-1.5">
                  <Pill tone={d.stage2.merge.merge === "clean" ? "take" : "danger"}>
                    {d.stage2.merge.merge === "clean" ? "ложится на основную ветку"
                      : `конфликт${d.stage2.merge.conflicts?.length ? ": " + d.stage2.merge.conflicts.map((f) => f.split("/").pop()).join(", ") : ""}`}
                  </Pill>
                  {(d.stage2.ci?.failing ?? []).map((f) => <Pill key={f} tone="outline">{f}</Pill>)}
                </div>
                <Answers answers={d.stage2.review.answers} criteria={criteria} />
              </Section>
            )}
            {d.stage1 && <Section title="Этап 1 · ответы Jev"><Answers answers={d.stage1.answers} criteria={criteria} /></Section>}

            <Section title="Описание автора">
              <p className="max-h-96 overflow-auto rounded-xl bg-muted px-5 py-4 text-[13.5px] leading-relaxed whitespace-pre-wrap text-foreground/80">{d.pr.body || "Автор ничего не написал."}</p>
            </Section>
            {d.pr.ai_description && (
              <Section title="Описание по дифу · локальная модель">
                <p className="rounded-xl bg-muted px-5 py-4 text-[13.5px] leading-relaxed whitespace-pre-wrap text-foreground/80 shadow-[inset_3px_0_0_var(--brand)]">{d.pr.ai_description}</p>
              </Section>
            )}
            <Section title="Файлы">
              <ul className="columns-1 gap-6 font-mono text-[12.5px] text-muted-foreground sm:columns-2">
                {d.pr.files.map((f) => <li key={f} className="truncate" title={f}>{f}</li>)}
              </ul>
            </Section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-4 text-[15px] font-semibold tracking-[-0.015em]">{title}</h3>
      {children}
    </section>
  )
}

export function Breakdown({ values }: { values: Record<string, number> }) {
  const max = Math.max(1, ...Object.values(values).map(Math.abs))
  return (
    <div className="flex flex-col gap-3">
      {Object.entries(values).map(([k, v]) => {
        const neg = k.startsWith("-")
        return (
          <div key={k} className="grid grid-cols-[170px_1fr_52px] items-center gap-4 text-[13.5px] text-foreground/80">
            <span>{BREAKDOWN[k] ?? k}</span>
            <Bar value={Math.abs(v)} max={max} tone={neg ? "danger" : "ink"} />
            <span className="text-right text-muted-foreground tabular">{neg ? "−" : "+"}{fmt(Math.abs(v), 1)}</span>
          </div>
        )
      })}
    </div>
  )
}

function Answers({ answers, criteria }: { answers: Record<string, Answer>; criteria: Criteria }) {
  return (
    <div className="divide-y">
      {Object.entries(answers).map(([k, a]) => (
        <div key={k} className="grid gap-2 py-4 text-[13.5px] sm:grid-cols-[220px_1fr] sm:gap-5">
          <span className="font-medium">{criteria.labels[k] ?? k}</span>
          <AnswerValue k={k} a={a} criteria={criteria} />
        </div>
      ))}
    </div>
  )
}

function AnswerValue({ k, a, criteria }: { k: string; a: Answer; criteria: Criteria }) {
  if (a.type === "noul") {
    const v = a.noul ?? 0
    const tone = criteria.negative.includes(k) && v >= 0.5 ? "danger" : v >= 0.34 ? "ink" : "muted"
    return (
      <span className="grid max-w-xs grid-cols-[1fr_44px] items-center gap-3 tabular">
        <Bar value={v} max={1} tone={tone} />
        <b className="font-semibold">{fmt(v, 2)}</b>
      </span>
    )
  }
  const legend = a.type === "choice" ? (k === "area" ? criteria.areas : k === "kind" ? criteria.kinds : undefined) : a.legend
  const probs = Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 6)
  return (
    <div className="flex flex-col gap-2">
      <span className="flex flex-wrap items-center gap-2">
        <b className="font-semibold">{a.type === "choice" ? labelOf(legend, a.choice) : fmt(a.score, 2)}</b>
        {a.type === "score" && <span className="text-muted-foreground">из {Object.keys(a.legend ?? {}).length - 1}</span>}
        <Pill tone="outline">уверенность {fmt((a.confidence ?? 0) * 100)}%</Pill>
      </span>
      <div className="flex flex-col gap-1.5">
        {probs.map(([key, p]) => (
          <div key={key} className={cn("grid grid-cols-[1fr_80px_40px] items-center gap-3 text-foreground/70", key === String(a.choice) && "font-semibold text-foreground")}>
            <span>{legend?.[key] ?? key}</span>
            <Bar value={p} max={1} />
            <span className="text-right text-muted-foreground tabular">{fmt(p * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}
