import { useMemo, useState } from "react"
import { ArrowDownWideNarrow, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Meter, Pill, ScoreRing } from "@/components/pr-bits"
import { StageEmpty, StatCards } from "@/components/stat-cards"
import { Panel } from "@/components/views/overview"
import { useIssues } from "@/hooks/use-project"
import { ago, count, fmt } from "@/lib/format"
import type { IssueRow, PrRow, Rival, Summary } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useApp } from "@/store/app"

const PAGE = 60
type Coverage = "open" | "covered" | "all"
type Sort = "score" | "severity" | "updated"

/** An issue deserves someone's time: it scores high, a code change can close it, and it is not "works as designed" or a support question. */
const worthAttention = (r: IssueRow) =>
  (r.score ?? 0) >= 50 && (r.actionable ?? 1) >= 0.5 && (r.by_design ?? 0) < 0.5 && r.kind !== "question"

export function IssuesView({ slug, summary, prs }: { slug: string; summary: Summary; prs: PrRow[] }) {
  const issues = useIssues(slug)
  if (issues.isPending) return <Skeleton className="h-96 rounded-2xl" />
  const rows = (issues.data ?? []).filter((r) => r.classified)
  return (
    <div className="flex flex-col gap-10">
      {rows.length ? (
        <>
          <StatCards items={[
            { label: "Открытых issues", value: fmt(summary.issues.total), sub: `${fmt(summary.issues.classified)} разобрал Jev` },
            { label: "Без единого PR", value: fmt(summary.issues.without_pr), sub: "работа, за которую никто не взялся", dot: "bg-consider" },
            { label: "Стоят внимания без PR", value: fmt(rows.filter((r) => !r.open_pr.length && worthAttention(r)).length), sub: "важные, решаются кодом, никто не взялся", dot: "bg-danger" },
            { label: "Уже закрываются PR", value: fmt(rows.filter((r) => r.open_pr.length).length), sub: `${fmt(summary.rivals.groups)} — сразу несколькими`, dot: "bg-take" },
          ]} />
          <IssueTable rows={rows} repo={summary.config.repo} prs={prs} />
        </>
      ) : (
        <StageEmpty slug={slug} job="issues" title="Issues ещё не разбирались">
          Scout соберёт открытые issues и спросит Jev про каждую: что это, насколько больно и важно ли для вашего сценария.
          Главное — issues, на которые ещё нет ни одного PR: это работа, которую никто не делает.
        </StageEmpty>
      )}
      <Rivals slug={slug} summary={summary} prs={prs} />
    </div>
  )
}

