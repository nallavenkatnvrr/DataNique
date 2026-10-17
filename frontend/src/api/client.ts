import { getSessionToken, signalVault, type VaultSignal } from "./session";

export type DbType = "snowflake" | "oracle" | "sqlserver" | "postgres" | "mysql";

export interface DbTypeField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
  default?: string | number;
  placeholder?: string;
  type?: "number" | "text";
}

export interface DbTypeMeta {
  type: DbType;
  label: string;
  fields: DbTypeField[];
}

export interface Connection {
  id: number;
  name: string;
  db_type: DbType;
  host: string | null;
  port: number | null;
  username: string | null;
  database: string | null;
  schema_name: string | null;
  extra: Record<string, unknown> | null;
  is_active: boolean;
  has_password: boolean;
  created_at: string;
  updated_at: string;
}

export interface ConnectionPayload {
  name: string;
  db_type: DbType;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  password?: string | null;
  database?: string | null;
  schema_name?: string | null;
  extra?: Record<string, unknown> | null;
  is_active?: boolean;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  ordinal_position: number;
  is_numeric: boolean;
  is_temporal: boolean;
  is_string: boolean;
}

export interface SqlSession {
  session_id: string;
  connection_id: number;
  name: string;
  created_at: string;
  execution_count: number;
  running: boolean;
  executions: SqlExecution[];
}

export interface SqlExecution {
  exec_id: string;
  session_id: string;
  connection_id: number;
  sql: string;
  status: "queued" | "running" | "success" | "error" | "cancelled";
  columns: string[];
  rows: any[][];
  row_count: number;
  /** Rows held server-side for the primary result (windowed responses). */
  total_rows?: number;
  window_offset?: number;
  has_more?: boolean;
  affected_rows: number | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  elapsed_ms: number;
  result_sets: ResultSet[];
  session_name?: string;
  /** One entry per statement, in execution order. */
  messages?: SqlStatementMessage[];
  /** Index (into the submitted statements) of the first failing statement. */
  error_statement_index?: number | null;
  autocommit?: boolean;
  /** Lightweight polling: statements started so far / submitted. */
  statement_count?: number;
  statement_total?: number | null;
}

export interface SqlStatementMessage {
  index: number;
  sql: string;
  status: "running" | "success" | "error" | "skipped" | "cancelled";
  rows: number;
  affected_rows: number | null;
  elapsed_ms: number;
  error: string | null;
  result_sets: number[];
  note?: string;
}

export interface ResultSet {
  index: number;
  columns: string[];
  rows: any[][];
  row_count: number;
  truncated: boolean;
  total_rows?: number;
  window_offset?: number;
  has_more?: boolean;
  /** Statement (index into the submitted statements) that produced this set. */
  statement_index?: number;
  /** First line of that statement, for result-tab titles. */
  title?: string;
}

export interface ExecuteOptions {
  connectionId?: number;
  maxRows?: number;
  context?: SnowflakeContext;
  /** Pre-split statements (same rules as the server splitter). */
  statements?: string[];
  autocommit?: boolean;
  stopOnError?: boolean;
}

export interface DbObjects {
  database: string | null;
  schema: string | null;
  tables: string[];
  views: string[];
  procedures: string[];
  functions: string[];
}

export interface ObjectDefinition {
  definition: string | null;
  object_type: string;
  name: string;
  error?: string;
}

/** Per-query Snowflake session context. Each non-empty field is sent
 *  to the backend, which translates it into a USE statement run BEFORE
 *  the user's SQL. */
export interface SnowflakeContext {
  role?: string | null;
  warehouse?: string | null;
  database?: string | null;
  schema_name?: string | null;
}

/** Response from /api/connections/{id}/snowflake/context - the lists the
 *  Snowflake account exposes, plus the connection's current session.
 *  Each list comes with diagnostics so the UI can show specific errors
 *  per dropdown instead of a single perpetual loading spinner. */
export interface SnowflakeListDiagnostic {
  ok: boolean;
  error: string | null;
  elapsed_ms?: number;
}

