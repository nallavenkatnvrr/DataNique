import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { jobsApi, type Job, type JobEvent } from "@/api/engine";

const DONE = new Set(["done", "error", "cancelled"]);

export function isFinished(job: Pick<Job, "status"> | null | undefined): boolean {
  return !!job && DONE.has(job.status);
}

/**
 * Follow a job: polls only for new log lines (``since``), backs off when
 * nothing changes, stops when the job finishes, pauses in hidden tabs.
 */
export function useJob(jobId: string | null | undefined) {
  const [job, setJob] = React.useState<Job | null>(null);
  const [events, setEvents] = React.useState<JobEvent[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!jobId) return;
    let alive = true;
    let since = 0;
    let delay = 250;
    let timer: number | undefined;
    setJob(null);
    setEvents([]);
    setError(null);

    const tick = async () => {
      if (!alive) return;
      if (document.hidden) {
        timer = window.setTimeout(tick, 1000);
        return;
      }
      try {
        const snap = await jobsApi.get(jobId, since);
        if (!alive) return;
        if (snap.events.length) {
          since = snap.events[snap.events.length - 1].seq;
          setEvents((prev) => {
            const next = prev.concat(snap.events);
            return next.length > 3000 ? next.slice(-3000) : next;
          });
          delay = 250;
        } else {
          delay = Math.min(delay * 1.3, 1200);
        }
        setJob(snap);
        if (isFinished(snap) && !(snap.kind === "bulk" && snap.children?.some((c) => !isFinished(c)))) return;
      } catch (e: any) {
        if (!alive) return;
        setError(String(e?.message ?? e));
        delay = 2000;
      }
      timer = window.setTimeout(tick, delay);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [jobId]);

  return { job, events, error };
}

/** Jobs still running (for the top-bar indicator). */
export function useActiveJobs() {
  return useQuery({
    queryKey: ["jobs", "active"],
    queryFn: () => jobsApi.list(true),
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 ? 1500 : 6000),
    refetchIntervalInBackground: false,
    staleTime: 1000,
  });
}

export function phaseLabel(phase: string): string {
  return (
    {
      queued: "Queued",
      connect: "Reading metadata",
      read: "Reading",
      prepare: "Matching columns",
      diff: "Comparing",
      stats: "Column statistics",
      store: "Saving differences",
      running: "Running",
      finished: "Finished",
    } as Record<string, string>
  )[phase] ?? phase;
}