function IssueTable({ rows, repo, prs }: { rows: IssueRow[]; repo: string; prs: PrRow[] }) {
  const setOpenPr = useApp((s) => s.setOpenPr)
  const setOpenIssue = useApp((s) => s.setOpenIssue)
  const [query, setQuery] = useState("")
  const [coverage, setCoverage] = useState<Coverage>("open")
  const [kind, setKind] = useState("all")
  const [attention, setAttention] = useState(true)
  const [sort, setSort] = useState<Sort>("score")
  const [shown, setShown] = useState(PAGE)
  const known = useMemo(() => new Set(prs.map((p) => p.number)), [prs])
  const kinds = useMemo(() => [...new Map(rows.filter((r) => r.kind).map((r) => [r.kind!, r.kind_label ?? r.kind!])).entries()], [rows])

  const data = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows
      .filter((r) => (coverage === "all" || (coverage === "open" ? !r.open_pr.length : r.open_pr.length > 0))
        && (!attention || worthAttention(r))
        && (kind === "all" || r.kind === kind)
        && (!q || String(r.number).includes(q) || r.title.toLowerCase().includes(q) || r.labels.some((l) => l.toLowerCase().includes(q))))
      .sort(sort === "updated" ? (a, b) => b.updated.localeCompare(a.updated)
        : sort === "severity" ? (a, b) => (b.severity ?? 0) - (a.severity ?? 0) || (b.score ?? 0) - (a.score ?? 0)
        : (a, b) => (b.score ?? 0) - (a.score ?? 0))
  }, [rows, query, coverage, kind, attention, sort])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE) }} placeholder="Номер, заголовок или метка"
            className="h-10 rounded-full bg-card pl-10 shadow-card" />
        </div>
        <ToggleGroup type="single" value={coverage} onValueChange={(v) => { if (v) { setCoverage(v as Coverage); setShown(PAGE) } }} variant="outline"
          className="h-10 rounded-full bg-card p-1 shadow-card">
          {([["open", "Без PR"], ["covered", "С PR"], ["all", "Все"]] as const).map(([v, l]) => (
            <ToggleGroupItem key={v} value={v} className="h-8 rounded-full border-0 px-3.5 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">{l}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Select value={kind} onValueChange={(v) => { setKind(v); setShown(PAGE) }}>
          <SelectTrigger className="h-10! min-w-48 rounded-full bg-card px-4 shadow-card"><SelectValue /></SelectTrigger>
          <SelectContent position="popper" sideOffset={6}>
            <SelectItem value="all">Любой тип</SelectItem>
            {kinds.map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger asChild>
            <label className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground/80">
              <Switch checked={attention} onCheckedChange={(v) => { setAttention(v); setShown(PAGE) }} /> Стоят внимания
            </label>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            Балл от 50, решается правкой кода; без вопросов в поддержку и «так задумано». Выключите, чтобы увидеть все issues.
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="-mb-3 flex items-center justify-between gap-3 px-1">
        <span className="text-[13px] text-muted-foreground tabular">{count(data.length, "issue", "issues", "issues")}</span>
        {/* sorting reorders what the filters above left; it is not one more filter, so it does not look like one */}
        <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
          <SelectTrigger aria-label="Сортировка"
            className="h-8! w-auto gap-1.5 border-0 bg-transparent px-2 text-[13px] text-muted-foreground shadow-none hover:text-foreground focus-visible:ring-0 dark:bg-transparent">
            <ArrowDownWideNarrow className="size-4" />
            <span>Сортировка:</span>
            <span className="font-medium text-foreground"><SelectValue /></span>
          </SelectTrigger>
          <SelectContent position="popper" align="end" sideOffset={6}>
            <SelectItem value="score">по баллу</SelectItem>
            <SelectItem value="severity">по серьёзности</SelectItem>
            <SelectItem value="updated">сначала свежие</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Card className="gap-0 overflow-hidden rounded-2xl p-0 shadow-card ring-foreground/[0.07]">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {["Issue", "Тип", "Серьёзность", "Релевант.", ...(coverage === "open" ? [] : ["PR"]), "Балл"].map((h) => (
                <TableHead key={h} className="h-12 px-3 text-[12.5px] font-medium text-muted-foreground first:pl-6 last:pr-6">{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.slice(0, shown).map((r) => (
              <TableRow key={r.number} className="cursor-pointer" onClick={() => setOpenIssue(r.number)}>
                <TableCell className="px-3 py-4 pl-6">
                  <div className="min-w-64 whitespace-normal">
                    <p className="leading-snug font-medium tracking-[-0.01em]">{r.title}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">#{r.number}</span>
                      <span>{ago(r.updated)}</span>
                      {(r.security_or_data ?? 0) >= 0.5 && <Pill tone="danger">безопасность/данные</Pill>}
                    </p>
                  </div>
                </TableCell>
                <TableCell className="px-3 py-4">{r.kind_label && <Pill>{r.kind_label}</Pill>}</TableCell>
                <TableCell className="px-3 py-4"><Meter value={r.severity} max={4} /></TableCell>
                <TableCell className="px-3 py-4"><Meter value={r.relevance} max={3} /></TableCell>
                {coverage !== "open" && <TableCell className="px-3 py-4">
                  <span className="flex max-w-44 flex-wrap gap-1">
                    {r.open_pr.slice(0, 4).map((n) => known.has(n)
                      ? <button key={n} onClick={(e) => { e.stopPropagation(); setOpenPr(n) }} className="font-mono text-xs text-foreground/80 underline-offset-2 hover:underline">#{n}</button>
                      : <a key={n} href={`https://github.com/${repo}/pull/${n}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="font-mono text-xs text-foreground/80 hover:underline">#{n}</a>)}
                    {r.open_pr.length > 4 && <span className="text-xs text-muted-foreground">+{r.open_pr.length - 4}</span>}
                    {!r.open_pr.length && <span className="text-xs text-muted-foreground">—</span>}
                  </span>
                </TableCell>}
                <TableCell className="px-3 py-4 pr-6"><ScoreRing score={r.score} size={40} /></TableCell>
              </TableRow>
            ))}
            {!data.length && (
              <TableRow><TableCell colSpan={6} className="py-16 text-center text-muted-foreground">
                {attention ? "Под фильтр «Стоят внимания» ничего не попало — выключите его, чтобы увидеть все" : "Ничего не нашлось"}
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
      <div className="flex items-center justify-center gap-4 text-sm text-muted-foreground">
        {data.length > shown && <Button variant="outline" className="rounded-full" onClick={() => setShown((n) => n + PAGE)}>Показать ещё</Button>}
        <span className="tabular">{fmt(Math.min(shown, data.length))} из {fmt(data.length)}</span>
      </div>
    </div>
  )
}

/** Several PRs claim one issue: which one Jev would take. */
function Rivals({ slug, summary, prs }: { slug: string; summary: Summary; prs: PrRow[] }) {
  const setOpenPr = useApp((s) => s.setOpenPr)
  const setOpenIssue = useApp((s) => s.setOpenIssue)
  const byNumber = useMemo(() => new Map(prs.map((p) => [p.number, p])), [prs])
  const list = [...summary.rivals.list].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
  if (!list.length) {
    return (
      <StageEmpty slug={slug} job="rivals" title="Конкурирующие PR ещё не разбирались" action="Разобрать">
        Когда несколько PR закрывают одну и ту же issue, Jev сравнит их и подскажет, какой брать — или что ни один не годится.
        Нужны собранные PR; с issues и ревью кода финалистов ответ точнее.
      </StageEmpty>
    )
  }
  return (
    <Panel title="Несколько PR на одну issue" note={`${count(list.length, "группа", "группы", "групп")} · выбрано ${fmt(summary.rivals.picked)}`}>
      <div className="grid gap-3 lg:grid-cols-2">
        {list.map((r) => <RivalCard key={r.issue} r={r} byNumber={byNumber} onOpen={setOpenPr} onOpenIssue={setOpenIssue} />)}
      </div>
    </Panel>
  )
}

function RivalCard({ r, byNumber, onOpen, onOpenIssue }: { r: Rival; byNumber: Map<number, PrRow>; onOpen: (n: number) => void; onOpenIssue: (n: number) => void }) {
  return (
    <div className="rounded-xl border px-5 py-4">
      <button onClick={() => onOpenIssue(r.issue)} className="block text-left hover:underline">
        <span className="font-mono text-xs text-muted-foreground">issue #{r.issue}</span>
        <span className="mt-0.5 block leading-snug font-medium">{r.issue_title ?? `issue #${r.issue}`}</span>
      </button>
      <ul className="mt-3 flex flex-col gap-1.5">
        {r.candidates.slice(0, 8).map((n) => {
          const pr = byNumber.get(n)
          const chosen = r.chosen_pr === n
          return (
            <li key={n}>
              <button onClick={() => onOpen(n)} disabled={!pr}
                className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-muted disabled:hover:bg-transparent", chosen && "bg-take-soft hover:bg-take-soft")}>
                <span className="font-mono text-xs text-muted-foreground">#{n}</span>
                <span className={cn("min-w-0 flex-1 truncate", chosen ? "font-medium text-take" : "text-foreground/80")}>{pr?.title ?? "PR вне списка"}</span>
                {pr?.score != null && <span className="text-xs text-muted-foreground tabular">{fmt(pr.score)}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {r.chosen_pr ? <Pill tone="take">берём #{r.chosen_pr}</Pill> : <Pill tone="danger">ни один не годится</Pill>}
        <Tooltip>
          <TooltipTrigger asChild><span className="tabular">уверенность {fmt(r.confidence * 100)}%</span></TooltipTrigger>
          <TooltipContent>Насколько Jev уверен в выборе между кандидатами</TooltipContent>
        </Tooltip>
        {r.proper_fix < 0.5 && <Pill tone="consider">возможно, лечат симптом</Pill>}
      </p>
    </div>
  )
}
