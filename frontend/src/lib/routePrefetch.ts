import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { runsApi } from "@/api/engine";

/** Hover a nav item → fetch its chunk and warm its first query. */
const chunkImporters: Record<string, () => Promise<unknown>> = {
  "/compare": () => import("@/pages/Compare"),
  "/bulk": () => import("@/pages/Bulk"),
  "/history": () => import("@/pages/History"),
  "/templates": () => import("@/pages/Templates"),
  "/connections": () => import("@/pages/Connections"),
  "/sql-ide": () => import("@/pages/SqlIde"),
  "/diff-merge": () => import("@/pages/DiffMerge"),
  "/settings": () => import("@/pages/Settings"),
};

const fetched = new Set<string>();

export function prefetchRoute(path: string, qc?: QueryClient): void {
  const importer = chunkImporters[path];
  if (importer && !fetched.has(path)) {
    fetched.add(path);
    importer().catch(() => fetched.delete(path));
  }
  if (!qc) return;
  const staleTime = 30_000;
  if (path === "/compare" || path === "/connections" || path === "/bulk") {
    void qc.prefetchQuery({ queryKey: ["connections"], queryFn: api.listConnections, staleTime });
  } else if (path === "/templates") {
    void qc.prefetchQuery({ queryKey: ["templates"], queryFn: api.listTemplates, staleTime });
  } else if (path === "/history") {
    void qc.prefetchQuery({ queryKey: ["runs", "list", "", "", ""], queryFn: () => runsApi.list({ limit: 200 }), staleTime: 5000 });
  }
}
