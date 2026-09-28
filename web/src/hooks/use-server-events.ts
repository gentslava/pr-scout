import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { keys } from "@/lib/api"
import type { Project, ServerEvent } from "@/lib/types"
import { useApp } from "@/store/app"

/** Subscribes to the server's SSE stream and keeps job state, live progress and cached queries in sync. */
export function useServerEvents() {
  const qc = useQueryClient()

  useEffect(() => {
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout>

    const refreshProject = (slug: string) => {
      qc.invalidateQueries({ queryKey: keys.summary(slug) })
      qc.invalidateQueries({ queryKey: keys.prs(slug) })
      qc.invalidateQueries({ queryKey: keys.issues(slug) })
      qc.invalidateQueries({ queryKey: keys.forks(slug) })
    }

    const onEvent = (ev: ServerEvent) => {
      const app = useApp.getState()
      switch (ev.type) {
        case "hello":
          app.setJob(ev.job.running ? { running: ev.job.running, project: ev.job.project } : null)
          return
        case "start":
          app.setJob({ running: ev.job, project: ev.project })
          if (ev.project === app.slug) app.resetLive()
          return
        case "step":
          app.setJob({ running: ev.job, project: ev.project })
          if (ev.project === app.slug) {
            app.stepStarted()
            // the previous step has just written its run and results: refresh so they show up right away
            refreshProject(ev.project)
          }
          return
        case "log":
          app.log(ev.message)
          return
        case "done":
        case "error": {
          app.setJob(null)
          const name = qc.getQueryData<Project[]>(keys.projects)?.find((p) => p.slug === ev.project)?.name ?? ev.project
          if (ev.type === "done") toast.success(`${name}: прогон завершён`)
          else toast.error(`${name}: ${ev.message}`)
          qc.invalidateQueries({ queryKey: keys.projects })
          refreshProject(ev.project)
          return
        }
        case "progress":
          if (ev.project === app.slug) app.progress(ev)
          return
        case "fork":
          if (ev.project === app.slug) app.fork(ev)
          return
      }
    }

    const connect = () => {
      es = new EventSource("/api/events")
      es.onmessage = (m) => onEvent(JSON.parse(m.data) as ServerEvent)
      es.onerror = () => {
        es?.close()
        retry = setTimeout(connect, 3000)
      }
    }
    connect()
    return () => {
      clearTimeout(retry)
      es?.close()
    }
  }, [qc])
}
