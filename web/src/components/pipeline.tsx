import { Card } from "@/components/ui/card"
import { hasMap, hasStack, lastRun } from "@/hooks/use-project"
import { count, fmt, secs } from "@/lib/format"
import { EXTRA_STEPS, STEPS, type StepDef } from "@/lib/labels"
import type { PrRow, Run, Summary } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useApp } from "@/store/app"

export function Pipeline({ slug, summary, prs }: { slug: string; summary: Summary; prs: PrRow[] }) {
  const job = useApp((s) => s.job)
  const running = job?.project === slug ? job.running : null

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {STEPS.map((step) => (
          <StepCard key={step.key} step={step} summary={summary} prs={prs} running={running} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {EXTRA_STEPS.map((step) => <StepCard key={step.key} step={step} summary={summary} prs={prs} running={running} />)}
      </div>
    </div>
  )
}

/** The one thing a step's card says: what it produced. How it ran (time, cost) lives in the run history. */
function headline(key: string, run: Run | undefined, s: Summary, prs: PrRow[]): string | null {
  switch (key) {
    case "fetch": return prs.length ? count(prs.length, "PR", "PR", "PR") : null
    case "describe": {
      const n = prs.filter((r) => r.ai_description).length
      if (n) return count(n, "описание", "описания", "описаний")
      return !s.config.ollama?.enabled ? "выключены" : run ? "нечего дописывать" : null
    }
    case "stage1": return s.classified ? `${fmt(s.classified)} оценено` : null
    case "stage2": return s.finalists && run ? count(s.finalists, "финалист", "финалиста", "финалистов") : null
    case "issues": return s.issues.classified ? `${fmt(s.issues.without_pr)} без PR` : null
    case "rivals": return run ? (s.rivals.groups ? count(s.rivals.groups, "группа", "группы", "групп") : "конкурентов нет") : null
    case "forks": return s.forks.classified ? count(s.forks.classified - s.forks.duplicates, "кандидат", "кандидата", "кандидатов") : run ? "кандидатов нет" : null
    case "stack": return hasStack(s.stack) ? (s.stack.considered ? `${fmt(s.stack.merged)} из ${fmt(s.stack.considered)} влились` : "нечего собирать") : null
    case "map": return hasMap(s.map) && s.map.plans.safe ? `безопасно ${fmt(s.map.plans.safe.count)} из ${fmt(s.map.candidate_list.length)}` : null
    default: return null
  }
}

function StepCard({ step, summary, prs, running }: { step: StepDef; summary: Summary; prs: PrRow[]; running: string | null }) {
  const live = useApp((s) => s.live)
  const run = lastRun(summary.runs, step.stage)
  const active = !!running && step.jobs.includes(running)
  const main = active
    ? (live.total ? `${fmt(live.done)} / ${fmt(live.total)}` : "запускается…")
    : headline(step.key, run, summary, prs) ?? "не запускался"
  const aside = active && live.seconds ? secs(live.seconds) : null
  const pct = active && live.total ? Math.min(100, (live.done / live.total) * 100) : 0

  return (
    <Card className={cn("relative gap-0 overflow-hidden rounded-2xl p-4 shadow-card ring-foreground/[0.07]", active && "ring-2 ring-brand/60")}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg bg-muted", active && "bg-brand-soft text-brand", run && !active && "text-take")}>
          <step.icon className={cn("size-3.5", active && "animate-spin [animation-duration:2.4s]")} />
        </span>
        <span className="truncate text-[14px] font-semibold tracking-tight">{step.title}</span>
      </div>
      <p className="mt-3 flex min-w-0 items-baseline gap-2 text-[13.5px] tabular">
        {active && <span className="size-1.5 shrink-0 self-center animate-pulse rounded-full bg-brand" />}
        <span className={cn("truncate font-medium", !run && !active && "font-normal text-muted-foreground")}>{main}</span>
        {aside && <span className="shrink-0 text-xs text-muted-foreground">{aside}</span>}
      </p>
      <span className="absolute bottom-0 left-0 h-0.5 bg-brand transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </Card>
  )
}
