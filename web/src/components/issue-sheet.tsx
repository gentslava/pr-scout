import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight } from "lucide-react"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Bar, Pill, ScoreRing } from "@/components/pr-bits"
import { Breakdown, Section } from "@/components/pr-sheet"
import { api, keys } from "@/lib/api"
import { ago, count, fmt } from "@/lib/format"
import type { Answer, PrRow } from "@/lib/types"
import { useApp } from "@/store/app"

/** The issue counterpart of the PR sheet: same place, same layout, the GitHub link inside. */
export function IssueSheet({ slug, repo, prs }: { slug: string; repo: string; prs: PrRow[] }) {
  const n = useApp((s) => s.openIssue)
  const setOpenIssue = useApp((s) => s.setOpenIssue)
  const setOpenPr = useApp((s) => s.setOpenPr)
  const q = useQuery({ queryKey: keys.issue(slug, n ?? 0), queryFn: () => api.issue(slug, n!), enabled: n != null })
  const d = q.data
  const titles = new Map(prs.map((p) => [p.number, p.title]))

  return (
    <Sheet open={n != null} onOpenChange={(o) => !o && setOpenIssue(null)}>
      <SheetContent className="gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
        {!d ? (
          <div className="flex flex-col gap-4 p-10"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-24" /><Skeleton className="h-64" /></div>
        ) : (
          <div className="flex flex-col gap-11 px-10 pt-10 pb-16">
            <SheetHeader className="flex-row items-start gap-5 p-0 pr-8">
              <ScoreRing score={d.row?.score} size={76} />
              <div className="min-w-0 flex-1">
                <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
                  <a href={`https://github.com/${repo}/issues/${d.issue.number}`} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-0.5 font-mono text-foreground hover:underline">
                    issue #{d.issue.number} на GitHub<ArrowUpRight className="size-3.5" />
                  </a>
                  <span>@{d.issue.author}</span>
                  <span>обновлена {ago(d.issue.updated)}</span>
                  <span>{count(d.issue.comments, "комментарий", "комментария", "комментариев")}</span>
                </SheetDescription>
                <SheetTitle className="mt-2 mb-3.5 text-2xl leading-tight font-semibold tracking-[-0.03em]">{d.issue.title}</SheetTitle>
                <div className="flex flex-wrap gap-1.5">
                  {d.row?.kind_label && <Pill>{d.row.kind_label}</Pill>}
                  {d.row && <Pill tone={d.row.open_pr.length ? "outline" : "consider"}>{d.row.open_pr.length ? "есть PR" : "никто не взялся"}</Pill>}
                  {d.issue.labels.map((l) => <Pill key={l} tone="outline">{l}</Pill>)}
                </div>
              </div>
            </SheetHeader>

            {d.row && d.row.open_pr.length > 0 && (
              <Section title="Кто уже закрывает">
                <ul className="flex flex-col gap-1">
                  {d.row.open_pr.map((pr) => (
                    <li key={pr}>
                      {titles.has(pr) ? (
                        <button onClick={() => setOpenPr(pr)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13.5px] hover:bg-muted">
                          <span className="font-mono text-xs text-muted-foreground">#{pr}</span>
                          <span className="truncate">{titles.get(pr)}</span>
                        </button>
                      ) : (
                        <a href={`https://github.com/${repo}/pull/${pr}`} target="_blank" rel="noreferrer"
                          className="flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13.5px] hover:bg-muted">
                          <span className="font-mono text-xs text-muted-foreground">#{pr}</span>
                          <span className="text-muted-foreground">PR вне списка</span><ArrowUpRight className="size-3.5" />
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {d.row?.breakdown && (
              <Section title="Из чего сложился балл"><Breakdown values={d.row.breakdown} /></Section>
            )}

            {d.answers && (
              <Section title="Ответы Jev">
                <div className="divide-y">
                  {Object.entries(d.answers).map(([k, a]) => (
                    <div key={k} className="grid gap-2 py-3.5 text-[13.5px] sm:grid-cols-[240px_1fr] sm:gap-5">
                      <span className="font-medium">{d.labels[k] ?? k}</span>
                      <AnswerValue k={k} a={a} kinds={d.kinds} />
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section title="Текст issue">
              <p className="max-h-[28rem] overflow-auto rounded-xl bg-muted px-5 py-4 text-[13.5px] leading-relaxed whitespace-pre-wrap text-foreground/80">
                {d.issue.body || "Автор ничего не написал."}
              </p>
            </Section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** A compact answer: the chosen kind, a score out of its scale, or a yes/no probability. */
const SCALE: Record<string, number> = { severity: 4, relevance: 3 }

function AnswerValue({ k, a, kinds }: { k: string; a: Answer; kinds: Record<string, string> }) {
  if (a.type === "choice") {
    return <span className="flex flex-wrap items-center gap-2"><b className="font-semibold">{kinds[a.choice ?? ""] ?? a.choice}</b>
      <Pill tone="outline">уверенность {fmt((a.confidence ?? 0) * 100)}%</Pill></span>
  }
  const [v, max] = a.type === "score" ? [a.score ?? 0, SCALE[k] ?? (a.legend ? Object.keys(a.legend).length - 1 : 4)] : [a.noul ?? 0, 1]
  return (
    <span className="grid max-w-xs grid-cols-[1fr_56px] items-center gap-3 tabular">
      <Bar value={v} max={max} tone={v / max >= 0.34 ? "ink" : "muted"} />
      <b className="font-semibold">{fmt(v, a.type === "score" ? 1 : 2)}{a.type === "score" ? ` / ${max}` : ""}</b>
    </span>
  )
}