export interface SnowflakeContextResponse {
  warehouses: string[];
  roles: string[];
  databases: string[];
  schemas: string[];
  current: {
    warehouse: string | null;
    role: string | null;
    database: string | null;
    schema: string | null;
  };
  diagnostics?: {
    warmup?: SnowflakeListDiagnostic;
    warehouses: SnowflakeListDiagnostic;
    roles: SnowflakeListDiagnostic;
    databases: SnowflakeListDiagnostic;
    schemas: SnowflakeListDiagnostic | null;
    current: SnowflakeListDiagnostic;
  };
  /** Set by the backend when the metadata connector was just
   *  force-evicted due to a wedged query. The frontend should retry
   *  ONCE automatically - the next call will start with a fresh
   *  Snowflake session and should succeed if the underlying issue
   *  was a transient driver hang. */
  evicted_and_ready_for_retry?: boolean;
  /** Human-readable explanation of Snowflake's privilege model - empty
   *  lists usually mean "your role lacks USAGE" rather than a bug. */
  note?: string;
}

/** Per-step diagnostic from /snowflake/diagnose. Each item shows whether
 *  it succeeded, how long it took, and the error if any. */
export interface SnowflakeDiagnoseStep {
  step: string;
  ok: boolean;
  elapsed_ms: number;
  error: string | null;
  data?: unknown;
}

export interface SnowflakeDiagnoseResponse {
  steps: SnowflakeDiagnoseStep[];
  summary: string;
}

export interface CompareTemplate {
  id: number;
  name: string;
  description: string | null;
  payload: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface TemplatePayload {
  name: string;
  description?: string | null;
  payload: Record<string, any>;
}

// --- Dashboard metrics ---
export interface DashboardMetrics {
  window_days: number;
  total_runs: number;
  match_count: number;
  mismatch_count: number;
  error_count: number;
  success_rate: number;
  avg_elapsed_ms: number;
  total_rows_compared: number;
  template_count: number;
  verdict_breakdown: Record<string, number>;
  status_breakdown: Record<string, number>;
  engine_usage: Record<string, number>;
  daily_activity: { date: string; count: number }[];
  recent_runs: {
    run_uuid: string;
    status: string;
    verdict: string | null;
    engine: string | null;
    source_label: string;
    target_label: string;
    started_at: string;
    elapsed_ms: number | null;
  }[];
}

/**
 * Base URL for all backend calls.
 *
 * - **Web / Vite dev**: empty string → relative `/api/...` paths, which the
 *   Vite dev proxy (and same-origin prod web build) forwards to the backend.
 * - **Electron desktop**: the preload script sets `window.__API_BASE__` to the
 *   loopback address of the bundled FastAPI backend (e.g. `http://127.0.0.1:8137`).
 *   The UI loads from `file://`, so relative `/api` paths would not resolve -
 *   this absolute base is required there.
 */
declare global {
  interface Window {
    __API_BASE__?: string;
    __API_TOKEN__?: string;
    __ADMIN_TOKEN__?: string;
  }
}

export const API_BASE: string =
  (typeof window !== "undefined" && window.__API_BASE__) || "";

const BUILD_API_TOKEN = import.meta.env.VITE_API_TOKEN ?? "";
const BUILD_ADMIN_TOKEN = import.meta.env.VITE_ADMIN_TOKEN ?? "";

/** Session token (vault unlock) plus optional API/admin tokens. Tokens are
 *  never placed in URLs. Build-time values are public in the client bundle. */
export function apiAuthHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  const session = getSessionToken();
  if (session) result.set("X-DV-Session", session);
  const apiToken = typeof window !== "undefined" ? window.__API_TOKEN__ ?? BUILD_API_TOKEN : BUILD_API_TOKEN;
  const adminToken = typeof window !== "undefined" ? window.__ADMIN_TOKEN__ ?? BUILD_ADMIN_TOKEN : BUILD_ADMIN_TOKEN;
  if (apiToken) result.set("X-API-Token", apiToken);
  if (adminToken) result.set("X-Admin-Token", adminToken);
  return result;
}

