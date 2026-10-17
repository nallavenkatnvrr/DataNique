/**
 * Editor cursor / selection info, kept outside React state so typing and
 * moving the caret only re-render the few widgets that show it (status bar,
 * Run button) instead of the whole IDE.
 */
import * as React from "react";
import type { CursorInfo } from "./CodeEditor";

let info: CursorInfo | null = null;
const listeners = new Set<() => void>();

export function setCursorInfo(next: CursorInfo | null): void {
  if (
    info && next &&
    info.line === next.line && info.col === next.col && info.selectionChars === next.selectionChars &&
    info.selectionLines === next.selectionLines && info.statementIndex === next.statementIndex &&
    info.statementCount === next.statementCount
  ) return;
  info = next;
  listeners.forEach((l) => l());
}

export function getCursorInfo(): CursorInfo | null {
  return info;
}

export function useCursorInfo(): CursorInfo | null {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => info,
  );
}
