import { useMemo, useState } from "react"
import { GitFork } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Bar, Pill, ScoreRing } from "@/components/pr-bits"
import { StageEmpty, StatCards } from "@/components/stat-cards"
import { Panel } from "@/components/views/overview"
import { hasMap, hasStack, lastRun } from "@/hooks/use-project"
import { ago, count, fmt } from "@/lib/format"
import { PLANS } from "@/lib/labels"
import type { MapCandidate, MapPair, MapSummary, PlanKey, PrRow, StackResult, Summary } from "@/lib/types"
import { useApp } from "@/store/app"

export function StackView({ slug, summary, prs }: { slug: string; summary: Summary; prs: PrRow[] }) {
  const titles = useMemo(() => new Map(prs.map((p) => [p.number, p.title])), [prs])
  return (
    <div className="flex flex-col gap-14">
      {hasStack(summary.stack)
        ? <Stack stack={summary.stack} titles={titles} ranAt={lastRun(summary.runs, "stack")?.started} />
        : (
          <StageEmpty slug={slug} job="stack" title="Стек ещё не собирался" action="Собрать стек">
            Scout вольёт выбранные PR («берём» и «рассмотреть») по одному в свежую основную ветку поверх уже взятых и покажет,
            что ложится чисто, что конфликтует и какая доля правок апстрима придётся на файлы, которые вы патчите — то есть во что
            обойдётся каждый следующий подтяг апстрима. Нужен этап 2.
          </StageEmpty>
        )}
      {hasMap(summary.map)
        ? <MergeMap map={summary.map} />
        : (
          <StageEmpty slug={slug} job="map" title="Карты мержей пока нет" action="Построить карту">
            Попарный анализ кандидатов (выжившие PR и лучшие форки): пересечение файлов, живые тестовые мержи в обе стороны и вопрос Jev,
            не одно ли и то же они чинят. Из этого собираются пять вариантов набора — от «безопасно взять сегодня» до «шире, а не глубже».
          </StageEmpty>
        )}
    </div>
  )
}