/** Join the API base with a root-relative `/api/...` path. */
export function apiUrl(path: string): string {
  if (!API_BASE) return path;
  return API_BASE.replace(/\/$/, "") + path;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  /** The server's message without the "404 Not Found:" prefix. */
  detail: string;
  constructor(status: number, statusText: string, detail: string, code?: string) {
    // "<status> <text>: <detail>" - the SQL IDE matches on the leading status.
    super(`${status} ${statusText}: ${detail}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/** Human-readable error text for toasts. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.detail;
  return String((e as any)?.message ?? e);
}

/** Throw an ApiError for a failed response; signal the vault gate on 401/423. */
export async function raiseFor(res: Response): Promise<never> {
  let detail: any;
  try {
    detail = await res.json();
  } catch {
    detail = await res.text().catch(() => "");
  }
  const code = typeof detail === "object" ? detail?.code : undefined;
  if (res.status === 423 || (res.status === 401 && code === "session_required")) {
    signalVault((code as VaultSignal) || "vault_locked");
  }
  const msg = typeof detail === "object" && detail?.detail
    ? (typeof detail.detail === "string" ? detail.detail : JSON.stringify(detail.detail))
    : String(detail || res.statusText);
  throw new ApiError(res.status, res.statusText, msg, code);
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: apiAuthHeaders({ "Content-Type": "application/json" }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) await raiseFor(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ status: string; uptime_seconds: number }>("GET", "/api/health"),

  dbTypes: () => request<DbTypeMeta[]>("GET", "/api/connections/types"),
  listConnections: () => request<Connection[]>("GET", "/api/connections"),
  createConnection: (p: ConnectionPayload) => request<Connection>("POST", "/api/connections", p),
  updateConnection: (id: number, p: ConnectionPayload) => request<Connection>("PUT", `/api/connections/${id}`, p),
  deleteConnection: (id: number) => request<void>("DELETE", `/api/connections/${id}`),
  testConnection: (id: number) => request<{ ok: boolean; ping?: string; error?: string }>("POST", `/api/connections/${id}/test`),
  testUnsavedConnection: (p: ConnectionPayload) =>
    request<{ ok: boolean; ping?: string; error?: string }>("POST", `/api/connections/test-payload`, p),

  listDatabases: (id: number) =>
    request<{ databases: string[]; default?: string | null; error?: string }>("GET", `/api/connections/${id}/databases`),
  listSchemas: (id: number, database?: string) => {
    const q = database ? `?database=${encodeURIComponent(database)}` : "";
    return request<{ schemas: string[]; default?: string | null; error?: string }>("GET", `/api/connections/${id}/schemas${q}`);
  },
  listTables: (id: number, database?: string, schema?: string) => {
    const params = new URLSearchParams();
    if (database) params.set("database", database);
    if (schema) params.set("schema", schema);
    const q = params.toString();
    return request<{ tables: string[]; error?: string }>("GET", `/api/connections/${id}/tables${q ? `?${q}` : ""}`);
  },
  listColumns: (id: number, table: string, database?: string, schema?: string) => {
    const params = new URLSearchParams();
    params.set("table", table);
    if (database) params.set("database", database);
    if (schema) params.set("schema", schema);
    return request<{ columns: ColumnInfo[]; error?: string }>("GET", `/api/connections/${id}/columns?${params}`);
  },
  listObjects: (id: number, database?: string, schema?: string) => {
    const params = new URLSearchParams();
    if (database) params.set("database", database);
    if (schema) params.set("schema", schema);
    const q = params.toString();
    return request<DbObjects>("GET", `/api/connections/${id}/objects${q ? `?${q}` : ""}`);
  },
  getObjectDefinition: (id: number, name: string, objectType?: string, database?: string, schema?: string) => {
    const params = new URLSearchParams();
    params.set("name", name);
    if (objectType) params.set("object_type", objectType);
    if (database) params.set("database", database);
    if (schema) params.set("schema", schema);
    return request<ObjectDefinition>("GET", `/api/connections/${id}/object-definition?${params}`);
  },

  // --- SQL IDE ---
  createSession: (connectionId: number, name?: string) =>
    request<SqlSession>("POST", "/api/sql-ide/sessions", { connection_id: connectionId, name: name || "Untitled" }),
  listSessions: () => request<SqlSession[]>("GET", "/api/sql-ide/sessions"),
  getSession: (sessionId: string, includeResults = false) =>
    request<SqlSession>("GET", `/api/sql-ide/sessions/${sessionId}?include_results=${includeResults}`),
  renameSession: (sessionId: string, name: string) =>
    request<SqlSession>("PUT", `/api/sql-ide/sessions/${sessionId}/rename`, { name }),
  changeSessionConnection: (sessionId: string, connectionId: number) =>
    request<SqlSession>("PUT", `/api/sql-ide/sessions/${sessionId}/connection`, { connection_id: connectionId }),
  deleteSession: (sessionId: string) =>
    request<void>("DELETE", `/api/sql-ide/sessions/${sessionId}`),

  executeQuery: (sessionId: string, sql: string, opts: ExecuteOptions = {}) => {
    const ctx = opts.context;
    return request<SqlExecution>("POST", `/api/sql-ide/sessions/${sessionId}/execute`, {
      sql,
      connection_id: opts.connectionId || undefined,
      // Omit when not specified so the backend's default cap applies
      // (rows are windowed to the browser, so a large cap is safe).
      max_rows: opts.maxRows || undefined,
      snowflake_context: ctx && (ctx.role || ctx.warehouse || ctx.database || ctx.schema_name) ? ctx : undefined,
      statements: opts.statements?.length ? opts.statements : undefined,
      autocommit: opts.autocommit ?? true,
      stop_on_error: opts.stopOnError ?? true,
    });
  },
  /** COMMIT the tab session's open transaction (manual-commit mode). */
  commitSession: (sessionId: string) =>
    request<{ ok: boolean; action: string; elapsed_ms: number; finished_at: string }>("POST", `/api/sql-ide/sessions/${sessionId}/commit`),
  /** ROLLBACK the tab session's open transaction (manual-commit mode). */
  rollbackSession: (sessionId: string) =>
    request<{ ok: boolean; action: string; elapsed_ms: number; finished_at: string }>("POST", `/api/sql-ide/sessions/${sessionId}/rollback`),
  /** Close several sessions (and their DB connections); unknown ids are ignored. */
  closeSessions: (sessionIds: string[], keepalive = false) =>
    fetch(apiUrl("/api/sql-ide/sessions/close"), {
      method: "POST",
      keepalive,
      headers: apiAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ session_ids: sessionIds }),
    }).then((r) => (r.ok ? (r.json() as Promise<{ closed: string[] }>) : { closed: [] })),

  // Snowflake-specific metadata
  getSnowflakeContext: (id: number, database?: string) => {
    const q = database ? `?database=${encodeURIComponent(database)}` : "";
    return request<SnowflakeContextResponse>("GET", `/api/connections/${id}/snowflake/context${q}`);
  },
  getSnowflakeSchemas: (id: number, database: string) =>
    request<{ schemas: string[]; error?: string }>(
      "GET",
      `/api/connections/${id}/snowflake/schemas?database=${encodeURIComponent(database)}`,
    ),
  diagnoseSnowflake: (id: number) =>
    request<SnowflakeDiagnoseResponse>(
      "GET",
      `/api/connections/${id}/snowflake/diagnose`,
    ),
  getExecution: (sessionId: string, execId: string, opts?: { lightweight?: boolean; offset?: number; limit?: number }) => {
    const p = new URLSearchParams();
    if (opts?.lightweight) p.set("lightweight", "true");
    if (opts?.offset != null) p.set("offset", String(opts.offset));
    if (opts?.limit != null) p.set("limit", String(opts.limit));
    const q = p.toString();
    return request<SqlExecution>(
      "GET",
      `/api/sql-ide/sessions/${sessionId}/executions/${execId}${q ? `?${q}` : ""}`,
    );
  },
  // Fetch a row window from an already-completed execution (lazy scroll).
  getExecutionRows: (sessionId: string, execId: string, offset: number, limit: number, setIndex = 0) => {
    const p = new URLSearchParams({ offset: String(offset), limit: String(limit), set_index: String(setIndex) });
    return request<{ set_index: number; rows: any[][]; window_offset: number; total_rows: number; has_more: boolean }>(
      "GET",
      `/api/sql-ide/sessions/${sessionId}/executions/${execId}/rows?${p}`,
    );
  },
  cancelExecution: (sessionId: string, execId: string) =>
    request<SqlExecution>("POST", `/api/sql-ide/sessions/${sessionId}/executions/${execId}/cancel`),
  clearExecution: (sessionId: string, execId: string) =>
    request<void>("DELETE", `/api/sql-ide/sessions/${sessionId}/executions/${execId}`),

  runningQueries: () => request<SqlExecution[]>("GET", "/api/sql-ide/queries/running"),
  recentQueries: (limit = 100) => request<SqlExecution[]>("GET", `/api/sql-ide/queries/recent?limit=${limit}`),

  generateDDL: (connectionId: number, table: string, database?: string, schemaName?: string) =>
    request<{ sql: string | null; type: string; error?: string }>("POST", "/api/sql-ide/generate/ddl", {
      connection_id: connectionId, table, database, schema_name: schemaName,
    }),
  generateInsert: (connectionId: number, table: string, database?: string, schemaName?: string, limit?: number) =>
    request<{ sql: string | null; type: string; error?: string }>("POST", "/api/sql-ide/generate/insert", {
      connection_id: connectionId, table, database, schema_name: schemaName, limit: limit || 100,
    }),
  generateExecProc: (dbType: string, procName: string, database?: string, schemaName?: string, params?: any[]) =>
    request<{ sql: string | null; type: string; error?: string }>("POST", "/api/sql-ide/generate/exec-proc", {
      db_type: dbType, proc_name: procName, database, schema_name: schemaName, params,
    }),

  // --- Saved compare templates ---
  listTemplates: () => request<CompareTemplate[]>("GET", "/api/templates"),
  getTemplate: (id: number) => request<CompareTemplate>("GET", `/api/templates/${id}`),
  createTemplate: (p: TemplatePayload) => request<CompareTemplate>("POST", "/api/templates", p),
  updateTemplate: (id: number, p: Partial<TemplatePayload>) =>
    request<CompareTemplate>("PUT", `/api/templates/${id}`, p),
  deleteTemplate: (id: number) => request<void>("DELETE", `/api/templates/${id}`),

  // --- Dashboard metrics ---
  dashboardMetrics: (days = 30) =>
    request<DashboardMetrics>("GET", `/api/metrics/dashboard?days=${days}`),

  // --- App settings (configurable storage locations) ---
  getSettings: () => request<AppSettings>("GET", "/api/settings"),
  updateSettings: (p: Partial<AppSettings>) => request<AppSettings>("PUT", "/api/settings", p),

  // --- Saved SQL scripts (per-connection workspaces, versioned on disk) ---
  saveScript: (workspace: string, name: string, content: string) =>
    request<SavedScriptResult>("POST", "/api/scripts/save", { workspace, name, content }),
  listScripts: (workspace: string) =>
    request<SavedScript[]>("GET", `/api/scripts?workspace=${encodeURIComponent(workspace)}`),
  loadScript: (workspace: string, name: string) =>
    request<{ name: string; path: string; content: string }>(
      "GET", `/api/scripts/load?workspace=${encodeURIComponent(workspace)}&name=${encodeURIComponent(name)}`),
  listScriptVersions: (workspace: string, name: string) =>
    request<ScriptVersion[]>(
      "GET", `/api/scripts/versions?workspace=${encodeURIComponent(workspace)}&name=${encodeURIComponent(name)}`),
  loadScriptVersion: (workspace: string, name: string, version: string) =>
    request<{ name: string; version: string; path: string; content: string }>(
      "GET", `/api/scripts/version?workspace=${encodeURIComponent(workspace)}&name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}`),
};

// --- App settings + saved-script types ---
export interface AppSettings {
  scripts_dir: string;
  exports_dir: string;
}

export interface SavedScriptResult {
  workspace: string;
  name: string;
  path: string;
  backed_up_path: string | null;
  version_count: number;
}

export interface SavedScript {
  name: string;
  path: string;
  size: number;
  modified: string;
  version_count: number;
}

export interface ScriptVersion {
  version: string;
  path: string;
  size: number;
  modified: string;
}
