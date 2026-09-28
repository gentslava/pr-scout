import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react"
import { useTheme } from "next-themes"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const OPTIONS: [string, string, LucideIcon][] = [["system", "Как в системе", Monitor], ["light", "Светлая", Sun], ["dark", "Тёмная", Moon]]

/**
 * System by default; light or dark only once the user picks one, and back to system any time.
 * The selection is styled by aria-checked: the tooltip trigger takes over data-state.
 */
export function ThemeSwitch() {
  const { theme, setTheme } = useTheme()
  return (
    <ToggleGroup type="single" value={theme ?? "system"} onValueChange={(v) => v && setTheme(v)} aria-label="Тема"
      className="rounded-full border bg-background p-0.5">
      {OPTIONS.map(([value, label, Icon]) => (
        <Tooltip key={value}>
          <TooltipTrigger asChild>
            <ToggleGroupItem value={value} aria-label={label}
              className="size-7 min-w-0 rounded-full p-0 text-muted-foreground hover:text-foreground aria-checked:bg-muted aria-checked:text-foreground aria-checked:shadow-card">
              <Icon className="size-3.5" />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent side="top">{label}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  )
}
