import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { api, keys } from "@/lib/api"
import type { JobName, MapSummary, PrRow, Run, StackResult, Summary } from "@/lib/types"
import { useApp } from "@/store/app"

export function useProjectData(slug: string) {
  const summary = useQuery({ queryKey: keys.summary(slug), queryFn: () => api.summary(slug) })
  const prs = useQuery({ queryKey: keys.prs(slug), queryFn: () => api.prs(slug) })
  const criteria = useQuery({ queryKey: keys.criteria(slug), queryFn: () => api.criteria(slug) })
  return { summary: summary.data, prs: prs.data, criteria: criteria.data, loading: summary.isPending || prs.isPending || criteria.isPending }
}

export const useIssues = (slug: string) => useQuery({ queryKey: keys.issues(slug), queryFn: () => api.issues(slug) })
export const useForks = (slug: string) => useQuery({ queryKey: keys.forks(slug), queryFn: () => api.forks(slug) })

export const lastRun = (runs: Run[] | undefined, stage: Run["stage"]) => [...(runs ?? [])].reverse().find((r) => r.stage === stage)

export const classifiedRows = (prs: PrRow[] | undefined) => (prs ?? []).filter((r) => r.classified)

export function useStartJob(slug: string) {
  const qc = useQueryClient()
  const { resetLive, setTab, setJob } = useApp()
  return useMutation({
    mutationFn: (job: JobName) => api.startJob(slug, job),
    onSuccess: (_, job) => {
      resetLive()
      setJob({ running: FIRST_JOB[job] ?? job, project: slug })
      setTab("run")
      qc.invalidateQueries({ queryKey: keys.summary(slug) })
    },
    onError: (e: Error) => toast.error(e.message),
  })
}

/** The server job a pipeline starts with, so the UI shows the right step before the first event. */
const FIRST_JOB: Partial<Record<JobName, string>> = { full: "fetch", everything: "fetch", issues: "fetch_issues", forks: "fetch_forks" }

/**
 * Jev cost of the data on screen: the latest run of every stage that asked Jev. Runs pile up
 * over a project's life and stages are rerun on their own, so summing all of them would count reruns.
 */
export const jevRuns = (runs: Run[]) => {
  const last = new Map<string, Run>()
  for (const r of runs) if ((r.input_tokens ?? 0) > 0) last.set(r.stage, r)
  return [...last.values()]
}

/** Area/kind labels with a readable fallback. */
export const labelOf = (map: Record<string, string> | undefined, key: string | undefined) => (key ? map?.[key] ?? key : "—")

/** The server sends {} for a stage that has not run yet. */
export const hasStack = (s: Summary["stack"]): s is StackResult => "considered" in s
export const hasMap = (m: Summary["map"]): m is MapSummary => "plans" in m
