/**
 * API for the v2 compare engine, the vault, files, history and exports.
 */
import { apiAuthHeaders, apiUrl, raiseFor, request } from "./client";

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------
export interface VaultStatus {
  state: "setup" | "locked" | "unlocked";
  remembered: boolean;
  remember_available: boolean;
  auto_lock_minutes: number;
  unlocked_by: string | null;
  retry_after: number;
  created_at: string | null;
  has_recovery: boolean;
}

export const vaultApi = {
  status: () => request<VaultStatus>("GET", "/api/vault/status"),
  passwordCheck: (password: string) => request<{ problems: string[] }>("POST", "/api/vault/password-check", { password }),
  setup: (password: string, remember: boolean) =>
    request<{ token: string; recovery_key: string; migration: any; status: VaultStatus }>("POST", "/api/vault/setup", { password, remember }),
  unlock: (password: string, remember?: boolean) =>
    request<{ token: string; status: VaultStatus }>("POST", "/api/vault/unlock", { password, remember }),
  resume: () => request<{ token: string; status: VaultStatus }>("POST", "/api/vault/resume"),
  recover: (recovery_key: string, new_password: string) =>
    request<{ token: string; recovery_key: string; status: VaultStatus }>("POST", "/api/vault/recover", { recovery_key, new_password }),
  lock: () => request<VaultStatus>("POST", "/api/vault/lock"),
  changePassword: (old_password: string, new_password: string) =>
    request<{ ok: boolean }>("POST", "/api/vault/change-password", { old_password, new_password }),
  newRecoveryKey: (password: string) => request<{ recovery_key: string }>("POST", "/api/vault/recovery-key", { password }),
  settings: (p: { remember?: boolean; auto_lock_minutes?: number }) => request<VaultStatus>("PUT", "/api/vault/settings", p),
  reset: () => request<VaultStatus>("POST", "/api/vault/reset", { confirm: "RESET" }),
};

// ---------------------------------------------------------------------------
// Compare spec
// ---------------------------------------------------------------------------
export type SideKind = "table" | "query" | "file";
export type FileFormat = "csv" | "excel" | "parquet" | "json" | "avro" | "orc" | "arrow" | "fixed";

export interface FileOptions {
  delimiter?: string | null;
  header?: boolean | null;
  quote?: string | null;
  escape?: string | null;
  encoding?: string | null;
  skip_rows?: number;
  null_values?: string[] | null;
  date_format?: string | null;
  timestamp_format?: string | null;
  decimal_separator?: string | null;
  all_varchar?: boolean;
  sheet?: string | null;
  json_format?: "auto" | "array" | "newline_delimited";
  fixed_columns?: { name: string; width: number }[] | null;
  zip_member?: string | null;
}

export interface SideSpec {
  kind: SideKind;
  connection_id?: number | null;
  database?: string | null;
  schema_name?: string | null;
  table?: string | null;
  filter_sql?: string | null;
  sql?: string | null;
  file_id?: string | null;
  path?: string | null;
  format?: FileFormat | null;
  options?: FileOptions;
  label?: string | null;
}

export interface ColumnPair {
  source: string;
  target: string;
  role: "key" | "compare" | "ignore";
}

export interface Normalize {
  numbers: boolean;
  timestamps: boolean;
  booleans: boolean;
  rtrim: boolean;
  ltrim: boolean;
  case_insensitive: boolean;
  null_equals_empty: boolean;
  null_equals_blank: boolean;
  numeric_tolerance: number;
  timestamp_precision: "us" | "ms" | "s" | "min" | "day";
}

export const DEFAULT_NORMALIZE: Normalize = {
  numbers: true,
  timestamps: true,
  booleans: true,
  rtrim: false,
  ltrim: false,
  case_insensitive: false,
  null_equals_empty: false,
  null_equals_blank: false,
  numeric_tolerance: 0,
  timestamp_precision: "us",
};

