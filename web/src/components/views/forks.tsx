import { useMemo, useState } from "react"
import { ArrowUpRight, ChevronDown, Search, Star } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Pill, ScoreRing } from "@/components/pr-bits"
import { StageEmpty, StatCards } from "@/components/stat-cards"
import { lastRun, useForks } from "@/hooks/use-project"
import { ago, avatarUrl, count, fmt } from "@/lib/format"
import type { Tone } from "@/lib/labels"
import type { ForkRow, Summary } from "@/lib/types"
import { cn } from "@/lib/utils"

const PAGE = 40

export function ForksView({ slug, summary }: { slug: string; summary: Summary }) {
  const forks = useForks(slug)
  if (forks.isPending) return <Skeleton className="h-96 rounded-2xl" />
  const rows = forks.data ?? []
  if (!rows.length) {
    return (
      <StageEmpty slug={slug} job="forks" title="Форки ещё не разбирались">
        Scout пройдёт по всем форкам, отсеет те, где нет своих коммитов (без лишних запросов к GitHub), сравнит остальные с апстримом
        и спросит Jev, что в них. Так находятся фиксы и фичи, которые никто не отправил в PR. На тысячах форков это может занять
        несколько часовых окон лимита GitHub — задача ждёт сброса, а не падает.
      </StageEmpty>
    )
  }
  const run = lastRun(summary.runs, "forks")
  const f = summary.forks
  const filtered = (run?.up_to_date ?? 0) + (run?.gone ?? 0)
  return (
    <div className="flex flex-col gap-10">
      <StatCards items={[
        { label: "Форков", value: fmt(f.total), sub: filtered ? `${fmt(filtered)} отсеяно без сравнения` : `${fmt(f.scanned)} проверено` },
        { label: "С работой впереди", value: fmt(f.ahead), sub: "коммиты, которых нет в апстриме", dot: "bg-consider" },
        { label: "Кандидатов", value: fmt(f.classified - f.duplicates), sub: "уникальных, после схлопывания клонов", dot: "bg-take" },
        { label: "Клонов", value: fmt(f.duplicates), sub: `${fmt(f.clusters)} линий работы размножены по форкам` },
      ]} />
      <ForkList rows={rows} compareBase={`https://github.com/${summary.config.repo}/compare/${summary.config.default_branch ?? "main"}...`} />
    </div>
  )
}

function ForkList({ rows, compareBase }: { rows: ForkRow[]; compareBase: string }) {
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState("all")
  const [clones, setClones] = useState(false)
  const [safeOnly, setSafeOnly] = useState(false)
  const [shown, setShown] = useState(PAGE)
  const classified = useMemo(() => rows.filter((r) => r.classified), [rows])
  const kinds = useMemo(() => [...new Map(classified.filter((r) => r.kind).map((r) => [r.kind!, r.kind_label ?? r.kind!])).entries()], [classified])
  const clonesOf = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const r of rows) if (r.duplicate_of) m.set(r.duplicate_of, [...(m.get(r.duplicate_of) ?? []), r.fork])
    return m
  }, [rows])

  const data = useMemo(() => {
    const q = query.trim().toLowerCase()
    return classified
      .filter((r) => (clones || !r.duplicate_of)
        && (kind === "all" || r.kind === kind)
        && (!safeOnly || ((r.secrets ?? 0) < 0.5 && (r.risky ?? 0) < 0.5))
        && (!q || r.fork.toLowerCase().includes(q) || r.commits.some((c) => c.message.toLowerCase().includes(q))))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  }, [classified, query, kind, clones, safeOnly])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE) }} placeholder="Форк или текст коммита"
            className="h-10 rounded-full bg-card pl-10 shadow-card" />
        </div>
        <Select value={kind} onValueChange={(v) => { setKind(v); setShown(PAGE) }}>
          <SelectTrigger className="h-10! min-w-48 rounded-full bg-card px-4 shadow-card"><SelectValue /></SelectTrigger>
          <SelectContent position="popper" sideOffset={6}>
            <SelectItem value="all">Любой тип</SelectItem>
            {kinds.map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground/80">
          <Switch checked={safeOnly} onCheckedChange={setSafeOnly} /> Без рисков и секретов
        </label>
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground/80">
          <Switch checked={clones} onCheckedChange={setClones} /> Показать клоны
        </label>
      </div>
      <div className="grid items-start gap-3 lg:grid-cols-2">
        {data.slice(0, shown).map((r) => <ForkCard key={r.fork} r={r} clones={clonesOf.get(r.fork) ?? []} compare={`${compareBase}${r.owner}:${r.branch}`} />)}
      </div>
      {!data.length && <p className="py-16 text-center text-muted-foreground">Ничего не нашлось</p>}
      <div className="flex items-center justify-center gap-4 text-sm text-muted-foreground">
        {data.length > shown && <Button variant="outline" className="rounded-full" onClick={() => setShown((n) => n + PAGE)}>Показать ещё</Button>}
        <span className="tabular">{fmt(Math.min(shown, data.length))} из {fmt(data.length)}</span>
      </div>
    </div>
  )
}

