import * as React from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "@/context/ThemeContext";
import { cn } from "@/lib/utils";

/** Three-state theme switcher: light / system / dark */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();

  const opts = [
    { value: "light" as const, icon: Sun, label: "Light" },
    { value: "system" as const, icon: Monitor, label: "System" },
    { value: "dark" as const, icon: Moon, label: "Dark" },
  ];

  if (compact) {
    const current = opts.find((o) => o.value === theme) || opts[1];
    const next = opts[(opts.indexOf(current) + 1) % opts.length];
    const Icon = current.icon;
    return (
      <button
        onClick={() => setTheme(next.value)}
        className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        title={`Theme: ${current.label} (click for ${next.label})`}
      >
        <Icon className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border bg-card p-0.5">
      {opts.map((o) => {
        const Icon = o.icon;
        const active = theme === o.value;
        return (
          <button
            key={o.value}
            onClick={() => setTheme(o.value)}
            className={cn(
              "px-2 py-1 rounded text-xs flex items-center gap-1 transition-colors",
              active ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
            title={o.label}
          >
            <Icon className="h-3 w-3" />
            <span className="hidden sm:inline">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
