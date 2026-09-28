import { create } from "zustand"
import type { ForkEvent, Job, PrRow, ProgressExtra } from "@/lib/types"

export type Tab = "overview" | "all" | "issues" | "forks" | "stack" | "run" | "criteria" | "cost" | "settings"

export type FeedItem =
  | { kind: "row"; key: string; row: PrRow }
  | { kind: "describe"; key: string; number: number; title: string; preview: string }
  | { kind: "merge"; key: string; number: number; clean: boolean }
  | { kind: "stack"; key: string; number: number; result: string }
  | { kind: "issue"; key: string; number: number; title: string; score: number; label: string; hasPr: boolean }
  | { kind: "fork"; key: string; fork: string; ahead: number; score: number | null; label: string | null; commits: string[] }

export interface Live {
  done: number
  total: number
  seconds: number
  tokens: number
  cost: number
  message: string
  scores: number[]
  areas: Record<string, number>
  feed: FeedItem[]
}

const emptyLive = (): Live => ({ done: 0, total: 0, seconds: 0, tokens: 0, cost: 0, message: "", scores: [], areas: {}, feed: [] })

interface AppState {
  slug: string | null
  tab: Tab
  openPr: number | null
  openIssue: number | null
  addOpen: boolean
  job: Pick<Job, "running" | "project"> | null
  live: Live
  setSlug: (slug: string | null) => void
  setTab: (tab: Tab) => void
  setOpenPr: (n: number | null) => void
  setOpenIssue: (n: number | null) => void
  setAddOpen: (open: boolean) => void
  setJob: (job: AppState["job"]) => void
  resetLive: () => void
  stepStarted: () => void
  progress: (ev: { done: number; total: number; number?: number | null } & ProgressExtra) => void
  fork: (ev: ForkEvent) => void
  log: (message: string) => void
}

const FEED_LIMIT = 250

export const useApp = create<AppState>((set) => ({
  slug: decodeURIComponent(location.hash.slice(1)) || null,
  tab: "overview",
  openPr: null,
  openIssue: null,
  addOpen: false,
  job: null,
  live: emptyLive(),
  setSlug: (slug) => {
    if (slug) history.replaceState(null, "", `#${slug}`)
    set({ slug, openPr: null, openIssue: null, live: emptyLive() })
  },
  setTab: (tab) => set({ tab }),
  // one sheet at a time: opening a PR from an issue's sheet replaces it, and back
  setOpenPr: (openPr) => set(openPr == null ? { openPr } : { openPr, openIssue: null }),
  setOpenIssue: (openIssue) => set(openIssue == null ? { openIssue } : { openIssue, openPr: null }),
  setAddOpen: (addOpen) => set({ addOpen }),
  setJob: (job) => set({ job }),
  resetLive: () => set({ live: emptyLive() }),
  stepStarted: () => set((s) => ({ live: { ...s.live, done: 0, total: 0, seconds: 0 } })),
  log: (message) => set((s) => ({ live: { ...s.live, message } })),
  progress: (ev) =>
    set((s) => {
      const live: Live = { ...s.live, done: ev.done, total: ev.total }
      if (ev.seconds != null) live.seconds = ev.seconds
      if (ev.tokens != null) live.tokens = ev.tokens
      if (ev.cost != null) live.cost = ev.cost
      const message = phaseMessage(ev)
      if (message) live.message = message
      let item: FeedItem | null = null
      if (ev.row) {
        const r = ev.row
        live.scores = [...s.live.scores, r.score ?? 0]
        if (r.area) live.areas = { ...s.live.areas, [r.area]: (s.live.areas[r.area] ?? 0) + 1 }
        item = { kind: "row", key: `row-${r.number}-${ev.done}`, row: r }
      } else if (ev.phase === "describe" && ev.preview && ev.number) {
        item = { kind: "describe", key: `d-${ev.number}`, number: ev.number, title: ev.title ?? "", preview: ev.preview }
      } else if (ev.phase === "merge" && ev.number) {
        const clean = ev.merge === "clean"
        live.message = `#${ev.number}: ${clean ? "ложится" : "конфликт"}`
        item = { kind: "merge", key: `m-${ev.number}`, number: ev.number, clean }
      } else if (ev.phase === "stack" && ev.number && ev.merge) {
        item = { kind: "stack", key: `s-${ev.number}-${ev.done}`, number: ev.number, result: ev.merge }
      } else if (ev.phase === "issues" && ev.issue) {
        const i = ev.issue
        item = { kind: "issue", key: `i-${i.number}`, number: i.number, title: i.title, score: i.score, label: i.kind_label, hasPr: i.has_pr }
        live.scores = [...s.live.scores, i.score]
      }
      if (item) live.feed = [item, ...s.live.feed].slice(0, FEED_LIMIT)
      return { live }
    }),
  fork: (ev) =>
    set((s) => {
      const item: FeedItem = { kind: "fork", key: `f-${ev.fork}`, fork: ev.fork, ahead: ev.ahead, score: ev.score, label: ev.kind, commits: ev.commits }
      const scores = ev.score != null ? [...s.live.scores, ev.score] : s.live.scores
      return { live: { ...s.live, scores, feed: [item, ...s.live.feed].slice(0, FEED_LIMIT) } }
    }),
}))

/** What the run header says while a phase without its own feed items is working. */
function phaseMessage(ev: { done: number; total: number } & ProgressExtra): string | null {
  switch (ev.phase) {
    case "list": return `страница ${ev.page}`
    case "issues-list": return `issues: страница ${ev.page}, собрано ${ev.done}`
    case "forks-list": return `форков в списке: ${ev.done}`
    case "forks-history": return `история основной ветки: ${ev.done} коммитов`
    case "forks-heads": return `head-коммиты форков: ${ev.done} из ${ev.total}`
    case "forks": return `сравнено ${ev.done} из ${ev.total} · с работой впереди ${ev.ahead ?? 0} · разобрано Jev ${ev.classified ?? 0}`
    case "rivals": return `группы конкурирующих PR: ${ev.done} из ${ev.total}`
    case "map-fetch": return "карта мержей: подтягиваю ветки"
    case "map-merge": return `тестовый мерж пары ${ev.pair ?? ""}: ${ev.result === "clean" ? "ложится" : "конфликт"}`
    case "map-semantic": return `смысловое сравнение пар: ${ev.done} из ${ev.total}`
    default: return null
  }
}