/** `compare` opens upstream…fork on GitHub: exactly the commits the fork carries. */
function ForkCard({ r, clones, compare }: { r: ForkRow; clones: string[]; compare: string }) {
  const [open, setOpen] = useState(false)
  const commits = [...r.commits].reverse()
  // one flag at most, the one that decides whether to touch the fork at all
  const warning: [Tone, string] | null = (r.secrets ?? 0) >= 0.5 ? ["danger", "секреты или приватное"]
    : (r.risky ?? 0) >= 0.5 ? ["consider", "рискованно"]
    : (r.duplicate ?? 0) >= 0.5 ? ["outline", "похоже, уже в апстриме"] : null
  return (
    <Card className="gap-4 rounded-2xl px-5 py-5 shadow-card ring-foreground/[0.07]">
      <div className="flex gap-4">
        <Avatar className="size-10 rounded-xl">
          <AvatarImage src={avatarUrl(r.fork, 80)} alt="" />
          <AvatarFallback className="rounded-xl">{r.owner?.slice(0, 2)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <a href={compare} target="_blank" rel="noreferrer" className="group inline-flex max-w-full items-center gap-0.5">
            <span className="truncate text-[15px] font-semibold tracking-[-0.012em] group-hover:underline">{r.fork}</span>
            <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
          </a>
          <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground tabular">
            <span>+{count(r.ahead, "коммит", "коммита", "коммитов")}</span>
            <span>±{fmt(r.lines)}</span>
            {r.stars > 0 && <span className="inline-flex items-center gap-0.5"><Star className="size-3" />{fmt(r.stars)}</span>}
            <span>{ago(r.pushed)}</span>
          </p>
        </div>
        <ScoreRing score={r.score} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {r.kind_label && <Pill>{r.kind_label}</Pill>}
        {warning && <Pill tone={warning[0]}>{warning[1]}</Pill>}
        {clones.length > 0 && <Pill tone="outline">+{count(clones.length, "клон", "клона", "клонов")}</Pill>}
      </div>
      {commits.length > 0 && (
        <div>
          <ul className="flex flex-col gap-1 text-[13px] text-foreground/80">
            {(open ? commits : commits.slice(0, 2)).map((c) => (
              <li key={c.sha} className="flex gap-2.5">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.sha.slice(0, 7)}</span>
                <span className="min-w-0 truncate" title={c.message}>{c.message}</span>
              </li>
            ))}
          </ul>
          {(commits.length > 2 || clones.length > 0) && (
            <button onClick={() => setOpen((v) => !v)} className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
              {open ? "Свернуть" : `Все коммиты${clones.length ? " и клоны" : ""}`}
            </button>
          )}
          {open && clones.length > 0 && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Та же линия работы: {clones.join(", ")}</p>
          )}
        </div>
      )}
    </Card>
  )
}
