import { ArrowUpRight, ChevronDown, Download, Play, Rocket } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useStartJob } from "@/hooks/use-project"
import { avatarUrl, fmt } from "@/lib/format"
import { api } from "@/lib/api"
import { EXTRA_STEPS, STEPS, type StepDef } from "@/lib/labels"
import type { Summary } from "@/lib/types"
import { useApp } from "@/store/app"

export function ProjectHeader({ slug, summary }: { slug: string; summary: Summary }) {
  const c = summary.config
  const busy = !!useApp((s) => s.job)
  const start = useStartJob(slug)

  return (
    <header className="flex flex-wrap items-start gap-6">
      <Avatar className="size-16 rounded-2xl shadow-float">
        <AvatarImage src={avatarUrl(c.repo, 128)} alt="" />
        <AvatarFallback className="rounded-2xl">{c.name.slice(0, 2)}</AvatarFallback>
      </Avatar>
      <div className="min-w-64 flex-1">
        <h1 className="text-4xl leading-tight font-semibold tracking-[-0.035em]">{c.name}</h1>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13.5px] text-muted-foreground">
          <a href={`https://github.com/${c.repo}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 font-mono text-[12.5px] hover:text-foreground">
            {c.repo}<ArrowUpRight className="size-3.5" />
          </a>
          <span>·</span>
          <a href={`https://github.com/${c.repo}/pulls`} target="_blank" rel="noreferrer" className="hover:text-foreground">
            {fmt(summary.total)} открытых PR{c.community_only ? " сообщества" : ""}
          </a>
        </div>
        {c.profile && (
          <Tooltip>
            <TooltipTrigger asChild>
              <p className="mt-2.5 line-clamp-2 max-w-3xl text-[14.5px] text-foreground/70">{c.profile}</p>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-lg text-[13px] leading-relaxed">{c.profile}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex items-center gap-2 pt-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-lg" className="size-10 rounded-full shadow-card" asChild>
              <a href={api.reportUrl(slug)} download aria-label="Скачать отчёт"><Download /></a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Отчёт по всему циклу, markdown</TooltipContent>
        </Tooltip>
        <Button size="lg" className="h-10 rounded-full px-5 text-[14px]" disabled={busy || start.isPending} onClick={() => start.mutate("full")}>
          <Play className="fill-current" /> Полный прогон
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon-lg" className="size-10 rounded-full shadow-card" disabled={busy} aria-label="Отдельные шаги">
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-[min(640px,var(--radix-dropdown-menu-content-available-height))] w-80 overflow-y-auto">
            <DropdownMenuItem className="gap-3 py-2" onSelect={() => start.mutate("everything")}>
              <Rocket className="text-brand" />
              <span className="flex flex-col">
                <span className="font-medium">Весь цикл</span>
                <span className="text-xs text-muted-foreground">PR → issues → конкуренты → форки → стек → карта мержей</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Pull request</DropdownMenuLabel>
            {STEPS.map((s) => <StepItem key={s.key} step={s} onSelect={() => start.mutate(s.key)} />)}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Шире PR</DropdownMenuLabel>
            {EXTRA_STEPS.map((s) => <StepItem key={s.key} step={s} onSelect={() => start.mutate(s.key)} />)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}

function StepItem({ step, onSelect }: { step: StepDef; onSelect: () => void }) {
  return (
    <DropdownMenuItem className="gap-3 py-2" onSelect={onSelect}>
      <step.icon className="text-muted-foreground" />
      <span className="flex flex-col">
        <span className="font-medium">{step.title}</span>
        <span className="text-xs text-muted-foreground">{step.by}</span>
      </span>
    </DropdownMenuItem>
  )
}