export interface CompareOptions {
  key_columns?: string[] | null;
  key_positions?: number[] | null;
  excluded_columns?: string[] | null;
  column_map?: ColumnPair[] | null;
  match_columns?: "name" | "position";
  auto_key?: boolean;
  normalize?: Normalize;
  strategy?: "auto" | "local" | "in_database";
  column_stats?: boolean;
  distinct_counts?: boolean;
  sample_limit?: number;
  store_diffs?: boolean;
  max_stored_rows?: number;
  max_rows?: number;
  incremental_column?: string | null;
  since?: string | null;
  file_checks?: boolean;
}

export interface CompareSpec {
  name?: string | null;
  source: SideSpec;
  target: SideSpec;
  options: CompareOptions;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
export interface JobEvent {
  seq: number;
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  msg: string;
}

export interface RunSummary {
  verdict?: "MATCH" | "MISMATCH" | "ERROR" | "CANCELLED" | null;
  engine?: string | null;
  elapsed_ms?: number | null;
  source_rows?: number | null;
  target_rows?: number | null;
  only_in_source?: number | null;
  only_in_target?: number | null;
  changed?: number | null;
  matching?: number | null;
  source_kind?: string | null;
  target_kind?: string | null;
}

export interface Job {
  id: string;
  kind: "compare" | "bulk";
  name: string | null;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  phase: string;
  message: string;
  rows: Record<string, number>;
  /** read progress percentage per side, when the reader can tell */
  pct?: Record<string, number>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  elapsed_ms: number;
  run_uuid: string | null;
  batch_uuid: string | null;
  summary: RunSummary | { counts: Record<string, number>; total: number } | null;
  error: string | null;
  events: JobEvent[];
  seq: number;
  parent_id: string | null;
  source_label?: string;
  target_label?: string;
  children?: Job[];
  counts?: Record<string, number>;
  total?: number;
}

export interface DescribeResult {
  columns: { name: string; type: string | null }[];
  preview: unknown[][];
  primary_key?: string[];
  row_estimate?: number | null;
  // files
  format?: string;
  compression?: string | null;
  file_name?: string;
  size_bytes?: number;
  sheets?: string[] | null;
  zip_members?: string[] | null;
  detected?: Record<string, any>;
  row_count?: number | null;
}

export interface BulkItem {
  name?: string | null;
  source: SideSpec;
  target: SideSpec;
  options: CompareOptions;
}

export interface PairContainer {
  kind: "schema" | "folder" | "files";
  connection_id?: number | null;
  database?: string | null;
  schema_name?: string | null;
  path?: string | null;
  file_ids?: string[];
  names?: string[];
}

export interface PairResult {
  pairs: { source: { name: string; side: SideSpec }; target: { name: string; side: SideSpec } }[];
  unmatched_source: { name: string; side: SideSpec }[];
  unmatched_target: { name: string; side: SideSpec }[];
}

export const jobsApi = {
  compare: (spec: CompareSpec) => request<Job>("POST", "/api/jobs/compare", spec),
  bulk: (spec: { name?: string | null; items: BulkItem[]; concurrency: number; stop_on_error?: boolean }) =>
    request<Job>("POST", "/api/jobs/bulk", spec),
  get: (id: string, since = 0) => request<Job>("GET", `/api/jobs/${id}?since=${since}`),
  list: (active = false) => request<Job[]>("GET", `/api/jobs${active ? "?active=true" : ""}`),
  cancel: (id: string) => request<Job>("POST", `/api/jobs/${id}/cancel`),
  describe: (side: SideSpec, preview = 20) => request<DescribeResult>("POST", `/api/jobs/describe?preview=${preview}`, side),
  pair: (body: { source: PairContainer; target: PairContainer; strip_prefix?: string; strip_suffix?: string }) =>
    request<PairResult>("POST", "/api/jobs/pair", body),
};

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
export interface UploadResult {
  file_id: string;
  name: string;
  size_bytes: number;
  inspect?: DescribeResult;
  inspect_error?: string;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; dir: boolean; size_bytes?: number | null }[];
}

