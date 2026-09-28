export type Verdict = "take" | "consider" | "skip"
export type Track = "fix" | "feature" | "other"
export type CiClass = "green" | "flaky_only" | "e2e_only" | "red" | "no_ci"
export type StageKey = "fetch" | "describe" | "stage1" | "stage2"
/** Stages beyond the PR list: each is a job of its own and part of "everything". */
export type ExtraStageKey = "issues" | "rivals" | "forks" | "stack" | "map"
export type JobName = "full" | "everything" | StageKey | ExtraStageKey

export interface Project {
  slug: string
  repo: string
  name: string
  prs: number
  classified: number
  take: number
  last_run: string | null
}

export interface Reasons {
  skip: string[]
  consider: string[]
  take: string[]
}

/** One row of the PR list: the fields the server exposes in LIST_FIELDS. */
export interface PrRow {
  number: number
  title: string
  author: string
  updated: string
  additions: number
  deletions: number
  files: number
  included: boolean
  classified: boolean
  kind?: string
  area?: string
  track?: Track
  relevance?: number
  bug_severity?: number
  feature_value?: number
  harm?: number
  common_case?: number
  new_capability?: number
  risky?: number
  score?: number
  rank?: number
  duplicate_of?: number | null
  finalist?: boolean
  verdict?: Verdict
  ci_class?: CiClass
  ai_description: boolean
  reasons?: Reasons
  breakdown?: Record<string, number>
}

export interface Run {
  stage: StageKey | ExtraStageKey | "issues-list" | "forks-list" | "refresh"
  started: string
  seconds: number
  items: number
  errors?: number
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  model?: string
  conflicts?: number
  /** a describe run on a local model: its tokens cost nothing */
  local?: boolean
  up_to_date?: number
  gone?: number
}

export interface Job {
  running: string | null
  project: string | null
  done: number
  total: number
  started: number | null
}

/** Who writes missing PR descriptions: an LLM provider id from the server (see LlmProvider) and its model. */
export interface DescriberConfig {
  enabled: boolean
  provider: string
  model: string
  min_body: number
}

export interface LlmProvider {
  id: string
  name: string
  kind: "ollama" | "openai"
  local: boolean
  /** usable now: a key is set, or none is needed */
  ready: boolean
  /** the variable that enables it, when it needs a key */
  key_env: string | null
  default_model: string
}

export interface ForksConfig {
  limit?: number
  min_stars?: number
  max_commits?: number
}

export interface ProjectConfig {
  repo: string
  name: string
  profile: string
  community_only: boolean
  exclude_authors: string[]
  stack_prs: number[]
  stack_prs_url: string
  finalists: number
  describer: DescriberConfig
  forks?: ForksConfig
  default_branch?: string
}

export interface Comparison {
  input_tokens: number
  output_estimate: number
  rows: { name: string; cost: number; batch?: number; seconds?: number; actual?: boolean }[]
}

export interface JevInfo {
  provider: "typesafe" | "nordrouter"
  name: string
  model: string
  key: string
  price_per_mtok: number
}

export interface Summary {
  total: number
  classified: number
  finalists: number
  included: number[]
  runs: Run[]
  job: Job
  config: ProjectConfig
  jev_ready: boolean
  github_ready: boolean
  jev: JevInfo
  comparison: Comparison | null
  issues: { total: number; classified: number; without_pr: number }
  forks: { total: number; scanned: number; ahead: number; classified: number; duplicates: number; clusters: number }
  rivals: { groups: number; picked: number; list: Rival[] }
  stack: StackResult | Record<string, never>
  map: MapSummary | Record<string, never>
}

export interface IssueRow {
  number: number
  title: string
  author: string
  created: string
  updated: string
  comments: number
  labels: string[]
  classified: boolean
  open_pr: number[]
  kind?: string
  kind_label: string | null
  severity?: number
  relevance?: number
  harm?: number
  common_case?: number
  security_or_data?: number
  by_design?: number
  actionable?: number
  reproducible?: number
  mentioned_by?: number[]
  score?: number
  rank?: number
  breakdown?: Record<string, number>
}

export interface IssueDetail {
  issue: { number: number; title: string; body: string | null; author: string; created: string; updated: string; comments: number; labels: string[] }
  row: IssueRow | null
  answers: Record<string, Answer> | null
  labels: Record<string, string>
  kinds: Record<string, string>
}

export interface ForkCommit {
  sha: string
  date: string
  message: string
}

