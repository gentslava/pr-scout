import { useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AddProjectDialog } from "@/components/add-project-dialog"
import { AppSidebar } from "@/components/app-sidebar"
import { Pipeline } from "@/components/pipeline"
import { IssueSheet } from "@/components/issue-sheet"
import { PrSheet } from "@/components/pr-sheet"
import { ProjectHeader } from "@/components/project-header"
import { AllPrs } from "@/components/views/all-prs"
import { CostView } from "@/components/views/cost"
import { CriteriaView } from "@/components/views/criteria"
import { ForksView } from "@/components/views/forks"
import { IssuesView } from "@/components/views/issues"
import { Overview } from "@/components/views/overview"
import { RunView } from "@/components/views/run"
import { SettingsView } from "@/components/views/settings"
import { StackView } from "@/components/views/stack"
import { useProjectData, classifiedRows } from "@/hooks/use-project"
import { useServerEvents } from "@/hooks/use-server-events"
import { api, keys } from "@/lib/api"
import { fmt } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useApp, type Tab } from "@/store/app"
import { LogoMark } from "@/components/logo-mark"

export default function App() {
  useServerEvents()
  const projects = useQuery({ queryKey: keys.projects, queryFn: api.projects })
  const { slug, setSlug } = useApp()

  // pick a project: the one in the URL if it exists, otherwise the first
  useEffect(() => {
    if (!projects.data) return
    if (!slug || !projects.data.some((p) => p.slug === slug)) setSlug(projects.data[0]?.slug ?? null)
  }, [projects.data, slug, setSlug])

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="relative isolate min-w-0 bg-background">
        <div className="header-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[460px]" />
        <SidebarTrigger className="m-3 md:hidden" />
        {projects.isPending ? <Loading /> : slug ? <ProjectPage key={slug} slug={slug} /> : <Welcome />}
      </SidebarInset>
      <AddProjectDialog />
    </SidebarProvider>
  )
}

const TABS: [Tab, string][] = [
  ["overview", "Обзор"], ["all", "Все PR"], ["issues", "Issues"], ["forks", "Форки"], ["stack", "Сборка"],
  ["run", "Прогон"], ["criteria", "Как оценивает"], ["cost", "Стоимость"], ["settings", "Настройки"],
]

function ProjectPage({ slug }: { slug: string }) {
  const { summary, prs, criteria, loading } = useProjectData(slug)
  const { tab, setTab } = useApp()
  const sentinel = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)

  useEffect(() => {
    if (!sentinel.current) return
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting))
    io.observe(sentinel.current)
    return () => io.disconnect()
  }, [loading])

  if (loading || !summary || !prs || !criteria) return <Loading />

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-0">
      <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-10 px-4 pt-8 pb-10 md:px-14 md:pt-14">
        <ProjectHeader slug={slug} summary={summary} />
        <Pipeline slug={slug} summary={summary} prs={prs} />
      </div>
      <div ref={sentinel} className="h-px" />
      {/* a full-width bar once it sticks, so content never slides under a floating pill */}
      <div className={cn("sticky top-0 z-20 border-b border-transparent transition-[background,border-color,box-shadow]", stuck && "border-border bg-background shadow-[0_6px_20px_-14px_rgb(20_20_18/0.25)]")}>
        <div className="mx-auto w-full max-w-[1480px] overflow-x-auto px-4 py-3 md:px-14 [scrollbar-width:none]">
          <TabsList className="h-11! rounded-full border bg-muted p-1">
            {TABS.map(([v, label]) => (
              <TabsTrigger key={v} value={v} className="h-9 flex-none rounded-full px-4 text-[13.5px] data-[state=active]:shadow-card">
                {label}
                {v === "all" && <span className="text-xs text-muted-foreground tabular">{fmt(classifiedRows(prs).length)}</span>}
                {v === "issues" && summary.issues.without_pr > 0 && <span className="text-xs text-muted-foreground tabular">{fmt(summary.issues.without_pr)}</span>}
                {v === "forks" && summary.forks.classified > 0 && <span className="text-xs text-muted-foreground tabular">{fmt(summary.forks.classified - summary.forks.duplicates)}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </div>
      <div className="mx-auto w-full max-w-[1480px] px-4 pt-8 pb-28 md:px-14">
        <TabsContent value="overview"><Overview summary={summary} prs={prs} criteria={criteria} /></TabsContent>
        <TabsContent value="all"><AllPrs prs={prs} criteria={criteria} /></TabsContent>
        <TabsContent value="issues"><IssuesView slug={slug} summary={summary} prs={prs} /></TabsContent>
        <TabsContent value="forks"><ForksView slug={slug} summary={summary} /></TabsContent>
        <TabsContent value="stack"><StackView slug={slug} summary={summary} prs={prs} /></TabsContent>
        <TabsContent value="run"><RunView slug={slug} summary={summary} prs={prs} criteria={criteria} /></TabsContent>
        <TabsContent value="criteria"><CriteriaView criteria={criteria} /></TabsContent>
        <TabsContent value="cost"><CostView summary={summary} /></TabsContent>
        <TabsContent value="settings"><SettingsView slug={slug} summary={summary} /></TabsContent>
      </div>
      <PrSheet slug={slug} repo={summary.config.repo} criteria={criteria} />
      <IssueSheet slug={slug} repo={summary.config.repo} prs={prs} />
    </Tabs>
  )
}

function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-10 px-4 pt-14 md:px-14">
      <div className="flex items-center gap-5"><Skeleton className="size-16 rounded-2xl" /><Skeleton className="h-10 w-72" /></div>
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36 rounded-2xl" />)}</div>
    </div>
  )
}

function Welcome() {
  const setAddOpen = useApp((s) => s.setAddOpen)
  return (
    <div className="mx-auto my-[16vh] max-w-2xl px-6 text-center">
      <LogoMark className="mx-auto size-20" />
      <h1 className="mt-6 text-5xl font-semibold tracking-[-0.04em]">Какие PR стоит взять?</h1>
      <p className="mt-4 text-[16.5px] leading-relaxed text-foreground/70">
        PR Scout собирает все открытые pull request репозитория, дописывает пустые описания и за пару минут раскладывает их через Jev:
        что берём, что рассмотреть, что пропустить — с причинами. А ещё находит важные issues без PR, работу в форках и считает, во что обойдётся поддержка.
      </p>
      <Button size="lg" className="mt-8 h-11 rounded-full px-6" onClick={() => setAddOpen(true)}><Plus /> Добавить репозиторий</Button>
    </div>
  )
}
