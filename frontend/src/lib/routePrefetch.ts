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

/** After start-up, load every page's code in the background, one page per
 *  idle moment, so the first visit to any page is as quick as later ones.
 *  Pages most people open first go first. */
export function preloadAllRoutes(): void {
  const order = ["/compare", "/history", "/sql-ide", "/connections", "/templates", "/bulk", "/settings", "/diff-merge"];
  const w = window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number };
  const idle = (cb: () => void) => {
    if (w.requestIdleCallback) w.requestIdleCallback(cb, { timeout: 3000 });
    else w.setTimeout(cb, 200);
  };
  const next = (i: number) => {
    if (i >= order.length) return;
    idle(() => {
      const path = order[i];
      const importer = chunkImporters[path];
      if (importer && !fetched.has(path)) {
        fetched.add(path);
        importer().catch(() => fetched.delete(path)).finally(() => next(i + 1));
      } else next(i + 1);
    });
  };
  window.setTimeout(() => next(0), 600);
}

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
