import { CircleDot, Cpu, GitFork, GitMerge, GitPullRequest, Layers, Network, Sparkles, Swords, type LucideIcon } from "lucide-react"
import type { CiClass, ExtraStageKey, PlanKey, Run, StageKey, Track, Verdict } from "./types"

export interface StepDef<K extends string = StageKey | ExtraStageKey> {
  key: K
  title: string
  by: string
  icon: LucideIcon
  /** the run the step records in history */
  stage: Run["stage"]
  /** server-side job names while the step works (a step can be two jobs: list, then Jev) */
  jobs: string[]
}

export const STEPS: StepDef<StageKey>[] = [
  { key: "fetch", title: "Сбор PR", by: "GitHub GraphQL", icon: GitPullRequest, stage: "fetch", jobs: ["fetch"] },
  { key: "describe", title: "Описания", by: "локальная модель · Ollama", icon: Cpu, stage: "describe", jobs: ["describe"] },
  { key: "stage1", title: "Классификация", by: "Jev · все PR", icon: Sparkles, stage: "stage1", jobs: ["stage1"] },
  { key: "stage2", title: "Код и мерж", by: "git + Jev · финалисты", icon: GitMerge, stage: "stage2", jobs: ["stage2"] },
]

/** Beyond the PR list: what else is worth taking into our build, and what it costs to keep. */
export const EXTRA_STEPS: StepDef<ExtraStageKey>[] = [
  { key: "issues", title: "Issues", by: "Jev · что болит без PR", icon: CircleDot, stage: "issues", jobs: ["fetch_issues", "issues"] },
  { key: "rivals", title: "Конкуренты", by: "Jev · несколько PR на issue", icon: Swords, stage: "rivals", jobs: ["rivals"] },
  { key: "forks", title: "Форки", by: "compare + Jev · работа вне апстрима", icon: GitFork, stage: "forks", jobs: ["fetch_forks", "forks"] },
  { key: "stack", title: "Стек", by: "git · цена поддержки", icon: Layers, stage: "stack", jobs: ["stack"] },
  { key: "map", title: "Карта мержей", by: "git + Jev · пары и расклады", icon: Network, stage: "map", jobs: ["map"] },
]

export const ALL_STEPS: StepDef[] = [...STEPS, ...EXTRA_STEPS]

/** The step a running server job belongs to. */
export const stepOfJob = (job: string | null | undefined) => (job ? ALL_STEPS.find((s) => s.jobs.includes(job)) : undefined)

export const PLANS: Record<PlanKey, { title: string; hint: string }> = {
  safe: { title: "Безопасный", hint: "максимум по баллу без единого конфликта внутри — можно брать сегодня" },
  all_in: { title: "Всё в одно", hint: "берём всё, конфликты разбираем руками" },
  top_score: { title: "Топ по баллу", hint: "лучшие по баллу, цена поддержки не важна" },
  low_churn: { title: "Минимум поверхности", hint: "балл против горячести файлов: реже ломается апстримом" },
  by_area: { title: "По подсистемам", hint: "по лучшему на каждую часть системы — шире, а не глубже" },
}

export const VERDICT: Record<Verdict, string> = { take: "Берём", consider: "Рассмотреть", skip: "Пропускаем" }

export const VERDICT_HINT: Record<Verdict, string> = {
  take: "Серьёзный фикс или сильная фича, ложится на основную ветку, код чистый",
  consider: "Полезно, но есть оговорки: CI, риск, размер или ценность",
  skip: "Конфликт, слабый или подозрительный код",
}

export const TRACK: Record<Track, string> = { fix: "Фикс", feature: "Фича", other: "Прочее" }

export const CI: Record<CiClass, { tone: Tone; label: string }> = {
  green: { tone: "take", label: "CI зелёный" },
  flaky_only: { tone: "consider", label: "CI: только флаки" },
  e2e_only: { tone: "consider", label: "CI: только флаки" },
  red: { tone: "danger", label: "CI красный" },
  no_ci: { tone: "outline", label: "без CI" },
}

export type Tone = "take" | "consider" | "skip" | "danger" | "brand" | "ink" | "outline" | "neutral"

/** Score breakdown keys → human labels (negative keys are penalties). */
export const BREAKDOWN: Record<string, string> = {
  relevance: "релевантность",
  harm_common: "вред × частота",
  severity: "серьёзность",
  general: "полезно всем",
  tests: "тесты",
  clear: "описание",
  value: "ценность фичи",
  new_capability: "новизна",
  "-risky": "штраф: риск",
  "-size": "штраф: размер",
  "-stale": "штраф: давно не обновлялся",
  actionable: "решается кодом",
  no_pr: "никто не взялся",
  "-by_design": "штраф: так задумано",
  "-covered_by_pr": "штраф: уже есть PR",
  "-vague": "штраф: мало деталей",
}

export const RUN_NAMES: Record<string, string> = {
  fetch: "Сбор PR",
  describe: "Описания · Ollama",
  stage1: "Этап 1 · Jev",
  stage2: "Этап 2 · Jev + git",
  "issues-list": "Список issues",
  issues: "Issues · Jev",
  rivals: "Конкурирующие PR · Jev",
  "forks-list": "Список форков",
  forks: "Форки · compare + Jev",
  stack: "Стек · git",
  map: "Карта мержей · git + Jev",
  refresh: "Обновление",
}
