import type { ReactNode } from "react"
import { Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { useStartJob } from "@/hooks/use-project"
import type { JobName } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useApp } from "@/store/app"

export interface Stat {
  label: string
  value: ReactNode
  sub?: ReactNode
  dot?: string
  accent?: boolean
}

/** The big-number cards at the top of a tab. */
export function StatCards({ items, className }: { items: Stat[]; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-4 xl:grid-cols-4", className)}>
      {items.map((k) => (
        <Card key={k.label} className="gap-0 rounded-2xl px-6 py-6 shadow-card ring-foreground/[0.07]">
          <span className="flex items-center gap-2 text-[13.5px] text-muted-foreground">
            {k.dot && <span className={cn("size-1.5 rounded-full", k.dot)} />}
            {k.label}
          </span>
          <span className={cn("mt-5 text-4xl font-semibold tracking-[-0.04em] tabular", k.accent && "text-brand")}>{k.value}</span>
          {k.sub && <span className="mt-1.5 text-[13px] text-muted-foreground">{k.sub}</span>}
        </Card>
      ))}
    </div>
  )
}

/** A tab whose stage has not produced anything yet: what it does and a button to run it. */
export function StageEmpty({ slug, job, title, children, action = "Запустить" }: { slug: string; job: JobName; title: string; children: ReactNode; action?: string }) {
  const start = useStartJob(slug)
  const busy = !!useApp((s) => s.job)
  return (
    <Empty className="rounded-2xl border bg-card py-16">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription className="max-w-xl">{children}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button className="h-10 rounded-full px-5" disabled={busy || start.isPending} onClick={() => start.mutate(job)}>
          <Play className="fill-current" /> {action}
        </Button>
      </EmptyContent>
    </Empty>
  )
}
