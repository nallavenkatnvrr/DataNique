/**
 * First-run master password, unlock, recovery and reset screens.
 * The app renders behind this gate; once unlocked it stays mounted and a
 * later lock (manual, idle, expired session) shows the lock screen on top.
 */
import * as React from "react";
import { Copy, Download, Eye, EyeOff, KeyRound, Lock, LockOpen, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { errorText } from "@/api/client";
import { vaultApi, type VaultStatus } from "@/api/engine";
import { getSessionToken, setSessionToken, type VaultSignal } from "@/api/session";
import { Logo } from "@/components/Logo";
import { Spinner, Switch } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Screen = "checking" | "setup" | "recovery-shown" | "unlock" | "recover" | "reset" | "ready" | "offline";

export function passwordProblems(pw: string): string[] {
  const p: string[] = [];
  if (pw.length < 10) p.push("at least 10 characters");
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 2) p.push("mix letters with digits or symbols");
  return p;
}

function strength(pw: string): number {
  if (!pw) return 0;
  let s = Math.min(pw.length, 20) / 20;
  s += [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length * 0.15;
  return Math.min(1, s);
}

export function VaultGate({ children }: { children: React.ReactNode }) {
  const [screen, setScreen] = React.useState<Screen>("checking");
  const [status, setStatus] = React.useState<VaultStatus | null>(null);
  const [everReady, setEverReady] = React.useState(false);
  const [recoveryKey, setRecoveryKey] = React.useState<string | null>(null);
  const [migration, setMigration] = React.useState<any>(null);

  const evaluate = React.useCallback(async () => {
    let st: VaultStatus;
    try {
      st = await vaultApi.status();
    } catch {
      setScreen("offline");
      return;
    }
    setStatus(st);
    if (st.state === "setup") {
      setScreen("setup");
      return;
    }
    if (st.state === "unlocked" && getSessionToken()) {
      try {
        const r = await fetch((window.__API_BASE__ || "") + "/api/connections/types", { headers: { "X-DV-Session": getSessionToken() || "" } });
        if (r.ok) {
          setScreen("ready");
          setEverReady(true);
          return;
        }
      } catch {
        /* fall through */
      }
    }
    if (st.remembered || st.unlocked_by === "remembered" || st.unlocked_by === "env") {
      try {
        const r = await vaultApi.resume();
        setSessionToken(r.token);
        setStatus(r.status);
        setScreen("ready");
        setEverReady(true);
        return;
      } catch {
        /* needs the password */
      }
    }
    setSessionToken(null);
    setScreen("unlock");
  }, []);

  React.useEffect(() => {
    void evaluate();
    const onSignal = (e: Event) => {
      const code = (e as CustomEvent<VaultSignal>).detail;
      if (code === "vault_setup") setScreen("setup");
      else void evaluate();
    };
    window.addEventListener("dv:vault", onSignal);
    return () => window.removeEventListener("dv:vault", onSignal);
  }, [evaluate]);

  const done = (token: string, st?: VaultStatus) => {
    setSessionToken(token);
    if (st) setStatus(st);
    setScreen("ready");
    setEverReady(true);
  };

  const overlay = screen !== "ready";
  return (
    <>
      {everReady && <div aria-hidden={overlay} className={cn("contents", overlay && "pointer-events-none")}>{children}</div>}
      {overlay && (
        <div className="fixed inset-0 z-[1000] overflow-y-auto bg-background">
          <Backdrop />
          <div className="relative flex min-h-full items-center justify-center p-6">
            {screen === "checking" && <Spinner className="h-6 w-6 text-primary" />}
            {screen === "offline" && (
              <Card title="Can't reach Datanique" icon={<TriangleAlert className="h-5 w-5" />}>
                <p className="text-sm text-muted-foreground">The local service isn't responding. It may still be starting.</p>
                <Button className="mt-5 w-full" onClick={() => { setScreen("checking"); void evaluate(); }}>Try again</Button>
              </Card>
            )}
            {screen === "setup" && (
              <Setup status={status} onDone={(r) => { setRecoveryKey(r.recovery_key); setMigration(r.migration); setSessionToken(r.token); setStatus(r.status); setScreen("recovery-shown"); }} />
            )}
            {screen === "recovery-shown" && recoveryKey && (
              <RecoveryShown recoveryKey={recoveryKey} migration={migration} onContinue={() => { setRecoveryKey(null); done(getSessionToken() || ""); }} />
            )}
            {screen === "unlock" && <Unlock status={status} onDone={done} onRecover={() => setScreen("recover")} onReset={() => setScreen("reset")} />}
            {screen === "recover" && <Recover onBack={() => setScreen("unlock")} onDone={(r) => { setRecoveryKey(r.recovery_key); setMigration(null); setSessionToken(r.token); setScreen("recovery-shown"); }} />}
            {screen === "reset" && <Reset onBack={() => setScreen("unlock")} onDone={() => { setSessionToken(null); setScreen("setup"); void evaluate(); }} />}
          </div>
        </div>
      )}
    </>
  );
}

function Backdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="dv-grid-bg absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />
      <div className="absolute -top-72 left-1/2 h-[760px] w-[1100px] -translate-x-1/2 bg-[radial-gradient(closest-side,hsl(var(--primary)/0.2),transparent)]" />
      <div className="absolute bottom-[-320px] right-[-260px] h-[700px] w-[800px] bg-[radial-gradient(closest-side,rgb(6_182_212/0.1),transparent)]" />
    </div>
  );
}

