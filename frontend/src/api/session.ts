/**
 * Session token issued when the vault is unlocked. Kept in sessionStorage so
 * a reload keeps the session but a new window has to unlock (or resume when
 * "remember on this computer" is on). Never put it in a URL.
 */
const KEY = "dv-session";
let memory: string | null = null;

export function getSessionToken(): string | null {
  try {
    return sessionStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function setSessionToken(token: string | null): void {
  memory = token;
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: memory only */
  }
}

export type VaultSignal = "vault_locked" | "vault_setup" | "session_required";

/** Tell the vault gate that the server refused us (locked / expired). */
export function signalVault(code: VaultSignal): void {
  window.dispatchEvent(new CustomEvent<VaultSignal>("dv:vault", { detail: code }));
}