function Stack({ stack, titles, ranAt }: { stack: StackResult; titles: Map<number, string>; ranAt?: string }) {
  const setOpenPr = useApp((s) => s.setOpenPr)
  if (!stack.considered) {
    return (
      <section className="flex flex-col gap-4">
        <Heading title="Стек: цена поддержки" note={ranAt ? `проверен ${ago(ranAt)}` : undefined}>
          Собирать нечего: ни один PR не получил вердикт {stack.verdicts.map((v) => `«${v === "take" ? "берём" : v === "consider" ? "рассмотреть" : v}»`).join(" или ")}.
          Стек соберётся после этапа 2, когда у финалистов появятся такие вердикты.
        </Heading>
      </section>
    )
  }
  const maxEdits = Math.max(1, ...stack.hot.hot_top.map((h) => h.edits))
  return (
    <section className="flex flex-col gap-6">
      <Heading title="Стек: цена поддержки" note={ranAt ? `собран ${ago(ranAt)}` : undefined}>
        {fmt(stack.considered)} PR с вердиктом {stack.verdicts.map((v) => `«${v === "take" ? "берём" : v === "consider" ? "рассмотреть" : v}»`).join(" и ")}
        {stack.included?.length ? ` поверх ${fmt(stack.included.length)} уже взятых` : ""}, по одному в свежую основную ветку.
      </Heading>
      <StatCards className="xl:grid-cols-4" items={[
        { label: "Влились чисто", value: fmt(stack.merged), sub: `из ${fmt(stack.considered)}`, dot: "bg-take" },
        { label: "Конфликтуют", value: fmt(stack.conflicted), sub: `${fmt(stack.merge_cost, 1)}% выбранного`, dot: "bg-danger" },
        { label: "Объём патча", value: count(stack.patch.files, "файл", "файла", "файлов"),
          sub: stack.patch.insertions != null ? `+${fmt(stack.patch.insertions)} −${fmt(stack.patch.deletions)} строк` : stack.patch.shortstat },
        { label: "Поверхность конфликтов", value: `${fmt(stack.hot.churn_share, 1)}%`, accent: true,
          sub: `правок апстрима за ${count(stack.hot.commits_scanned, "коммит", "коммита", "коммитов")} попадают в наши файлы` },
      ]} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Что конфликтует" note={stack.conflicts.length ? `${fmt(stack.conflicts.length)} PR` : undefined}>
          {stack.conflicts.length ? (
            <ul className="flex flex-col divide-y">
              {stack.conflicts.map((c) => (
                <li key={c.number} className="py-3 first:pt-0 last:pb-0">
                  <button onClick={() => setOpenPr(c.number)} className="block text-left hover:underline">
                    <span className="font-mono text-xs text-muted-foreground">#{c.number}</span>{" "}
                    <span className="font-medium">{titles.get(c.number) ?? "PR"}</span>
                  </button>
                  <Files files={c.files} />
                </li>
              ))}
            </ul>
          ) : <p className="py-8 text-center text-sm text-muted-foreground">Всё выбранное ложится вместе без конфликтов</p>}
          {stack.skipped.length > 0 && (
            <p className="mt-4 text-xs text-muted-foreground">Не скачались: {stack.skipped.map((s) => `#${s.number}`).join(", ")}</p>
          )}
        </Panel>
        <Panel title="Самые горячие файлы, которые мы патчим" note="правок апстрима">
          {stack.hot.hot_top.length ? (
            <div className="flex flex-col gap-3">
              {stack.hot.hot_top.slice(0, 12).map((h) => (
                <div key={h.file} className="grid grid-cols-[minmax(0,1fr)_110px_36px] items-center gap-3 text-[13px]">
                  <span className="truncate font-mono text-[12px] text-foreground/80" title={h.file}>{h.file}</span>
                  <Bar value={h.edits} max={maxEdits} tone="danger" />
                  <span className="text-right text-muted-foreground tabular">{fmt(h.edits)}</span>
                </div>
              ))}
            </div>
          ) : <p className="py-8 text-center text-sm text-muted-foreground">Стек не трогает файлы, которые апстрим часто правит</p>}
        </Panel>
      </div>
    </section>
  )
}

