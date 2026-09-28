import { useId } from "react"
import { useQuery } from "@tanstack/react-query"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, keys } from "@/lib/api"
import { count } from "@/lib/format"
import type { LlmProvider } from "@/lib/types"

/**
 * Who writes missing PR descriptions and with which model: any provider the server knows
 * (Ollama, NordRouter, OpenRouter, OpenAI, custom OpenAI-compatible ones). The same block
 * sits in the project settings and in the new project dialog.
 */
export function DescriberFields({ provider, model, disabled, onChange }: {
  provider: string
  model: string
  disabled?: boolean
  onChange: (next: { provider: string; model: string }) => void
}) {
  const id = useId()
  const status = useQuery({ queryKey: keys.status, queryFn: api.status })
  const providers = status.data?.llm_providers ?? []
  const current = providers.find((p) => p.id === provider)
  const models = useQuery({
    queryKey: keys.llmModels(provider),
    queryFn: () => api.llmModels(provider),
    enabled: !!current?.ready && !disabled,
    staleTime: 10 * 60_000,
  })
  const list = models.data ?? []

  const pick = (next: string) => {
    const p = providers.find((x) => x.id === next)
    // a model name only makes sense for its own provider: switch to the new provider's default
    onChange({ provider: next, model: p?.default_model ?? "" })
  }
  const groups: [string, LlmProvider[]][] = [["На этом сервере", providers.filter((p) => p.local)], ["Облако и свои эндпоинты", providers.filter((p) => !p.local)]]

  return (
    <div className="grid gap-4 sm:grid-cols-[240px_1fr]">
      <Field>
        <FieldLabel>Кто пишет описания</FieldLabel>
        <Select value={provider} onValueChange={pick} disabled={disabled}>
          <SelectTrigger className="h-9! w-full rounded-md"><SelectValue placeholder="Провайдер" /></SelectTrigger>
          <SelectContent position="popper" sideOffset={6}>
            {groups.filter(([, ps]) => ps.length).map(([title, ps]) => (
              <SelectGroup key={title}>
                <SelectLabel>{title}</SelectLabel>
                {ps.map((p) => (
                  <SelectItem key={p.id} value={p.id} disabled={!p.ready}>
                    {p.name}
                    {!p.ready && p.key_env && <span className="text-muted-foreground"> — нужен {p.key_env}</span>}
                    {p.kind === "ollama" && status.data && !status.data.ollama_models.length && <span className="text-muted-foreground"> — не отвечает</span>}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-model`}>Модель</FieldLabel>
        <Input id={`${id}-model`} list={`${id}-models`} value={model} disabled={disabled} autoComplete="off"
          placeholder={current?.default_model || "название модели"} onChange={(e) => onChange({ provider, model: e.target.value })} />
        <datalist id={`${id}-models`}>{list.map((m) => <option key={m} value={m} />)}</datalist>
        {!disabled && current && (
          <FieldDescription>
            {!current.ready ? `Задайте ${current.key_env} на сервере`
              : models.isFetching ? "Загружаю список моделей…"
              : list.length ? `${count(list.length, "модель", "модели", "моделей")} у ${current.name} — начните вводить название`
              : "Список моделей недоступен — впишите название"}
          </FieldDescription>
        )}
      </Field>
    </div>
  )
}
