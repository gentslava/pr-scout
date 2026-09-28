import { Bar } from "@/components/pr-bits"
import { Panel } from "@/components/views/overview"
import { ago, fmt, money, secs } from "@/lib/format"
import { RUN_NAMES } from "@/lib/labels"
import type { Summary } from "@/lib/types"

export function CostView({ summary }: { summary: Summary }) {
  const cmp = summary.comparison
  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <Panel title="Jev против генеративной модели на тех же данных">
        {!cmp ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Сравнение появится после первого прогона Jev.</p>
        ) : (
          <Comparison cmp={cmp} />
        )}
      </Panel>
      <Panel title="История прогонов">
        <ul className="flex flex-col">
          {[...summary.runs].reverse().slice(0, 30).map((r) => (
            <li key={r.started + r.stage} className="flex items-start justify-between gap-4 border-b py-3.5 last:border-0">
              <span>
                <span className="block font-medium">{RUN_NAMES[r.stage] ?? r.stage}</span>
                <span className="text-xs text-muted-foreground">{ago(r.started)} · {r.model}</span>
              </span>
              <span className="text-right text-[13px] text-foreground/80 tabular">
                {fmt(r.items)} · {secs(r.seconds)}
                <span className="block">{r.cost_usd ? money(r.cost_usd) : r.output_tokens ? `${fmt(r.output_tokens)} ток.${r.local ?? r.model?.startsWith("ollama/") ? " локально" : ""}` : "бесплатно"}</span>
              </span>
            </li>
          ))}
          {!summary.runs.length && <li className="py-6 text-center text-sm text-muted-foreground">Пока пусто</li>}
        </ul>
      </Panel>
    </div>
  )
}

function Comparison({ cmp }: { cmp: NonNullable<Summary["comparison"]> }) {
  const costs = cmp.rows.map((r) => r.cost)
  const max = Math.max(...costs)
  const min = Math.max(0.001, Math.min(...costs))
  // log scale, otherwise Jev would be an invisible sliver next to Opus
  const width = (v: number) => 4 + (Math.log(v / min) / Math.log(max / min || 10)) * 96
  const jev = cmp.rows[0].cost
  const haiku = cmp.rows.find((r) => r.name.includes("Haiku"))
  return (
    <div>
      <p className="text-6xl font-semibold tracking-[-0.05em]">в {fmt((haiku?.batch ?? haiku?.cost ?? 0) / jev)} раз</p>
      <p className="mt-2 text-[14.5px] text-muted-foreground">
        дешевле, чем та же работа на Claude Haiku 4.5 даже через Batch API, и в {fmt(cmp.rows[1].cost / jev)} раз дешевле Opus 5.5
      </p>
      <div className="mt-8 flex flex-col gap-5">
        {cmp.rows.map((r) => (
          <div key={r.name} className="grid grid-cols-[140px_1fr_96px] items-center gap-4 text-[14px]">
            <span className={r.actual ? "font-medium" : ""}>{r.name}</span>
            <Bar value={width(r.cost)} max={100} tone={r.actual ? "brand" : "muted"} />
            <span className="text-right font-semibold tabular">
              {money(r.cost)}
              <span className="block text-xs font-normal text-muted-foreground">{r.batch ? `batch ${money(r.batch)}` : secs(r.seconds)}</span>
            </span>
          </div>
        ))}
      </div>
      <p className="mt-6 text-[12.5px] leading-relaxed text-muted-foreground">
        Считается по последнему прогону каждого этапа — по данным, которые сейчас на экране. Логарифмическая шкала. Для Claude — те же {fmt(cmp.input_tokens)} входных токенов плюс ~{fmt(cmp.output_estimate)} выходных (JSON и короткое обоснование).
        Цены Anthropic за 1M токенов: Opus 5.5 $4/$20, Sonnet 5 $2/$10, Haiku 4.5 $1/$5; Batch −50%. Цена скорости и дешевизны: Jev не пишет обоснований,
        поэтому решения собираются из атомарных вопросов и проверяются кодом (git, CI) на этапе 2.
      </p>
    </div>
  )
}
