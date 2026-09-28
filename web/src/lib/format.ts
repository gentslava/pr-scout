const nf = new Map<number, Intl.NumberFormat>()

export function fmt(n: number | null | undefined, digits = 0): string {
  if (!nf.has(digits)) nf.set(digits, new Intl.NumberFormat("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: digits }))
  return nf.get(digits)!.format(n ?? 0)
}

export function money(n: number | null | undefined): string {
  if (!n) return "$0"
  if (n < 1) return "$" + fmt(n, n < 0.01 ? 4 : n < 0.1 ? 3 : 2)
  return "$" + fmt(n, n < 10 ? 2 : 0)
}

export function secs(s: number | null | undefined): string {
  const v = s ?? 0
  if (v < 90) return `${fmt(v)} с`
  if (v < 5400) return `${fmt(v / 60, 1)} мин`
  return `${fmt(v / 3600, 1)} ч`
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return ""
  const m = (Date.now() - new Date(iso).getTime()) / 60000
  if (m < 1) return "только что"
  if (m < 60) return `${Math.round(m)} мин назад`
  if (m < 1440) return `${Math.round(m / 60)} ч назад`
  const d = Math.round(m / 1440)
  if (d < 45) return `${d} дн назад`
  if (d < 365) return `${count(Math.round(d / 30), "месяц", "месяца", "месяцев")} назад`
  return `${count(Math.round(d / 365), "год", "года", "лет")} назад`
}

export const avatarUrl = (repo: string, size = 64) => `https://github.com/${repo.split("/")[0]}.png?size=${size}`

/** Russian plural: plural(2, "группа", "группы", "групп") → "группы". */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10
  if (a > 10 && a < 20) return many
  if (b === 1) return one
  if (b >= 2 && b <= 4) return few
  return many
}

/** A count with its noun: count(2, "группа", "группы", "групп") → "2 группы". */
export const count = (n: number, one: string, few: string, many: string) => `${fmt(n)} ${plural(n, one, few, many)}`