function Card({ title, subtitle, icon, children, wide }: { title: string; subtitle?: React.ReactNode; icon?: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn("slide-in-up w-full", wide ? "max-w-xl" : "max-w-md")}>
      <div className="mb-6 flex items-center justify-center gap-3">
        <Logo className="h-10 w-10" />
        <span className="text-xl font-semibold tracking-tight">Datanique</span>
      </div>
      <div className="dv-panel border-border/80 bg-card p-7">
        <div className="mb-5 flex items-start gap-3">
          {icon && <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">{icon}</div>}
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function PasswordInput({ value, onChange, placeholder, autoFocus, id, onEnter }: {
  value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; id?: string; onEnter?: () => void;
}) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="relative">
      <input id={id} type={show ? "text" : "password"} value={value} autoFocus={autoFocus} placeholder={placeholder}
        autoComplete="off" spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onEnter?.(); }}
        className="dv-input h-11 pr-10 text-[15px]" />
      <button type="button" tabIndex={-1} onClick={() => setShow((s) => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground" aria-label={show ? "Hide" : "Show"}>
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function Meter({ pw }: { pw: string }) {
  const s = strength(pw);
  const color = s < 0.45 ? "bg-destructive" : s < 0.75 ? "bg-changed" : "bg-equal";
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full transition-all", color)} style={{ width: `${Math.round(s * 100)}%` }} />
    </div>
  );
}

function Setup({ status, onDone }: { status: VaultStatus | null; onDone: (r: any) => void }) {
  const [pw, setPw] = React.useState("");
  const [pw2, setPw2] = React.useState("");
  const [remember, setRemember] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const problems = passwordProblems(pw);
  const mismatch = pw2.length > 0 && pw !== pw2;
  const can = !problems.length && pw === pw2 && !busy;
  const submit = async () => {
    if (!can) return;
    setBusy(true);
    try {
      onDone(await vaultApi.setup(pw, remember));
    } catch (e) {
      toast.error("Couldn't create the vault", { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Create your master password" icon={<ShieldCheck className="h-5 w-5" />}
      subtitle="Saved database passwords, compare history, diffs and templates are encrypted with a key that only this password unlocks.">
      <div className="space-y-3">
        <PasswordInput id="dv-new-pw" value={pw} onChange={setPw} placeholder="Master password" autoFocus onEnter={submit} />
        <Meter pw={pw} />
        <div className="text-xs text-muted-foreground">
          {pw ? (problems.length ? `Needs ${problems.join(" and ")}.` : "Looks good.") : "10+ characters, letters with digits or symbols."}
        </div>
        <PasswordInput id="dv-new-pw2" value={pw2} onChange={setPw2} placeholder="Repeat password" onEnter={submit} />
        {mismatch && <div className="text-xs text-destructive">Passwords don't match.</div>}
        <Switch className="pt-2" checked={remember} onChange={setRemember} disabled={!status?.remember_available}
          label="Remember on this computer"
          hint={status?.remember_available
            ? "Opens without the password for your Windows account (key kept in Windows Credential Manager)."
            : "Not available: no OS credential store was found."} />
        <Button className="mt-2 h-11 w-full text-[15px]" onClick={submit} disabled={!can} loading={busy}>
          <Lock className="h-4 w-4" /> Create vault
        </Button>
      </div>
    </Card>
  );
}

function RecoveryShown({ recoveryKey, migration, onContinue }: { recoveryKey: string; migration: any; onContinue: () => void }) {
  const [saved, setSaved] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      toast.success("Recovery key copied");
    } catch {
      toast.error("Copy failed - select and copy it manually");
    }
  };
  const download = () => {
    const blob = new Blob([`Datanique recovery key\n\n${recoveryKey}\n\nCreated ${new Date().toISOString()}\nUse it on the unlock screen ("Forgot password?") to set a new password.\n`], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "datanique-recovery-key.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const lost: string[] = migration?.passwords_lost ?? [];
  return (
    <Card wide title="Save your recovery key" icon={<KeyRound className="h-5 w-5" />}
      subtitle="If you forget the master password, this key is the only way back in. It is shown once.">
      <div className="rounded-xl border border-dashed border-primary/40 bg-primary/5 p-5 text-center">
        <div className="select-all font-mono text-[22px] font-semibold tracking-[0.12em] text-primary" data-testid="recovery-key">{recoveryKey}</div>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="outline" className="flex-1" onClick={copy}><Copy className="h-4 w-4" /> Copy</Button>
        <Button variant="outline" className="flex-1" onClick={download}><Download className="h-4 w-4" /> Save as file</Button>
      </div>
      {migration && !migration.error && (migration.connections > 0 || migration.runs > 0 || migration.templates > 0) && (
        <div className="mt-4 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          <Sparkles className="mr-1 inline h-3.5 w-3.5 text-primary" />
          Encrypted existing data: {migration.connections} saved passwords, {migration.runs} runs, {migration.templates} templates.
          {migration.legacy_key_deleted && " The old key file was deleted."}
        </div>
      )}
      {lost.length > 0 && (
        <div className="mt-3 rounded-lg border border-changed/40 bg-changed/10 p-3 text-xs">
          Re-enter the password for: {lost.join(", ")} (the old key needed to read them was missing).
        </div>
      )}
      <label className="mt-5 flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I saved the recovery key somewhere safe
      </label>
      <Button className="mt-4 h-11 w-full" disabled={!saved} onClick={onContinue}>Open Datanique</Button>
    </Card>
  );
}

function Unlock({ status, onDone, onRecover, onReset }: {
  status: VaultStatus | null; onDone: (t: string, s?: VaultStatus) => void; onRecover: () => void; onReset: () => void;
}) {
  const [pw, setPw] = React.useState("");
  const [remember, setRemember] = React.useState(!!status?.remembered);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await vaultApi.unlock(pw, status?.remember_available ? remember : undefined);
      onDone(r.token, r.status);
    } catch (e) {
      setErr(errorText(e));
      setPw("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Unlock Datanique" icon={<Lock className="h-5 w-5" />} subtitle="Enter your master password to decrypt your connections and history.">
      <div className="space-y-3">
        <PasswordInput id="dv-unlock-pw" value={pw} onChange={setPw} placeholder="Master password" autoFocus onEnter={submit} />
        {err && <div className="text-sm text-destructive">{err}</div>}
        {status?.remember_available && (
          <Switch checked={remember} onChange={setRemember} label="Remember on this computer" hint="Skip this screen next time for your Windows account." />
        )}
        <Button className="h-11 w-full text-[15px]" onClick={submit} disabled={!pw} loading={busy}>
          <LockOpen className="h-4 w-4" /> Unlock
        </Button>
        <div className="flex justify-between pt-1 text-xs">
          <button type="button" className="text-primary hover:underline" onClick={onRecover}>Forgot password?</button>
          <button type="button" className="text-muted-foreground hover:text-destructive" onClick={onReset}>Start over…</button>
        </div>
      </div>
    </Card>
  );
}

function Recover({ onBack, onDone }: { onBack: () => void; onDone: (r: any) => void }) {
  const [key, setKey] = React.useState("");
  const [pw, setPw] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const problems = passwordProblems(pw);
  const submit = async () => {
    setBusy(true);
    try {
      onDone(await vaultApi.recover(key, pw));
    } catch (e) {
      toast.error("Recovery failed", { description: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Recover with your recovery key" icon={<KeyRound className="h-5 w-5" />} subtitle="Enter the 24-character key you saved at setup, then choose a new password.">
      <div className="space-y-3">
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" autoFocus spellCheck={false}
          className="dv-input h-11 font-mono uppercase tracking-wider" />
        <PasswordInput value={pw} onChange={setPw} placeholder="New master password" onEnter={submit} />
        <Meter pw={pw} />
        {pw && problems.length > 0 && <div className="text-xs text-muted-foreground">Needs {problems.join(" and ")}.</div>}
        <Button className="h-11 w-full" disabled={!key || problems.length > 0} loading={busy} onClick={submit}>Set new password</Button>
        <button type="button" className="w-full text-center text-xs text-muted-foreground hover:text-foreground" onClick={onBack}>Back</button>
      </div>
    </Card>
  );
}

function Reset({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <Card title="Start over" icon={<TriangleAlert className="h-5 w-5" />}
      subtitle="Without the password or the recovery key the encrypted data can't be read.">
      <ul className="mb-4 space-y-1.5 text-sm text-muted-foreground">
        <li>• Connections stay, but their saved passwords are deleted.</li>
        <li>• Compare history, diffs and templates are deleted.</li>
        <li>• You'll create a new master password.</li>
      </ul>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type RESET to confirm" className="dv-input h-10 font-mono" />
      <Button variant="destructive" className="mt-3 w-full" disabled={text.trim().toUpperCase() !== "RESET"} loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await vaultApi.reset();
            onDone();
          } catch (e) {
            toast.error("Reset failed", { description: errorText(e) });
          } finally {
            setBusy(false);
          }
        }}>
        Delete encrypted data and start over
      </Button>
      <button type="button" className="mt-3 w-full text-center text-xs text-muted-foreground hover:text-foreground" onClick={onBack}>Back</button>
    </Card>
  );
}

/** "Lock now" from anywhere. */
export async function lockNow(): Promise<void> {
  try {
    await vaultApi.lock();
  } finally {
    setSessionToken(null);
    window.dispatchEvent(new CustomEvent("dv:vault", { detail: "vault_locked" }));
  }
}
