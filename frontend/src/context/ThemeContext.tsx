import * as React from "react";

type Theme = "light" | "dark" | "system";

interface ThemeState {
  theme: Theme;
  resolved: "light" | "dark";
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const ctx = React.createContext<ThemeState | null>(null);
const STORAGE_KEY = "dv-theme";

function systemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(t: "light" | "dark") {
  const root = document.documentElement;
  root.classList.toggle("dark", t === "dark");
  root.style.colorScheme = t;
  root.removeAttribute("data-skin");
}

export function useTheme() {
  const v = React.useContext(ctx);
  if (!v) throw new Error("useTheme must be used within ThemeProvider");
  return v;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") return stored;
    } catch {
      /* storage unavailable */
    }
    return "dark";
  });
  const [resolved, setResolved] = React.useState<"light" | "dark">(() => (theme === "system" ? systemTheme() : theme));

  React.useEffect(() => {
    const actual = theme === "system" ? systemTheme() : theme;
    setResolved(actual);
    apply(actual);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  React.useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const actual = systemTheme();
      setResolved(actual);
      apply(actual);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = React.useCallback((t: Theme) => setThemeState(t), []);
  const toggle = React.useCallback(() => {
    setThemeState((prev) => ((prev === "system" ? systemTheme() : prev) === "dark" ? "light" : "dark"));
  }, []);

  const value = React.useMemo<ThemeState>(() => ({ theme, resolved, setTheme, toggle }), [theme, resolved, setTheme, toggle]);
  return <ctx.Provider value={value}>{children}</ctx.Provider>;
}
