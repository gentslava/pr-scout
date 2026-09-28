import type { Criteria, ForkRow, IssueDetail, IssueRow, JobName, PrDetail, PrRow, Project, ProjectConfig, Status, Summary } from "./types"

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || res.statusText)
  }
  return res.json()
}

const send = <T>(path: string, body: unknown, method = "POST") =>
  request<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) })

const p = (slug: string, path = "") => `/api/p/${slug}${path}`

export const api = {
  status: () => request<Status>("/api/status"),
  projects: () => request<Project[]>("/api/projects"),
  createProject: (body: { url: string; profile: string; community_only: boolean; describe: boolean; describer: string; describer_model: string; run: boolean }) =>
    send<{ slug: string }>("/api/projects", body),
  deleteProject: (slug: string) => request<{ ok: boolean }>(p(slug), { method: "DELETE" }),
  summary: (slug: string) => request<Summary>(p(slug, "/summary")),
  prs: (slug: string) => request<PrRow[]>(p(slug, "/prs")),
  pr: (slug: string, n: number) => request<PrDetail>(p(slug, `/prs/${n}`)),
  criteria: (slug: string) => request<Criteria>(p(slug, "/criteria")),
  issues: (slug: string) => request<IssueRow[]>(p(slug, "/issues")),
  issue: (slug: string, n: number) => request<IssueDetail>(p(slug, `/issues/${n}`)),
  forks: (slug: string) => request<ForkRow[]>(p(slug, "/forks")),
  reportUrl: (slug: string) => p(slug, "/report.md"),
  saveConfig: (slug: string, body: Partial<Omit<ProjectConfig, "exclude_authors" | "stack_prs" | "describer" | "forks">> & {
    exclude_authors?: string
    stack_prs?: string
    describer?: Partial<ProjectConfig["describer"]>
    forks?: Partial<NonNullable<ProjectConfig["forks"]>>
  }) => send<ProjectConfig>(p(slug, "/config"), body, "PUT"),
  llmModels: (provider: string) => request<string[]>(`/api/llm/${encodeURIComponent(provider)}/models`),
  startJob: (slug: string, job: JobName) => send<{ ok: boolean }>(p(slug, `/jobs/${job}`), {}),
}

export const keys = {
  status: ["status"] as const,
  projects: ["projects"] as const,
  summary: (slug: string) => ["summary", slug] as const,
  prs: (slug: string) => ["prs", slug] as const,
  pr: (slug: string, n: number) => ["pr", slug, n] as const,
  criteria: (slug: string) => ["criteria", slug] as const,
  issues: (slug: string) => ["issues", slug] as const,
  issue: (slug: string, n: number) => ["issue", slug, n] as const,
  forks: (slug: string) => ["forks", slug] as const,
  llmModels: (provider: string) => ["llm-models", provider] as const,
}