export const filesApi = {
  /** Upload with progress (XMLHttpRequest gives upload progress events). */
  upload: (file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<UploadResult> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", apiUrl("/api/files"));
      apiAuthHeaders().forEach((v, k) => xhr.setRequestHeader(k, v));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        const res = new Response(xhr.responseText, { status: xhr.status, statusText: xhr.statusText });
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else raiseFor(res).catch(reject);
      };
      xhr.onerror = () => reject(new Error("Upload failed"));
      signal?.addEventListener("abort", () => xhr.abort());
      const fd = new FormData();
      fd.append("file", file);
      xhr.send(fd);
    }),
  inspect: (body: { file_id?: string | null; path?: string | null; format?: string | null; options?: FileOptions }, preview = 50) =>
    request<DescribeResult>("POST", `/api/files/inspect?preview=${preview}`, body),
  remove: (fileId: string) => request<{ ok: boolean }>("DELETE", `/api/files/${fileId}`),
  browse: (path: string) => request<BrowseResult>("GET", `/api/files/browse?path=${encodeURIComponent(path)}`),
};

// ---------------------------------------------------------------------------
// History / results
// ---------------------------------------------------------------------------
export interface RunRow {
  id: number;
  run_uuid: string;
  status: string;
  verdict: string | null;
  kind: string | null;
  batch_id: string | null;
  source_label: string;
  target_label: string;
  started_at: string;
  finished_at: string | null;
  elapsed_ms: number | null;
  engine: string | null;
  summary: RunSummary;
  error: string | null;
}

export interface RunDetail extends RunRow {
  options: any;
  result: any;
  has_diff_store: boolean;
}

export interface DiffPage {
  kind: "changed" | "only_source" | "only_target";
  columns: { name: string; type: string | null }[];
  rows: unknown[][];
  total: number;
  offset: number;
}

export interface BatchRow {
  batch_uuid: string;
  name: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  total: number | null;
  counts: Record<string, number> | null;
}

export const runsApi = {
  list: (p: { limit?: number; offset?: number; verdict?: string; kind?: string; batch?: string; q?: string } = {}) => {
    const q = new URLSearchParams();
    Object.entries(p).forEach(([k, v]) => v !== undefined && v !== "" && q.set(k, String(v)));
    return request<{ items: RunRow[]; total: number; limit: number; offset: number }>("GET", `/api/compare/runs?${q}`);
  },
  get: (uuid: string) => request<RunDetail>("GET", `/api/compare/runs/${uuid}`),
  remove: (uuid: string) => request<void>("DELETE", `/api/compare/runs/${uuid}`),
  removeMany: (uuids: string[]) => request<{ deleted: number }>("POST", "/api/compare/runs/delete", { run_uuids: uuids }),
  diff: (uuid: string, p: { kind: string; offset: number; limit: number; search?: string; column?: string }) => {
    const q = new URLSearchParams({ kind: p.kind, offset: String(p.offset), limit: String(p.limit) });
    if (p.search) q.set("search", p.search);
    if (p.column) q.set("column", p.column);
    return request<DiffPage>("GET", `/api/compare/runs/${uuid}/diff?${q}`);
  },
  export: (uuid: string, body: { kind: string; format: string; search?: string; column?: string }) =>
    request<{ url: string; filename: string; size_bytes: number }>("POST", `/api/compare/runs/${uuid}/export`, body),
  report: (uuid: string) => request<{ url: string; filename: string; size_bytes: number }>("POST", `/api/compare/runs/${uuid}/report`),
  batches: () => request<BatchRow[]>("GET", "/api/compare/batches"),
  batch: (uuid: string) => request<BatchRow & { summary: any; runs: RunRow[] }>("GET", `/api/compare/batches/${uuid}`),
};

/** Open a one-time download link. The link needs no session header, so the
 *  browser streams it straight to disk (no copy in memory). */
export function downloadTicket(t: { url: string; filename: string }): void {
  const a = document.createElement("a");
  a.href = apiUrl(t.url);
  a.download = t.filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface VersionInfo {
  app: string;
  app_version: string;
  uptime_seconds: number;
  python: string;
  platform: string;
  engine: string;
  libraries: Record<string, string | null>;
  drivers: Record<string, string | null>;
  readers: Record<string, { name: string; installed: boolean }[]>;
}

export const systemApi = {
  version: () => request<VersionInfo>("GET", "/api/version"),
};
