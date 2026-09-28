import { useEffect } from "react"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { DescriberFields } from "@/components/describer-fields"
import { api, keys } from "@/lib/api"
import type { Summary } from "@/lib/types"
import { useApp } from "@/store/app"

const schema = z.object({
  name: z.string().trim().min(1, "Нужно название"),
  profile: z.string(),
  community_only: z.boolean(),
  exclude_authors: z.string(),
  stack_prs: z.string().regex(/^[\d,\s#]*$/, "Только номера PR через запятую"),
  stack_prs_url: z.union([z.literal(""), z.url("Нужна ссылка")]),
  finalists: z.number({ error: "Число" }).int().min(10, "Минимум 10").max(500, "Максимум 500"),
  describe: z.boolean(),
  describer: z.string().min(1, "Выберите провайдера"),
  describer_model: z.string().trim(),
  forks_min_stars: z.number({ error: "Число" }).int().min(0, "Не меньше 0"),
  forks_limit: z.number({ error: "Число" }).int().min(0, "Не меньше 0"),
})
type Values = z.infer<typeof schema>

export function SettingsView({ slug, summary }: { slug: string; summary: Summary }) {
  const c = summary.config
  const qc = useQueryClient()
  const setSlug = useApp((s) => s.setSlug)
  const toValues = (): Values => ({
    name: c.name ?? "", profile: c.profile ?? "", community_only: !!c.community_only,
    exclude_authors: (c.exclude_authors ?? []).join(", "), stack_prs: (c.stack_prs ?? []).join(", "),
    stack_prs_url: c.stack_prs_url ?? "", finalists: c.finalists ?? 120, describe: !!c.describer?.enabled,
    describer: c.describer?.provider ?? "ollama", describer_model: c.describer?.model ?? "",
    forks_min_stars: c.forks?.min_stars ?? 0, forks_limit: c.forks?.limit ?? 0,
  })
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: toValues() })
  useEffect(() => form.reset(toValues()), [summary.config]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (v: Values) => api.saveConfig(slug, {
      name: v.name, profile: v.profile, community_only: v.community_only, exclude_authors: v.exclude_authors,
      stack_prs: v.stack_prs, stack_prs_url: v.stack_prs_url, finalists: v.finalists,
      describer: { enabled: v.describe, provider: v.describer, model: v.describer_model },
      forks: { min_stars: v.forks_min_stars, limit: v.forks_limit },
    }),
    onSuccess: () => {
      toast.success("Настройки сохранены")
      for (const k of [keys.summary(slug), keys.prs(slug), keys.criteria(slug), keys.projects]) qc.invalidateQueries({ queryKey: k })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const remove = useMutation({
    mutationFn: () => api.deleteProject(slug),
    onSuccess: async () => {
      toast.success(`Проект ${c.repo} удалён`)
      const list = await qc.fetchQuery({ queryKey: keys.projects, queryFn: api.projects })
      setSlug(list[0]?.slug ?? null)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const err = form.formState.errors
  const [describeOn, describer, describerModel] = useWatch({ control: form.control, name: ["describe", "describer", "describer_model"] })
  return (
    <Card className="max-w-3xl gap-0 rounded-2xl px-10 py-10 shadow-card ring-foreground/[0.07]">
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))}>
        <FieldGroup className="gap-7">
          <Field data-invalid={!!err.name}>
            <FieldLabel htmlFor="name">Название</FieldLabel>
            <Input id="name" {...form.register("name")} />
            <FieldError errors={[err.name]} />
          </Field>
          <Field>
            <FieldLabel htmlFor="profile">Как вы используете проект</FieldLabel>
            <FieldDescription>Относительно этого Jev оценивает релевантность. После изменения перезапустите «Классификацию».</FieldDescription>
            <Textarea id="profile" rows={6} {...form.register("profile")} />
          </Field>
          <Controller control={form.control} name="community_only" render={({ field }) => (
            <Field orientation="horizontal">
              <Switch id="community_only" checked={field.value} onCheckedChange={field.onChange} />
              <FieldLabel htmlFor="community_only" className="font-normal">Только PR сообщества — без владельцев, мейнтейнеров и коллабораторов</FieldLabel>
            </Field>
          )} />
          <Field>
            <FieldLabel htmlFor="exclude_authors">Исключить авторов</FieldLabel>
            <FieldDescription>Логины через запятую</FieldDescription>
            <Input id="exclude_authors" {...form.register("exclude_authors")} />
          </Field>
          <Field data-invalid={!!err.stack_prs}>
            <FieldLabel htmlFor="stack_prs">Уже взятые PR</FieldLabel>
            <FieldDescription>Номера через запятую — их не предлагаем, а финалистов проверяем на мерж поверх них</FieldDescription>
            <Input id="stack_prs" {...form.register("stack_prs")} />
            <FieldError errors={[err.stack_prs]} />
          </Field>
          <Field data-invalid={!!err.stack_prs_url}>
            <FieldLabel htmlFor="stack_prs_url">…или ссылка на их список</FieldLabel>
            <FieldDescription>Текстовый файл, номер PR в начале строки</FieldDescription>
            <Input id="stack_prs_url" placeholder="https://raw.githubusercontent.com/…/prs.txt" {...form.register("stack_prs_url")} />
            <FieldError errors={[err.stack_prs_url]} />
          </Field>
          <Field data-invalid={!!err.finalists} className="max-w-48">
            <FieldLabel htmlFor="finalists">Финалистов на этап 2</FieldLabel>
            <Input id="finalists" type="number" inputMode="numeric" {...form.register("finalists", { valueAsNumber: true })} />
            <FieldError errors={[err.finalists]} />
          </Field>
          <Controller control={form.control} name="describe" render={({ field }) => (
            <Field orientation="horizontal">
              <Switch id="describe" checked={field.value} onCheckedChange={field.onChange} />
              <FieldLabel htmlFor="describe" className="font-normal">
                Дописывать описания моделью, если текст автора короче {c.describer?.min_body ?? 200} символов
              </FieldLabel>
            </Field>
          )} />
          <DescriberFields provider={describer} model={describerModel} disabled={!describeOn}
            onChange={(v) => { form.setValue("describer", v.provider, { shouldDirty: true }); form.setValue("describer_model", v.model, { shouldDirty: true }) }} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={!!err.forks_min_stars}>
              <FieldLabel htmlFor="forks_min_stars">Форки: минимум звёзд</FieldLabel>
              <FieldDescription>0 — разбирать все форки</FieldDescription>
              <Input id="forks_min_stars" type="number" inputMode="numeric" {...form.register("forks_min_stars", { valueAsNumber: true })} />
              <FieldError errors={[err.forks_min_stars]} />
            </Field>
            <Field data-invalid={!!err.forks_limit}>
              <FieldLabel htmlFor="forks_limit">Форки: сколько свежих смотреть</FieldLabel>
              <FieldDescription>Самые недавно обновлённые; 0 — без ограничения</FieldDescription>
              <Input id="forks_limit" type="number" inputMode="numeric" {...form.register("forks_limit", { valueAsNumber: true })} />
              <FieldError errors={[err.forks_limit]} />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="lg" className="h-10 rounded-full px-6" disabled={save.isPending}>Сохранить</Button>
          </div>
        </FieldGroup>
      </form>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t pt-6">
        <span className="text-[13px] text-muted-foreground">
          Уже взято: {summary.included.length ? summary.included.map((n) => `#${n}`).join(", ") : "ничего"}
        </span>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" className="h-9 rounded-full px-4">Удалить проект</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Удалить {c.repo}?</AlertDialogTitle>
              <AlertDialogDescription>Удалятся настройки и все результаты: оценки Jev, мержи и история прогонов.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Отмена</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => remove.mutate()}>Удалить</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Card>
  )
}
