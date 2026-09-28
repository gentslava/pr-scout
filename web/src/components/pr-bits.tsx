import type { ReactNode } from "react"
import { PenLine } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { fmt } from "@/lib/format"
import { CI, TRACK, type Tone } from "@/lib/labels"
import type { PrRow } from "@/lib/types"

const TONES: Record<Tone, string> = {
  take: "bg-take-soft text-take",
  consider: "bg-consider-soft text-consider",
  skip: "bg-skip-soft text-skip",
  danger: "bg-danger-soft text-danger",
  brand: "bg-brand-soft text-brand",
  ink: "bg-primary text-primary-foreground",
  outline: "border-border bg-transparent text-muted-foreground",
  neutral: "border-border bg-muted text-foreground/80",
}

/** A soft status chip. Never clips: it keeps its width and the row wraps instead. */
export function Pill({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return <Badge className={cn("h-6 shrink-0 rounded-full px-2.5 text-xs font-medium", TONES[tone], className)}>{children}</Badge>
}

export function ScoreRing({ score, size = 44 }: { score?: number; size?: number }) {
  const stroke = size > 60 ? 4 : 3
  const r = (size - stroke) / 2 - 1
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, score ?? 0))
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="stroke-muted" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="stroke-foreground" strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={`${(c * v) / 100} ${c}`} />
      </svg>
      <span className={cn("absolute inset-0 grid place-items-center font-semibold tracking-tight tabular", size > 60 ? "text-xl" : "text-[13px]")}>
        {fmt(v)}
      </span>
    </div>
  )
}

export function Meter({ value, max }: { value?: number; max: number }) {
  if (value == null) return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-foreground/80 tabular">
      <span className="h-1.5 w-9 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-foreground" style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
      </span>
      {fmt(value, 1)}
    </span>
  )
}

export function Bar({ value, max, tone = "ink" }: { value: number; max: number; tone?: "ink" | "danger" | "brand" | "muted" }) {
  const fill = { ink: "bg-foreground", danger: "bg-danger", brand: "bg-brand", muted: "bg-subtle" }[tone]
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <span className={cn("block h-full rounded-full transition-[width] duration-500", fill)} style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </span>
  )
}

export function HBars({ counts, label }: { counts: Record<string, number>; label: (k: string) => string }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const max = Math.max(1, ...entries.map((e) => e[1]))
  return (
    <div className="flex flex-col gap-3">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[minmax(90px,170px)_1fr_44px] items-center gap-3 text-[13.5px] text-foreground/80">
          <span className="truncate" title={label(k)}>{label(k)}</span>
          <Bar value={v} max={max} />
          <span className="text-right text-muted-foreground tabular">{fmt(v)}</span>
        </div>
      ))}
    </div>
  )
}

export function Reasons({ row, limit = 2 }: { row: PrRow; limit?: number }) {
  if (!row.reasons) return null
  const items: [Tone, string][] = [
    ...row.reasons.skip.map((x): [Tone, string] => ["danger", x]),
    ...row.reasons.take.map((x): [Tone, string] => ["take", x]),
    ...row.reasons.consider.map((x): [Tone, string] => ["consider", x]),
  ]
  const dot: Partial<Record<Tone, string>> = { danger: "bg-danger", take: "bg-take", consider: "bg-consider" }
  return (
    <ul className="flex flex-col gap-1.5 text-[13px] leading-snug text-foreground/75">
      {items.slice(0, limit).map(([tone, text]) => (
        <li key={text} className="flex gap-2.5">
          <span className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", dot[tone])} />
          <span>{text}</span>
        </li>
      ))}
      {items.length > limit && <li className="pl-4 text-muted-foreground">+ ещё {items.length - limit}</li>}
    </ul>
  )
}

export function PrTags({ row, area }: { row: PrRow; area: string }) {
  const ci = row.ci_class ? CI[row.ci_class] : null
  return (
    <div className="flex flex-wrap gap-1.5">
      {row.track && <Pill>{TRACK[row.track]}</Pill>}
      <Pill tone="outline">{area}</Pill>
      {ci && <Pill tone={ci.tone}>{ci.label}</Pill>}
      {row.ai_description && <AiMark />}
    </div>
  )
}

export function AiMark() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span><Pill tone="brand"><PenLine className="size-3" /> ИИ</Pill></span>
      </TooltipTrigger>
      <TooltipContent>Описание по дифу дописала модель — у автора текста не было</TooltipContent>
    </Tooltip>
  )
}