function MergeMap({ map }: { map: MapSummary }) {
  const available = (Object.keys(PLANS) as PlanKey[]).filter((k) => map.plans[k])
  const [plan, setPlan] = useState<PlanKey>(available[0] ?? "safe")
  const byId = useMemo(() => new Map(map.candidate_list.map((c) => [c.id, c])), [map])
  const p = map.plans[plan]
  return (
    <section className="flex flex-col gap-6">
      <Heading title="Карта мержей">
        {count(map.candidate_list.length, "кандидат", "кандидата", "кандидатов")}, {count(map.pairs, "пара", "пары", "пар")}; вживую смержено {fmt(map.pairs_merged)} пересекающихся по файлам,
        смыслом сравнено {fmt(map.pairs_semantic)}.
      </Heading>
      <ToggleGroup type="single" value={plan} onValueChange={(v) => v && setPlan(v as PlanKey)} variant="outline"
        className="h-auto flex-wrap justify-start rounded-3xl bg-card p-1 shadow-card sm:h-10 sm:rounded-full">
        {available.map((k) => (
          <ToggleGroupItem key={k} value={k} className="h-8 rounded-full border-0 px-3.5 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">{PLANS[k].title}</ToggleGroupItem>
        ))}
      </ToggleGroup>
      {p && (
        <>
          <p className="-mt-2 text-[14px] text-muted-foreground">{PLANS[plan].hint}</p>
          <StatCards className="xl:grid-cols-5" items={[
            { label: "Берём", value: fmt(p.count), sub: `${fmt(p.kinds.pr)} PR · ${count(p.kinds.fork, "форк", "форка", "форков")}` },
            { label: "Сумма баллов", value: fmt(p.score_sum), accent: true },
            { label: "Конфликтов внутри", value: fmt(p.conflicts), dot: p.conflicts ? "bg-danger" : "bg-take" },
            { label: "Файлов", value: fmt(p.files) },
            { label: "Горячих правок", value: `${fmt(p.hot_share, 1)}%`, sub: "доля правок апстрима в этих файлах" },
          ]} />
          <Panel title="Состав">
            <ul className="grid gap-x-6 gap-y-1 md:grid-cols-2">
              {p.members.map((m) => <Member key={m.id} m={m} />)}
            </ul>
          </Panel>
        </>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Не мержатся вместе" note={map.conflicts.length ? count(map.conflicts.length, "пара", "пары", "пар") : undefined}>
          <PairList pairs={map.conflicts} byId={byId} empty="Конфликтных пар нет"
            detail={(x) => <Files files={x.merge_files ?? x.merge_rev_files ?? x.both_files ?? []} />} />
        </Panel>
        <Panel title="Похоже на одну и ту же работу" note={map.duplicates.length ? count(map.duplicates.length, "пара", "пары", "пар") : undefined}>
          <PairList pairs={map.duplicates} byId={byId} empty="Дублей Jev не нашёл"
            detail={(x) => (
              <p className="mt-1.5 text-xs text-muted-foreground">
                сходство {fmt((x.duplicate ?? 0) * 100)}%
                {x.better && x.better !== "equal" && byId.get(x.better) ? ` · лучше: ${label(byId.get(x.better)!)}` : ""}
              </p>
            )} />
        </Panel>
      </div>
    </section>
  )
}

const label = (c: MapCandidate) => (c.kind === "pr" ? `#${c.number}` : c.repo ?? c.title)

function Member({ m }: { m: MapCandidate }) {
  const setOpenPr = useApp((s) => s.setOpenPr)
  const body = (
    <>
      {m.kind === "pr" ? <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground">#{m.number}</span> : <GitFork className="size-4 w-14 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate">{m.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular">{fmt(m.files)} ф.</span>
      <ScoreRing score={m.score} size={34} />
    </>
  )
  const cls = "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-[13.5px] hover:bg-muted"
  return (
    <li>
      {m.kind === "pr" && m.number
        ? <button className={cls} onClick={() => setOpenPr(m.number!)}>{body}</button>
        : <a className={cls} href={`https://github.com/${m.repo}`} target="_blank" rel="noreferrer">{body}</a>}
    </li>
  )
}

function PairList({ pairs, byId, empty, detail }: { pairs: MapPair[]; byId: Map<string, MapCandidate>; empty: string; detail: (p: MapPair) => React.ReactNode }) {
  if (!pairs.length) return <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>
  return (
    <ul className="flex max-h-[420px] flex-col divide-y overflow-y-auto">
      {pairs.slice(0, 40).map((x) => {
        const [a, b] = x.pair.split("|").map((id) => byId.get(id))
        return (
          <li key={x.pair} className="py-3 first:pt-0 last:pb-0">
            <p className="flex flex-col gap-0.5 text-[13.5px]">
              {[a, b].map((c, i) => c && (
                <span key={i} className="flex min-w-0 gap-2">
                  <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">{c.kind === "pr" ? `#${c.number}` : "форк"}</span>
                  <span className="truncate">{c.title}</span>
                </span>
              ))}
            </p>
            {detail(x)}
          </li>
        )
      })}
    </ul>
  )
}

function Files({ files }: { files: string[] }) {
  if (!files.length) return null
  return (
    <span className="mt-1.5 flex flex-wrap gap-1">
      {files.slice(0, 3).map((f) => <Pill key={f} tone="outline" className="font-mono text-[11px]">{f.split("/").slice(-2).join("/")}</Pill>)}
      {files.length > 3 && <span className="text-xs text-muted-foreground">+{files.length - 3}</span>}
    </span>
  )
}

function Heading({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-2xl font-semibold tracking-[-0.03em]">{title}</h2>
        {note && <span className="text-[13px] text-muted-foreground">{note}</span>}
      </div>
      <p className="mt-1.5 max-w-4xl text-[14px] text-muted-foreground">{children}</p>
    </div>
  )
}

