import { useQuery } from "@tanstack/react-query"
import { Moon, Plus, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton,
} from "@/components/ui/sidebar"
import { api, keys } from "@/lib/api"
import { avatarUrl, fmt } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useApp } from "@/store/app"
import { LogoMark } from "@/components/logo-mark"

export function AppSidebar() {
  const projects = useQuery({ queryKey: keys.projects, queryFn: api.projects })
  const status = useQuery({ queryKey: keys.status, queryFn: api.status, refetchInterval: 60_000 })
  const { slug, setSlug, setAddOpen, job } = useApp()
  const { resolvedTheme, setTheme } = useTheme()
  const models = status.data?.ollama_models ?? []
  const cloud = (status.data?.llm_providers ?? []).filter((p) => !p.local && p.ready)
  const llmText = [models.length ? `Ollama · ${models.length} мод.` : null, ...cloud.map((p) => p.name)].filter(Boolean).join(", ")

  return (
    <Sidebar>
      <SidebarHeader className="px-4 pt-5 pb-4">
        <a href="#" className="flex items-center gap-2.5 text-[16px] font-semibold tracking-tight">
          <LogoMark bg="var(--sidebar)" /> PR Scout
        </a>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Проекты</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {projects.isPending && [0, 1].map((i) => <SidebarMenuItem key={i}><SidebarMenuSkeleton showIcon /></SidebarMenuItem>)}
              {projects.data?.map((p) => (
                <SidebarMenuItem key={p.slug}>
                  <SidebarMenuButton isActive={p.slug === slug} onClick={() => setSlug(p.slug)} className="h-auto gap-3 py-2">
                    <Avatar className="size-8 rounded-lg">
                      <AvatarImage src={avatarUrl(p.repo)} alt="" />
                      <AvatarFallback className="rounded-lg text-xs">{p.name.slice(0, 2)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 truncate font-medium">
                        {p.name}
                        {job?.project === p.slug && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand" />}
                      </span>
                      <span className="flex gap-2 text-xs text-muted-foreground">
                        <span>{fmt(p.prs)} PR</span>
                        {p.take > 0 && <span className="text-take">{p.take} берём</span>}
                      </span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
            <Button variant="outline" className="mt-3 h-9 w-full rounded-full shadow-card" onClick={() => setAddOpen(true)}>
              <Plus /> Добавить репозиторий
            </Button>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="flex-row items-end justify-between border-t px-4 py-3">
        <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <Service ok={status.data?.jev_ready} text={status.data?.jev_ready ? "Jev подключён" : "Jev: нет ключа"} />
          <Service ok={status.data?.github_ready} text={status.data?.github_ready ? "GitHub токен есть" : "GitHub: нет токена"} />
          <Service ok={!!llmText} text={llmText ? `LLM: ${llmText}` : "LLM: нет ни одного провайдера"} />
        </ul>
        <Button variant="outline" size="icon" className="rounded-full" aria-label="Сменить тему"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
          {resolvedTheme === "dark" ? <Sun /> : <Moon />}
        </Button>
      </SidebarFooter>
    </Sidebar>
  )
}

function Service({ ok, text }: { ok?: boolean; text: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={cn("size-1.5 rounded-full", ok === undefined ? "bg-subtle" : ok ? "bg-take" : "bg-danger")} />
      {text}
    </li>
  )
}
