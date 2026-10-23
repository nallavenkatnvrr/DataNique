/**
 * Pages are separate script files with a content hash in their name. After an
 * update, a window that still runs the previous version asks for file names
 * that no longer exist ("Failed to fetch dynamically imported module").
 * The fix is to load the current version: reload the page, at most once per
 * 30 seconds so a real network problem can't cause a reload loop.
 */
const KEY = "dv-chunk-reload-at";

export function isChunkLoadError(err: unknown): boolean {
  const msg = String((err as { message?: string } | null)?.message ?? err ?? "");
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError|Expected a JavaScript/i.test(msg);
}

/** Reloads unless it already did so in the last 30 s. Returns true if it reloads. */
export function reloadForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* storage unavailable: still reload once */
  }
  window.location.reload();
  return true;
}

/** Wraps a dynamic import: a missing page file reloads the app instead of
 *  failing (the promise then never settles, the page is going away). */
export function importWithReload<T>(loader: () => Promise<T>): Promise<T> {
  return loader().catch((err) => {
    if (isChunkLoadError(err) && reloadForNewVersion()) return new Promise<T>(() => {});
    throw err;
  });
}

/** Vite reports failed preloads of a page's dependencies with this event. */
export function installChunkReload(): void {
  window.addEventListener("vite:preloadError", (e) => {
    e.preventDefault();
    reloadForNewVersion();
  });
}
