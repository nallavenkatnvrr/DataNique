/**
 * Plain-text fallback editor (Editor Settings → Engine → Plain). A native
 * textarea with a line-number gutter, the same keyboard commands and the same
 * imperative handle as the CodeMirror editor, for machines where the rich
 * editor misbehaves (very old WebViews, screen readers that prefer a textarea).
 */
import * as React from "react";
import { toast } from "sonner";
import type { DbType } from "@/api/client";
import { normalizeDialect, splitSqlStatements, statementAt } from "@/lib/sqlSplit";
import { formatSql } from "@/lib/sqlFormat";
import { cn } from "@/lib/utils";
import { commandForEvent, type IdeCommandId } from "./ideCommands";
import type { IdeSettings } from "./ideSettings";
import type { CursorInfo, EditorDiagnostic, SqlEditorHandle } from "./CodeEditor";

interface Props {
  tabId: string;
  initialText: string;
  dbType?: DbType;
  settings: IdeSettings;
  commands: React.MutableRefObject<Partial<Record<IdeCommandId, () => void>>>;
  onChange: (tabId: string, text: string) => void;
  onCursor?: (info: CursorInfo) => void;
  className?: string;
}

export const PlainEditor = React.forwardRef<SqlEditorHandle, Props>(function PlainEditor(
  { tabId, initialText, dbType, settings, commands, onChange, onCursor, className },
  ref,
) {
  const taRef = React.useRef<HTMLTextAreaElement>(null);
  const gutterRef = React.useRef<HTMLDivElement>(null);
  const [text, setText] = React.useState(initialText);
  const [diag, setDiag] = React.useState<EditorDiagnostic | null>(null);
  const textRef = React.useRef(text);
  textRef.current = text;

  const lineCount = React.useMemo(() => text.split("\n").length, [text]);

  const emit = React.useCallback(
    (next: string) => {
      setText(next);
      onChange(tabId, next);
    },
    [onChange, tabId],
  );

  const report = React.useCallback(() => {
    const ta = taRef.current;
    if (!ta || !onCursor) return;
    const v = ta.value;
    const head = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
    const before = v.slice(0, head);
    const line = before.split("\n").length;
    const col = head - before.lastIndexOf("\n");
    const stmts = splitSqlStatements(v, dbType, { blankLineDelimiter: settings.blankLineDelimiter });
    const cur = statementAt(stmts, head, v);
    const sel = v.slice(ta.selectionStart, ta.selectionEnd);
    onCursor({
      line,
      col,
      offset: head,
      selectionChars: sel.length,
      selectionLines: sel ? sel.split("\n").length : 0,
      statementIndex: cur ? stmts.indexOf(cur) : null,
      statementCount: stmts.length,
    });
  }, [dbType, onCursor, settings.blankLineDelimiter]);

  React.useEffect(() => {
    report();
  }, [report]);

  // Replace a range, keeping native undo where the browser supports it.
  const replace = React.useCallback(
    (from: number, to: number, insert: string, selectAfter?: [number, number]) => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(from, to);
      const ok = typeof document.execCommand === "function" && document.execCommand("insertText", false, insert);
      if (!ok) {
        const v = ta.value;
        ta.value = v.slice(0, from) + insert + v.slice(to);
      }
      if (selectAfter) ta.setSelectionRange(selectAfter[0], selectAfter[1]);
      emit(ta.value);
      report();
    },
    [emit, report],
  );

  const toggleComment = React.useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const v = ta.value;
    const start = v.lastIndexOf("\n", ta.selectionStart - 1) + 1;
    let end = v.indexOf("\n", ta.selectionEnd);
    if (end < 0) end = v.length;
    const lines = v.slice(start, end).split("\n");
    const allCommented = lines.filter((l) => l.trim()).every((l) => /^\s*--/.test(l));
    const out = lines
      .map((l) => (allCommented ? l.replace(/^(\s*)-- ?/, "$1") : l.trim() ? `-- ${l}` : l))
      .join("\n");
    replace(start, end, out, [start, start + out.length]);
  }, [replace]);

  const changeCase = React.useCallback(
    (upper: boolean) => {
      const ta = taRef.current;
      if (!ta || ta.selectionStart === ta.selectionEnd) return;
      const s = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      const from = ta.selectionStart;
      const out = upper ? s.toUpperCase() : s.toLowerCase();
      replace(from, ta.selectionEnd, out, [from, from + out.length]);
    },
    [replace],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const cmd = commandForEvent(e.nativeEvent);
    if (cmd) {
      const local: Partial<Record<IdeCommandId, () => void>> = {
        "edit.comment": toggleComment,
        "edit.upper": () => changeCase(true),
        "edit.lower": () => changeCase(false),
      };
      const fn = local[cmd.id] ?? commands.current[cmd.id];
      if (fn) {
        e.preventDefault();
        e.stopPropagation();
        fn();
        return;
      }
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const unit = " ".repeat(settings.tabSize);
      const { selectionStart: s, selectionEnd: en, value: v } = ta;
      if (s === en && !e.shiftKey) {
        replace(s, en, unit, [s + unit.length, s + unit.length]);
        return;
      }
      const start = v.lastIndexOf("\n", s - 1) + 1;
      const block = v.slice(start, en);
      const out = e.shiftKey
        ? block.split("\n").map((l) => l.replace(new RegExp(`^ {1,${settings.tabSize}}`), "")).join("\n")
        : block.split("\n").map((l) => unit + l).join("\n");
      replace(start, en, out, [start, start + out.length]);
      return;
    }
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value: v } = ta;
      const lineStart = v.lastIndexOf("\n", s - 1) + 1;
      const indent = /^[ \t]*/.exec(v.slice(lineStart, s))?.[0] ?? "";
      const ins = "\n" + indent;
      replace(s, en, ins, [s + ins.length, s + ins.length]);
    }
  };

  React.useImperativeHandle(
    ref,
    (): SqlEditorHandle => ({
      getText: () => textRef.current,
      getSelection: () => {
        const ta = taRef.current;
        if (!ta) return { from: 0, to: 0, text: "" };
        return { from: ta.selectionStart, to: ta.selectionEnd, text: ta.value.slice(ta.selectionStart, ta.selectionEnd) };
      },
      getCursor: () => taRef.current?.selectionEnd ?? 0,
      getStatements: (opts) =>
        splitSqlStatements(textRef.current, dbType, { blankLineDelimiter: opts?.blankLines ?? settings.blankLineDelimiter }),
      getCurrentStatement: () => {
        const v = textRef.current;
        const stmts = splitSqlStatements(v, dbType, { blankLineDelimiter: settings.blankLineDelimiter });
        return statementAt(stmts, taRef.current?.selectionEnd ?? 0, v);
      },
      setSelection: (from, to) => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(from, to ?? from);
        const line = ta.value.slice(0, from).split("\n").length;
        const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
        ta.scrollTop = Math.max(0, (line - 4) * lh);
        report();
      },
      replaceRange: (from, to, t) => replace(from, to, t),
      insertAtCursor: (t, opts) => {
        const ta = taRef.current;
        if (!ta) return;
        const s = ta.selectionStart;
        const v = ta.value;
        const lineStart = v.lastIndexOf("\n", s - 1) + 1;
        const ins = opts?.newLine && v.slice(lineStart, s).trim() ? "\n" + t : t;
        replace(s, ta.selectionEnd, ins, [s + ins.length, s + ins.length]);
      },
      setText: (t) => {
        const ta = taRef.current;
        if (ta) replace(0, ta.value.length, t);
      },
      focus: () => taRef.current?.focus(),
      setDiagnostics: (d) => setDiag(d[0] ?? null),
      flashRange: (from, to) => {
        const ta = taRef.current;
        if (!ta) return;
        ta.setSelectionRange(from, to);
        setTimeout(() => {
          if (taRef.current === ta && ta.selectionStart === from && ta.selectionEnd === to) ta.setSelectionRange(to, to);
        }, 700);
      },
      format: async () => {
        const ta = taRef.current;
        if (!ta) return;
        const whole = ta.selectionStart === ta.selectionEnd;
        const from = whole ? 0 : ta.selectionStart;
        const to = whole ? ta.value.length : ta.selectionEnd;
        const src = ta.value.slice(from, to);
        if (!src.trim()) return;
        try {
          const out = await formatSql(src, normalizeDialect(dbType), {
            tabWidth: settings.tabSize,
            keywordCase: settings.uppercaseKeywords ? "upper" : "preserve",
          });
          replace(from, to, out);
        } catch (e: any) {
          toast.error("Could not format this SQL", { description: String(e?.message ?? e).slice(0, 300) });
        }
      },
      command: (name) => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        if (name === "comment" || name === "blockComment") toggleComment();
        else if (name === "upper") changeCase(true);
        else if (name === "lower") changeCase(false);
        else if (name === "undo") document.execCommand?.("undo");
        else if (name === "redo") document.execCommand?.("redo");
        else if (name === "find" || name === "replace") toast.info("Use the browser's find (Ctrl+F) in Plain mode");
        else if (name === "gotoLine") {
          const n = Number(window.prompt("Go to line", "1"));
          if (n > 0) {
            const lines = ta.value.split("\n");
            let off = 0;
            for (let i = 0; i < Math.min(n - 1, lines.length - 1); i++) off += lines[i].length + 1;
            ta.setSelectionRange(off, off);
          }
        } else if (name === "selectStatement" || name === "nextStatement" || name === "prevStatement") {
          const v = ta.value;
          const stmts = splitSqlStatements(v, dbType, { blankLineDelimiter: settings.blankLineDelimiter });
          const head = ta.selectionEnd;
          const cur = statementAt(stmts, head, v);
          const target =
            name === "selectStatement" ? cur
            : name === "nextStatement" ? stmts.find((s) => s.from > head)
            : [...stmts].reverse().find((s) => s.from < (cur?.from ?? head));
          if (target) ta.setSelectionRange(name === "selectStatement" ? target.from : target.from, name === "selectStatement" ? target.to : target.from);
        }
        report();
      },
      forget: () => {},
    }),
    [changeCase, dbType, replace, report, settings.blankLineDelimiter, settings.tabSize, settings.uppercaseKeywords, toggleComment],
  );

  const themeClass =
    settings.editorTheme === "github-light" ? "dv-ed-light" : settings.editorTheme === "github-dark" ? "dv-ed-dark" : "";
  const fontStyle: React.CSSProperties = {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    tabSize: settings.tabSize,
  };

  return (
    <div className={cn("dv-ed dv-plain-editor relative flex h-full w-full overflow-hidden", themeClass, className)}>
      {settings.lineNumbers && (
        <div
          ref={gutterRef}
          aria-hidden
          className="select-none overflow-hidden py-1.5 pl-3 pr-2 text-right"
          style={{ ...fontStyle, color: "var(--ed-gutter-fg)", minWidth: 44 }}
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={text}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap={settings.wordWrap ? "soft" : "off"}
        aria-label="SQL editor"
        placeholder="-- Ctrl+Enter runs the statement under the cursor · Alt+X runs the whole script"
        className="h-full flex-1 resize-none bg-transparent py-1.5 pr-3 outline-none"
        style={{ ...fontStyle, color: "var(--ed-fg)" }}
        onChange={(e) => {
          emit(e.target.value);
          setDiag(null);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={report}
        onClick={report}
        onSelect={report}
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
      {diag && (
        <div className="absolute bottom-2 right-3 max-w-[60%] rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {diag.message.split("\n")[0]}
        </div>
      )}
    </div>
  );
});
