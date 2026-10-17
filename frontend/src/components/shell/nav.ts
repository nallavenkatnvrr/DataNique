import { BookMarked, Code2, Database, Diff, GitCompareArrows, History, Home, Layers, Settings } from "lucide-react";

export const NAV = [
  { to: "/", label: "Home", icon: Home, hint: "Overview", group: "main" },
  { to: "/compare", label: "Compare", icon: GitCompareArrows, hint: "Tables, queries, files", group: "main" },
  { to: "/bulk", label: "Bulk", icon: Layers, hint: "Many pairs at once", group: "main" },
  { to: "/history", label: "History", icon: History, hint: "Runs and diffs", group: "main" },
  { to: "/templates", label: "Templates", icon: BookMarked, hint: "Saved compares", group: "main" },
  { to: "/sql-ide", label: "SQL IDE", icon: Code2, hint: "Query editor", group: "work" },
  { to: "/connections", label: "Connections", icon: Database, hint: "Databases", group: "work" },
  { to: "/diff-merge", label: "Text diff", icon: Diff, hint: "Diff two texts", group: "work" },
  { to: "/settings", label: "Settings", icon: Settings, hint: "Security, engine, storage", group: "bottom" },
] as const;
