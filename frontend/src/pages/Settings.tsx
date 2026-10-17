import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, FolderCog, KeyRound, Lock, Palette, Settings as SettingsIcon, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api, errorText } from "@/api/client";
import { systemApi, vaultApi } from "@/api/engine";
import { Field, PageHeader, Segmented, Spinner, Switch } from "@/components/kit";
import { lockNow, passwordProblems } from "@/components/vault/VaultGate";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/context/ThemeContext";
import { detectRenderer, getEffectsPref, setEffectsPref, type EffectsPref } from "@/lib/effects";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "engine", label: "Engine & readers", icon: Cpu },
  { id: "storage", label: "Storage", icon: FolderCog },
  { id: "appearance", label: "Appearance", icon: Palette },
] as const;

export function SettingsPage() {
  const [sec, setSec] = React.useState<(typeof SECTIONS)[number]["id"]>("security");
  return (
    <div className="mx-auto max-w-[1200px] space-y-5 p-6">
      <PageHeader icon={<SettingsIcon className="h-5 w-5" />} title="Settings" />
      <div className="grid gap-5 md:grid-cols-[200px_1fr]">
        <nav className="flex gap-1 md:flex-col">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" onClick={() => setSec(s.id)}
              className={cn("flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm", sec === s.id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
              <s.icon className="h-4 w-4" /> {s.label}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          {sec === "security" && <Security />}
          {sec === "engine" && <Engine />}
          {sec === "storage" && <Storage />}
          {sec === "appearance" && <Appearance />}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children, desc }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="dv-panel p-5">
      <div className="mb-4">
        <div className="font-semibold">{title}</div>
        {desc && <div className="text-sm text-muted-foreground">{desc}</div>}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Security() {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["vault-status"], queryFn: vaultApi.status });
  const save = useMutation({
    mutationFn: vaultApi.settings,
    onSuccess: (s) => { qc.setQueryData(["vault-status"], s); toast.success("Saved"); },
    onError: (e) => toast.error(errorText(e)),
  });
  const [oldPw, setOldPw] = React.useState("");
  const [newPw, setNewPw] = React.useState("");
  const [rkPw, setRkPw] = React.useState("");
  const [newKey, setNewKey] = React.useState<string | null>(null);
  const change = useMutation({
    mutationFn: () => vaultApi.changePassword(oldPw, newPw),
    onSuccess: () => { toast.success("Password changed"); setOldPw(""); setNewPw(""); },
    onError: (e) => toast.error(errorText(e)),
  });
  const rk = useMutation({
    mutationFn: () => vaultApi.newRecoveryKey(rkPw),
    onSuccess: (r) => { setNewKey(r.recovery_key); setRkPw(""); },
    onError: (e) => toast.error(errorText(e)),
  });
  const s = st.data;
  if (!s) return <Spinner />;
  return (
    <div className="space-y-4">
      <Section title="Vault" desc="Saved passwords, history, differences and templates are encrypted (AES-256-GCM) with a key unlocked by your master password.">
        <Switch checked={s.remembered} disabled={!s.remember_available} onChange={(v) => save.mutate({ remember: v })}
          label="Remember on this computer" hint={s.remember_available ? "Opens without the password for your Windows account (Windows Credential Manager)." : "No OS credential store found."} />
        <Field label="Lock after inactivity" hint="Asks for the password again (even when remembered).">
          <select className="dv-input w-56" value={s.auto_lock_minutes} onChange={(e) => save.mutate({ auto_lock_minutes: Number(e.target.value) })}>
            {[0, 5, 15, 30, 60, 120, 480].map((m) => <option key={m} value={m}>{m === 0 ? "Never" : m < 60 ? `${m} minutes` : `${m / 60} hours`}</option>)}
          </select>
        </Field>
        <Button variant="outline" onClick={() => void lockNow()}><Lock className="h-4 w-4" /> Lock now</Button>
      </Section>
      <Section title="Change master password">
        <div className="grid gap-3 md:grid-cols-2">
          <input type="password" className="dv-input" placeholder="Current password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
          <input type="password" className="dv-input" placeholder="New password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        </div>
        {newPw && passwordProblems(newPw).length > 0 && <div className="text-xs text-muted-foreground">Needs {passwordProblems(newPw).join(" and ")}.</div>}
        <Button disabled={!oldPw || passwordProblems(newPw).length > 0} loading={change.isPending} onClick={() => change.mutate()}>Change password</Button>
      </Section>
      <Section title="Recovery key" desc="Replaces the old key; the previous one stops working.">
        {newKey ? (
          <div className="rounded-xl border border-dashed border-primary/40 bg-primary/5 p-4 text-center font-mono text-lg font-semibold tracking-[0.12em] text-primary select-all">{newKey}</div>
        ) : (
          <div className="flex gap-2">
            <input type="password" className="dv-input max-w-xs" placeholder="Master password" value={rkPw} onChange={(e) => setRkPw(e.target.value)} />
            <Button variant="outline" disabled={!rkPw} loading={rk.isPending} onClick={() => rk.mutate()}><KeyRound className="h-4 w-4" /> New recovery key</Button>
          </div>
        )}
      </Section>
    </div>
  );
}

function Engine() {
  const v = useQuery({ queryKey: ["version"], queryFn: systemApi.version, staleTime: Infinity });
  if (!v.data) return <Spinner />;
  const names: Record<string, string> = { duckdb_postgres: "DuckDB postgres scanner", duckdb_mysql: "DuckDB mysql scanner", adbc_postgres: "ADBC PostgreSQL", adbc_mssql: "ADBC SQL Server (dbc)", adbc_mysql: "ADBC MySQL (dbc)", adbc_snowflake: "ADBC Snowflake", arrow_odbc: "Arrow ODBC", connectorx: "ConnectorX", oracle_arrow: "oracledb Arrow", snowflake_arrow: "Snowflake Arrow batches", cursor: "DB-API cursor" };
  return (
    <div className="space-y-4">
      <Section title="Reader chain per database" desc="Each side tries these in order; the run log names the one used. Override with DV_READER_ORDER_<DB>.">
        <div className="grid gap-3 md:grid-cols-2">
          {Object.entries(v.data.readers).map(([db, chain]) => (
            <div key={db} className="rounded-xl border p-3">
              <div className="mb-2 text-sm font-medium">{db}</div>
              <ol className="space-y-1">
                {chain.map((r, i) => (
                  <li key={r.name} className={cn("flex items-center gap-2 text-xs", !r.installed && "text-muted-foreground line-through")}>
                    <span className="grid h-5 w-5 place-items-center rounded-full bg-muted text-[10px] font-semibold">{i + 1}</span>{names[r.name] ?? r.name}
                    {!r.installed && <span className="no-underline">(not installed)</span>}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Libraries">
        <div className="grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
          {Object.entries({ ...v.data.libraries, ...v.data.drivers }).map(([k, ver]) => (
            <div key={k} className="flex justify-between border-b py-1.5"><span>{k}</span><span className={cn("font-mono text-xs", ver ? "text-equal" : "text-muted-foreground")}>{ver ?? "not installed"}</span></div>
          ))}
        </div>
        <div className="text-xs text-muted-foreground">Datanique {v.data.app_version} · Python {v.data.python} · {v.data.platform}</div>
      </Section>
    </div>
  );
}

function Storage() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const [d, setD] = React.useState<{ scripts_dir: string; exports_dir: string } | null>(null);
  React.useEffect(() => { if (s.data) setD(s.data); }, [s.data]);
  const save = useMutation({
    mutationFn: () => api.updateSettings(d!),
    onSuccess: (x) => { qc.setQueryData(["settings"], x); toast.success("Saved"); },
    onError: (e) => toast.error(errorText(e)),
  });
  if (!d) return <Spinner />;
  return (
    <Section title="Folders" desc="SQL scripts saved from the SQL IDE and exported files.">
      <Field label="Scripts folder"><input className="dv-input font-mono text-xs" value={d.scripts_dir} onChange={(e) => setD({ ...d, scripts_dir: e.target.value })} /></Field>
      <Field label="Exports folder"><input className="dv-input font-mono text-xs" value={d.exports_dir} onChange={(e) => setD({ ...d, exports_dir: e.target.value })} /></Field>
      <Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
    </Section>
  );
}

function Appearance() {
  const { theme, setTheme } = useTheme();
  const [effects, setEffects] = React.useState<EffectsPref>(getEffectsPref);
  const [lite, setLite] = React.useState(() => document.documentElement.classList.contains("dv-lite"));
  const gpu = detectRenderer();
  return (
    <>
      <Section title="Theme">
        <Segmented value={theme} onChange={setTheme} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }]} />
      </Section>
      <Section title="Visual effects" desc="Light turns off shadows, transitions and animations. Use it when the app feels slow, for example on a virtual desktop.">
        <Segmented value={effects} onChange={(v) => { setEffects(v); setLite(setEffectsPref(v)); }}
          options={[{ value: "auto", label: "Automatic" }, { value: "full", label: "Full" }, { value: "lite", label: "Light" }]} />
        <div className="text-xs text-muted-foreground">
          Now: <span className="font-medium text-foreground">{lite ? "light" : "full"}</span>
          {effects === "auto" && <> · graphics: <span className="font-mono">{gpu.renderer || "unknown"}</span>{gpu.lite ? " (no acceleration)" : ""}</>}
        </div>
      </Section>
    </>
  );
}
