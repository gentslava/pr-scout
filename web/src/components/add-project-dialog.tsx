import { useEffect } from "react"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { DescriberFields } from "@/components/describer-fields"
import { api, keys } from "@/lib/api"
import type { Status } from "@/lib/types"
import { useApp } from "@/store/app"

const schema = z.object({
  url: z.string().trim().regex(/^(https?:\/\/github\.com\/)?[\w.-]+\/[\w.-]+\/?$/, "Нужна ссылка вида https://github.com/owner/repo"),
  profile: z.string(),
  community_only: z.boolean(),
  describe: z.boolean(),
  describer: z.string(),
  describer_model: z.string().trim(),
})
type Values = z.infer<typeof schema>

/** A sensible describer for a new project: Ollama if it has models, else the first cloud provider with a key. */
function defaultDescriber(st: Status): Pick<Values, "describe" | "describer" | "describer_model"> {
  if (st.ollama_models.length) {
    return { describe: true, describer: "ollama", describer_model: st.ollama_models.find((m) => m.startsWith("qwen3.5:9b")) ?? st.ollama_models[0] }
  }
  const cloud = st.llm_providers.find((p) => !p.local && p.ready)
  return cloud ? { describe: true, describer: cloud.id, describer_model: cloud.default_model } : { describe: false, describer: "ollama", describer_model: "" }
}

export function AddProjectDialog() {
  const open = useApp((s) => s.addOpen)
  const { setAddOpen, setSlug, setTab, resetLive } = useApp()
  const qc = useQueryClient()
  const status = useQuery({ queryKey: keys.status, queryFn: api.status, enabled: open })
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { url: "", profile: "", community_only: true, describe: true, describer: "ollama", describer_model: "" },
  })
  const [describe, describer, describerModel] = useWatch({ control: form.control, name: ["describe", "describer", "describer_model"] })
  // pick a working describer once the server says what it has, unless the user already chose one
  useEffect(() => {
    if (!status.data || form.getFieldState("describer").isDirty) return
    const d = defaultDescriber(status.data)
    form.setValue("describe", d.describe)
    form.setValue("describer", d.describer)
    form.setValue("describer_model", d.describer_model)
  }, [status.data, form])

  const create = useMutation({
    mutationFn: (v: Values) => api.createProject({ ...v, run: true }),
    onSuccess: async ({ slug }) => {
      await qc.invalidateQueries({ queryKey: keys.projects })
      setAddOpen(false)
      form.reset()
      setSlug(slug)
      resetLive()
      setTab("run")
      toast.success("Проект добавлен — пошёл полный прогон")
    },
    onError: (e: Error) => form.setError("url", { message: e.message }),
  })

  const err = form.formState.errors
  return (
    <Dialog open={open} onOpenChange={setAddOpen}>
      <DialogContent className="gap-6 rounded-3xl p-9 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-2xl font-semibold tracking-[-0.035em]">Новый проект</DialogTitle>
          <DialogDescription>Scout соберёт открытые PR, допишет пустые описания и прогонит всё через Jev. Issues, форки и стек — отдельной кнопкой «Весь цикл».</DialogDescription>
        </DialogHeader>
        <form id="add-project" onSubmit={form.handleSubmit((v) => create.mutate(v))}>
          <FieldGroup className="gap-6">
            <Field data-invalid={!!err.url}>
              <FieldLabel htmlFor="url">Репозиторий на GitHub</FieldLabel>
              <Input id="url" autoFocus placeholder="https://github.com/owner/repo" {...form.register("url")} />
              <FieldError errors={[err.url]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="profile">Как вы используете проект</FieldLabel>
              <FieldDescription>Jev оценит, насколько каждый PR важен именно для этого</FieldDescription>
              <Textarea id="profile" rows={4} placeholder="Например: self-hosted в Docker на одном сервере, используем модули X и Y, для нас важнее всего стабильность и безопасность." {...form.register("profile")} />
            </Field>
            <Controller control={form.control} name="community_only" render={({ field }) => (
              <Field orientation="horizontal">
                <Switch id="community_only_new" checked={field.value} onCheckedChange={field.onChange} />
                <FieldLabel htmlFor="community_only_new" className="font-normal">Только PR сообщества — без владельцев, мейнтейнеров и коллабораторов</FieldLabel>
              </Field>
            )} />
            <Controller control={form.control} name="describe" render={({ field }) => (
              <Field orientation="horizontal">
                <Switch id="describe_new" checked={field.value} onCheckedChange={field.onChange} />
                <FieldLabel htmlFor="describe_new" className="font-normal">Дописывать пустые описания моделью</FieldLabel>
              </Field>
            )} />
            <DescriberFields provider={describer} model={describerModel} disabled={!describe}
              onChange={(v) => { form.setValue("describer", v.provider, { shouldDirty: true }); form.setValue("describer_model", v.model, { shouldDirty: true }) }} />
            {status.data && !status.data.github_ready && (
              <p className="rounded-xl bg-consider-soft px-4 py-3 text-[13px] text-consider">На сервере не задан GITHUB_TOKEN — без него GitHub не отдаст список PR.</p>
            )}
            {status.data && !status.data.jev_ready && (
              <p className="rounded-xl bg-consider-soft px-4 py-3 text-[13px] text-consider">
                На сервере не задан ключ Jev ({status.data.jev.key}) — PR соберутся, но оценить их будет нечем.
              </p>
            )}
          </FieldGroup>
        </form>
        <DialogFooter className="m-0 gap-2 border-0 bg-transparent p-0">
          <Button variant="outline" className="h-10 rounded-full px-5" onClick={() => setAddOpen(false)}>Отмена</Button>
          <Button type="submit" form="add-project" className="h-10 rounded-full px-5" disabled={create.isPending}>Добавить и запустить</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