export interface ForkRow {
  fork: string
  owner: string
  branch: string
  pushed: string
  stars: number
  ahead: number
  behind: number | null
  lines: number
  status: string
  truncated?: boolean
  commits: ForkCommit[]
  files: string[]
  note?: string
  classified: boolean
  kind?: string
  kind_label?: string
  value?: number
  relevance?: number
  secrets?: number
  risky?: number
  duplicate?: number
  score?: number
  rank?: number
  cluster?: string
  cluster_size?: number
  duplicate_of?: string | null
}

export interface Rival {
  issue: number
  issue_title: string | null
  choice: string
  chosen_pr: number | null
  confidence: number
  proper_fix: number
  candidates: number[]
}

export interface StackResult {
  verdicts: string[]
  considered: number
  merged: number
  conflicted: number
  merged_prs: number[]
  included?: number[]
  skipped: { number: number; why: string }[]
  conflicts: { number: number; files: string[]; message?: string }[]
  patch: { files: number; shortstat: string; insertions?: number; deletions?: number }
  hot: { commits_scanned: number; files_in_stack: number; hot_in_stack: number; hot_top: { file: string; edits: number }[]; churn_share: number }
  merge_cost: number
}

export type PlanKey = "safe" | "all_in" | "top_score" | "low_churn" | "by_area"

export interface MapCandidate {
  id: string
  kind: "pr" | "fork"
  number?: number
  repo?: string
  title: string
  score: number
  area?: string | null
  verdict?: string
  lines: number
  files: number
}

export interface MapPlan {
  count: number
  score_sum: number
  conflicts: number
  conflict_pairs: [string, string][]
  files: number
  hot_share: number
  kinds: { pr: number; fork: number }
  plan: string[]
  members: MapCandidate[]
}

export interface MapPair {
  pair: string
  overlap: number
  both_files?: string[]
  merge?: "clean" | "conflict"
  merge_rev?: "clean" | "conflict"
  merge_files?: string[]
  merge_rev_files?: string[]
  duplicate?: number
  better?: string
}

export interface MapSummary {
  candidate_list: MapCandidate[]
  pairs: number
  pairs_merged: number
  pairs_semantic: number
  conflicts: MapPair[]
  duplicates: MapPair[]
  plans: Partial<Record<PlanKey, MapPlan>>
  hot_commits: number
}

export interface Question {
  type: "choice" | "score" | "noul"
  instructions: string | { question: string }
  criteria?: string[] | Record<string, string>
}

export interface Criteria {
  setup: string
  stage1: Record<string, Question>
  stage2: Record<string, Question>
  labels: Record<string, string>
  areas: Record<string, string>
  kinds: Record<string, string>
  finalists: number
  negative: string[]
}

export interface Answer {
  type: "choice" | "score" | "noul"
  choice?: string
  score?: number
  noul?: number
  confidence?: number
  probabilities?: Record<string, number>
  legend?: Record<string, string>
}

export interface PrDetail {
  pr: {
    number: number
    title: string
    author: string
    body: string | null
    ai_description?: string
    updated: string
    additions: number
    deletions: number
    files: string[]
  }
  row: PrRow | null
  stage1: { answers: Record<string, Answer> } | null
  stage2: {
    merge: { merge: "clean" | string; conflicts?: string[] }
    ci?: { failing?: string[] } | null
    review: { answers: Record<string, Answer> }
  } | null
}

export interface Status {
  job: Job
  jev_ready: boolean
  github_ready: boolean
  jev: JevInfo
  llm_providers: LlmProvider[]
  ollama_models: string[]
}

export type ServerEvent =
  | { type: "hello"; job: Job }
  | { type: "start"; job: string; project: string }
  | { type: "step"; job: string; project: string }
  | { type: "log"; message: string }
  | { type: "done"; job: string; project: string }
  | { type: "error"; job: string; project: string; message: string }
  | ({ type: "progress"; project: string; done: number; total: number; number?: number | null } & ProgressExtra)
  | ForkEvent

/** A fork just compared and classified during the forks stage. */
export interface ForkEvent {
  type: "fork"
  project: string
  fork: string
  ahead: number
  score: number | null
  kind: string | null
  commits: string[]
}

export interface ProgressExtra {
  phase?: "list" | "describe" | "stage1" | "git" | "merge" | "review" | "issues-list" | "issues" | "rivals"
    | "forks-list" | "forks-history" | "forks-heads" | "forks" | "stack" | "map-fetch" | "map-merge" | "map-semantic"
  page?: number
  ahead?: number
  classified?: number
  pair?: string
  result?: string
  issue?: { number: number; title: string; score: number; kind_label: string; has_pr: boolean } | null
  seconds?: number
  tokens?: number
  cost?: number
  preview?: string
  title?: string
  merge?: string
  row?: PrRow
  error?: string
}
