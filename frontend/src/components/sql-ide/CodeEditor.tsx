/**
 * SQL editor for the IDE — CodeMirror 6 driven directly (no React wrapper),
 * styled after GitHub's code editor.
 *
 * Why direct: one EditorView lives for the page and each script tab keeps
 * its own EditorState (document, undo history, selection, scroll), swapped in
 * on tab switch. Nothing ever pushes a `value` prop into the editor, so the
 * "stale prop overwrites what I just typed" class of bugs cannot happen.
 *
 * Features: dialect-aware highlighting and completion (tables/columns of the
 * active schema, keywords, SQL templates), statement-aware run markers in the
 * gutter, current-statement highlight, executed-statement flash, error
 * diagnostics, format, case conversion, find/replace, go to line, folding,
 * multi-cursor and rectangular selection.
 */
import * as React from "react";
import { toast } from "sonner";
import {
  Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, type Extension,
} from "@codemirror/state";
import {
  Decoration, type DecorationSet, EditorView, GutterMarker, ViewPlugin, type ViewUpdate, crosshairCursor,
  drawSelection, dropCursor, gutter, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  keymap, lineNumbers, placeholder as cmPlaceholder, rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap, history, historyKeymap, indentLess, indentMore, insertNewlineAndIndent, redo, toggleBlockComment,
  toggleComment, undo,
} from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import {
  acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completeFromList, completionKeymap,
  completionStatus, hasNextSnippetField, hasPrevSnippetField, ifNotIn, moveCompletionSelection, nextSnippetField,
  prevSnippetField, selectedCompletionIndex, snippetCompletion, startCompletion,
  type CompletionContext, type CompletionResult,
} from "@codemirror/autocomplete";
import { lintKeymap, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { sql } from "@codemirror/lang-sql";
import type { DbType } from "@/api/client";
import { cmDialectFor, dtParserNameFor, getDt } from "@/lib/sqlDialect";
import { normalizeDialect, splitSqlStatements, statementAt, type SqlStatement } from "@/lib/sqlSplit";
import { formatSql } from "@/lib/sqlFormat";
import { cn } from "@/lib/utils";
import { githubEditorTheme } from "./editorTheme";
import { IDE_COMMANDS, type IdeCommandId } from "./ideCommands";
import type { IdeSettings } from "./ideSettings";
import { sqlSnippets } from "./sqlSnippets";

export interface CursorInfo {
  line: number;
  col: number;
  offset: number;
  selectionChars: number;
  selectionLines: number;
  statementIndex: number | null;
  statementCount: number;
}

export interface EditorDiagnostic {
  from: number;
  to: number;
  message: string;
  severity?: "error" | "warning" | "info";
}

export interface SqlEditorHandle {
  getText(): string;
  getSelection(): { from: number; to: number; text: string };
  getCursor(): number;
  /** Statements of the current document (same splitter as execution). */
  getStatements(opts?: { blankLines?: boolean }): SqlStatement[];
  /** Statement under the cursor (DBeaver semantics), or null. */
  getCurrentStatement(): SqlStatement | null;
  setSelection(from: number, to?: number, scroll?: boolean): void;
  replaceRange(from: number, to: number, text: string): void;
  insertAtCursor(text: string, opts?: { newLine?: boolean }): void;
  setText(text: string): void;
  focus(): void;
  setDiagnostics(d: EditorDiagnostic[]): void;
  flashRange(from: number, to: number): void;
  format(): Promise<void>;
  command(name: "comment" | "blockComment" | "find" | "replace" | "gotoLine" | "upper" | "lower" | "complete" | "nextStatement" | "prevStatement" | "selectStatement" | "undo" | "redo"): void;
  /** Drop the cached state of a closed tab. */
  forget(tabId: string): void;
}

interface Props {
  tabId: string;
  initialText: string;
  dbType?: DbType;
  tables: string[];
  columns: Record<string, string[]>;
  settings: IdeSettings;
  commands: React.MutableRefObject<Partial<Record<IdeCommandId, () => void>>>;
  onChange: (tabId: string, text: string) => void;
  onCursor?: (info: CursorInfo) => void;
  onRunStatementAt?: (stmt: SqlStatement) => void;
  readOnly?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Statement awareness
// ---------------------------------------------------------------------------

interface SplitConfig {
  dbType?: DbType;
  blankLines: boolean;
  highlight: boolean;
}

const refreshStatements = StateEffect.define<null>();
const stmtLineDeco = Decoration.line({ class: "cm-dv-stmt-line" });

class RunMarker extends GutterMarker {
  constructor(readonly current: boolean) { super(); }
  eq(other: RunMarker) { return other.current === this.current; }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-dv-run-marker" + (this.current ? " cm-dv-current" : "");
    el.textContent = "▶";
    el.title = "Run this statement";
    return el;
  }
}
const runMarker = new RunMarker(false);
const runMarkerCurrent = new RunMarker(true);

function statementPlugin(cfg: React.MutableRefObject<SplitConfig>) {
  return ViewPlugin.fromClass(
    class {
      stmts: SqlStatement[] = [];
      current: SqlStatement | null = null;
      decorations: DecorationSet = Decoration.none;
      constructor(view: EditorView) {
        this.recompute(view, true);
      }
      update(u: ViewUpdate) {
        const forced = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshStatements)));
        if (u.docChanged || u.selectionSet || forced) this.recompute(u.view, u.docChanged || forced);
      }
      recompute(view: EditorView, resplit: boolean) {
        const doc = view.state.doc.toString();
        if (resplit) {
          this.stmts = splitSqlStatements(doc, cfg.current.dbType, { blankLineDelimiter: cfg.current.blankLines });
        }
        const head = view.state.selection.main.head;
        this.current = statementAt(this.stmts, head, doc);
        if (!cfg.current.highlight || !this.current || this.stmts.length < 2) {
          this.decorations = Decoration.none;
          return;
        }
        const ranges = [];
        const first = view.state.doc.lineAt(this.current.from).number;
        const last = view.state.doc.lineAt(this.current.to).number;
        for (let l = first; l <= last && l - first < 5000; l++) {
          ranges.push(stmtLineDeco.range(view.state.doc.line(l).from));
        }
        this.decorations = Decoration.set(ranges);
      }
    },
    { decorations: (p) => p.decorations },
  );
}

// ---------------------------------------------------------------------------
// Executed-statement flash
// ---------------------------------------------------------------------------

const flashEffect = StateEffect.define<{ from: number; to: number } | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        deco = e.value && e.value.to > e.value.from
          ? Decoration.set([Decoration.mark({ class: "cm-dv-executed" }).range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// Case conversion
// ---------------------------------------------------------------------------

function changeCase(view: EditorView, upper: boolean): boolean {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    let { from, to } = range;
    if (from === to) {
      const word = state.wordAt(from);
      if (!word) return { range };
      from = word.from;
      to = word.to;
    }
    const text = state.sliceDoc(from, to);
    const next = upper ? text.toUpperCase() : text.toLowerCase();
    return { changes: { from, to, insert: next }, range: EditorSelection.range(from, from + next.length) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.case" }));
  return true;
}

// ---------------------------------------------------------------------------
// Editor-local commands (shared by the keymap and the imperative handle)
// ---------------------------------------------------------------------------

type StmtPluginValue = { stmts: SqlStatement[]; current: SqlStatement | null };

function editorCommands(
  plugin: (v: EditorView) => StmtPluginValue | null,
): Partial<Record<IdeCommandId, (v: EditorView) => boolean>> {
  const jump = (v: EditorView, dir: 1 | -1): boolean => {
    const p = plugin(v);
    if (!p || !p.stmts.length) return false;
    const head = v.state.selection.main.head;
    const target = dir > 0
      ? p.stmts.find((s) => s.from > head)
      : [...p.stmts].reverse().find((s) => s.from < (p.current?.from ?? head));
    if (!target) return false;
    v.dispatch({ selection: EditorSelection.cursor(target.from), scrollIntoView: true });
    return true;
  };
  return {
    "edit.comment": toggleComment,
    "edit.blockComment": toggleBlockComment,
    "edit.upper": (v) => changeCase(v, true),
    "edit.lower": (v) => changeCase(v, false),
    "edit.find": (v) => openSearchPanel(v),
    "edit.replace": (v) => {
      openSearchPanel(v);
      setTimeout(() => (v.dom.querySelector(".cm-search [name=replace]") as HTMLInputElement | null)?.focus(), 0);
      return true;
    },
    "edit.gotoLine": gotoLine,
    "edit.complete": startCompletion,
    "edit.nextStatement": (v) => jump(v, 1),
    "edit.prevStatement": (v) => jump(v, -1),
    "edit.selectStatement": (v) => {
      const s = plugin(v)?.current;
      if (!s) return false;
      v.dispatch({ selection: EditorSelection.range(s.from, s.to), scrollIntoView: true });
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CodeEditor = React.forwardRef<SqlEditorHandle, Props>(function CodeEditor(props, ref) {
  const {
    tabId, initialText, dbType, tables, columns, settings, commands, onChange, onCursor, onRunStatementAt,
    readOnly = false, className,
  } = props;

  const hostRef = React.useRef<HTMLDivElement>(null);
  const viewRef = React.useRef<EditorView | null>(null);
  const statesRef = React.useRef(new Map<string, EditorState>());
  const activeTabRef = React.useRef(tabId);
  const changeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live props for callbacks created once.
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const onCursorRef = React.useRef(onCursor);
  onCursorRef.current = onCursor;
  const onRunAtRef = React.useRef(onRunStatementAt);
  onRunAtRef.current = onRunStatementAt;
  const tablesRef = React.useRef(tables);
  tablesRef.current = tables;
  const columnsRef = React.useRef(columns);
  columnsRef.current = columns;
  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;
  const splitCfg = React.useRef<SplitConfig>({
    dbType,
    blankLines: settings.blankLineDelimiter,
    highlight: settings.highlightStatement,
  });

  // Compartments are created once so every per-tab state can be reconfigured.
  const comp = React.useMemo(
    () => ({
      lang: new Compartment(),
      wrap: new Compartment(),
      tab: new Compartment(),
      numbers: new Compartment(),
      runGutter: new Compartment(),
      brackets: new Compartment(),
      readOnly: new Compartment(),
    }),
    [],
  );

  const stmtPlugin = React.useMemo(() => statementPlugin(splitCfg), []);

  // ---------- configurable extension builders ----------
  const buildLanguage = React.useCallback((): Extension => {
    const dialect = cmDialectFor(dbType);
    const schema: Record<string, string[]> = {};
    for (const t of tables) schema[t] = columns[t] ?? [];
    const support = sql({
      dialect,
      schema: Object.keys(schema).length ? schema : undefined,
      upperCaseKeywords: settings.uppercaseKeywords,
    });
    const snippetSource = ifNotIn(
      ["String", "QuotedIdentifier", "LineComment", "BlockComment"],
      completeFromList(
        sqlSnippets(normalizeDialect(dbType)).map((s) =>
          snippetCompletion(s.template, { label: s.label, detail: s.detail, type: "text", boost: 1 }),
        ),
      ),
    );
    const exts: Extension[] = [support, support.language.data.of({ autocomplete: snippetSource })];
    const parserName = dtParserNameFor(dbType);
    if (settings.contextCompletion && parserName) {
      const dtSource = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
        const word = ctx.matchBefore(/[\w$]*/);
        if (!word || (word.from === word.to && !ctx.explicit)) return null;
        const bundle = await getDt(parserName);
        if (!bundle) return null;
        const line = ctx.state.doc.lineAt(ctx.pos);
        let res: any;
        try {
          // Only parse the current statement — whole-document parses lag on big scripts.
          const doc = ctx.state.doc.toString();
          const stmts = splitSqlStatements(doc, dbType);
          const cur = statementAt(stmts, ctx.pos, doc);
          const base = cur ? cur.from : 0;
          const text = cur ? doc.slice(cur.from, Math.max(cur.to, ctx.pos)) : doc;
          const baseLine = ctx.state.doc.lineAt(base);
          res = bundle.parser.getSuggestionAtCaretPosition(text, {
            lineNumber: line.number - baseLine.number + 1,
            column: line.number === baseLine.number ? ctx.pos - base + 1 : ctx.pos - line.from + 1,
          });
        } catch {
          return null;
        }
        if (!res) return null;
        const seen = new Set<string>();
        const options: { label: string; type: string; boost?: number }[] = [];
        const push = (label: string, type: string, boost?: number) => {
          const k = `${type}:${label.toLowerCase()}`;
          if (seen.has(k)) return;
          seen.add(k);
          options.push({ label, type, boost });
        };
        const ctxTypes: number[] = (res.syntax ?? []).map((s: any) => s.syntaxContextType);
        if (ctxTypes.some((t) => bundle.tableTypes.includes(t))) for (const t of tablesRef.current) push(t, "type", 2);
        if (ctxTypes.some((t) => bundle.columnTypes.includes(t))) {
          for (const list of Object.values(columnsRef.current)) for (const c of list) push(c, "property", 2);
        }
        for (const kw of (res.keywords ?? []) as string[]) push(kw.toUpperCase(), "keyword", -1);
        return options.length ? { from: word.from, options, validFor: /^[\w$]*$/ } : null;
      };
      exts.push(support.language.data.of({ autocomplete: dtSource }));
    }
    return exts;
  }, [dbType, tables, columns, settings.uppercaseKeywords, settings.contextCompletion]);

  const runGutterExt = React.useCallback((): Extension => {
    if (!settings.statementRunMarkers) return [];
    return gutter({
      class: "cm-dv-stmt-gutter",
      lineMarker(view, line) {
        const p = view.plugin(stmtPlugin);
        if (!p) return null;
        for (const s of p.stmts) {
          if (s.from >= line.from && s.from <= line.to) return p.current === s ? runMarkerCurrent : runMarker;
          if (s.from > line.to) break;
        }
        return null;
      },
      lineMarkerChange: (u) => u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshStatements))),
      initialSpacer: () => runMarker,
      domEventHandlers: {
        mousedown(view, line) {
          const p = view.plugin(stmtPlugin);
          const s = p?.stmts.find((x) => x.from >= line.from && x.from <= line.to);
          if (s) {
            view.dispatch({ selection: EditorSelection.cursor(s.from) });
            onRunAtRef.current?.(s);
            return true;
          }
          return false;
        },
      },
    });
  }, [settings.statementRunMarkers, stmtPlugin]);

  // ---------- keymap (IDE commands first, then editor defaults) ----------
  const localCommands = React.useMemo(() => editorCommands((v) => v.plugin(stmtPlugin)), [stmtPlugin]);

  const ideKeymap = React.useMemo(() => {
    const editorLocal = localCommands;
    const bindings = [] as { key: string; run: (v: EditorView) => boolean; preventDefault?: boolean }[];
    for (const c of IDE_COMMANDS) {
      for (const key of c.keys ?? []) {
        const local = editorLocal[c.id];
        bindings.push({
          key,
          preventDefault: true,
          run: (v) => {
            if (local) return local(v);
            const handler = commands.current[c.id];
            if (!handler) return false;
            handler();
            return true;
          },
        });
      }
    }
    return Prec.highest(
      keymap.of([
        ...bindings,
        // Tab: accept the completion (the top one if none is highlighted),
        // else jump to the next template field, else indent.
        {
          key: "Tab",
          run: (v) => {
            if (completionStatus(v.state) === "active") {
              if (selectedCompletionIndex(v.state) == null || selectedCompletionIndex(v.state)! < 0) moveCompletionSelection(true)(v);
              return acceptCompletion(v);
            }
            if (hasNextSnippetField(v.state)) return nextSnippetField(v);
            return indentMore(v);
          },
        },
        { key: "Shift-Tab", run: (v) => (hasPrevSnippetField(v.state) ? prevSnippetField(v) : indentLess(v)) },
        // Enter only accepts a completion the user picked with the arrow keys;
        // otherwise it's a newline, so typing "FROM t⏎" never swaps in a
        // suggestion (completion opens with nothing selected).
        {
          key: "Enter",
          run: (v) => {
            const sel = completionStatus(v.state) === "active" ? selectedCompletionIndex(v.state) : null;
            if (sel != null && sel >= 0) return acceptCompletion(v);
            return insertNewlineAndIndent(v);
          },
        },
      ]),
    );
  }, [commands, localCommands]);

  const buildExtensions = React.useCallback((): Extension[] => [
    comp.numbers.of(settings.lineNumbers ? lineNumbers() : []),
    comp.runGutter.of(runGutterExt()),
    foldGutter({ openText: "⌄", closedText: "›" }),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    comp.brackets.of(settings.autoCloseBrackets ? closeBrackets() : []),
    autocompletion({ activateOnTyping: true, icons: true, maxRenderedOptions: 80, selectOnOpen: false }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    comp.lang.of(buildLanguage()),
    comp.wrap.of(settings.wordWrap ? EditorView.lineWrapping : []),
    comp.tab.of([EditorState.tabSize.of(settings.tabSize), indentUnit.of(" ".repeat(settings.tabSize))]),
    comp.readOnly.of(EditorState.readOnly.of(readOnly)),
    cmPlaceholder(
      "-- Ctrl+Enter runs the statement under the cursor · Alt+X runs the whole script\n-- Type sel then Tab for a SELECT template · Ctrl+Shift+F formats · Ctrl+Shift+P shows every command",
    ),
    stmtPlugin,
    flashField,
    ideKeymap,
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap.filter((b) => b.key !== "Enter"),
      ...lintKeymap,
    ]),
    githubEditorTheme,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        const id = activeTabRef.current;
        if (changeTimer.current) clearTimeout(changeTimer.current);
        changeTimer.current = setTimeout(() => {
          changeTimer.current = null;
          onChangeRef.current(id, u.view.state.doc.toString());
        }, 120);
      }
      if (u.docChanged || u.selectionSet || u.focusChanged) reportCursor(u.view);
    }),
    EditorView.contentAttributes.of({ "aria-label": "SQL editor", spellcheck: "false" }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  const reportCursor = React.useCallback((view: EditorView) => {
    const cb = onCursorRef.current;
    if (!cb) return;
    const { state } = view;
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.head);
    const p = view.plugin(stmtPlugin);
    const idx = p?.current ? p.stmts.indexOf(p.current) : -1;
    cb({
      line: line.number,
      col: sel.head - line.from + 1,
      offset: sel.head,
      selectionChars: Math.abs(sel.to - sel.from),
      selectionLines: sel.empty ? 0 : state.doc.lineAt(sel.to).number - state.doc.lineAt(sel.from).number + 1,
      statementIndex: idx >= 0 ? idx : null,
      statementCount: p?.stmts.length ?? 0,
    });
  }, [stmtPlugin]);

  const flushChange = React.useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    if (changeTimer.current) {
      clearTimeout(changeTimer.current);
      changeTimer.current = null;
      onChangeRef.current(activeTabRef.current, view.state.doc.toString());
    }
  }, []);

  // ---------- mount ----------
  React.useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({ doc: initialText, extensions: buildExtensions() });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    statesRef.current.set(tabId, state);
    reportCursor(view);
    return () => {
      flushChange();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- reconfigure live (all compartments) ----------
  const reconfigureAll = React.useCallback((view: EditorView) => {
    view.dispatch({
      effects: [
        comp.lang.reconfigure(buildLanguage()),
        comp.wrap.reconfigure(settings.wordWrap ? EditorView.lineWrapping : []),
        comp.tab.reconfigure([EditorState.tabSize.of(settings.tabSize), indentUnit.of(" ".repeat(settings.tabSize))]),
        comp.numbers.reconfigure(settings.lineNumbers ? lineNumbers() : []),
        comp.runGutter.reconfigure(runGutterExt()),
        comp.brackets.reconfigure(settings.autoCloseBrackets ? closeBrackets() : []),
        comp.readOnly.reconfigure(EditorState.readOnly.of(readOnly)),
        refreshStatements.of(null),
      ],
    });
  }, [comp, buildLanguage, runGutterExt, settings.wordWrap, settings.tabSize, settings.lineNumbers, settings.autoCloseBrackets, readOnly]);

  React.useEffect(() => {
    splitCfg.current = { dbType, blankLines: settings.blankLineDelimiter, highlight: settings.highlightStatement };
    const view = viewRef.current;
    if (view) reconfigureAll(view);
  }, [reconfigureAll, dbType, settings.blankLineDelimiter, settings.highlightStatement]);

  // Font changes need a re-measure (CSS variables change line height).
  React.useEffect(() => {
    viewRef.current?.requestMeasure();
  }, [settings.fontSize, settings.fontFamily, settings.lineHeight]);

  // ---------- tab switching: swap per-tab states ----------
  React.useEffect(() => {
    const view = viewRef.current;
    if (!view || activeTabRef.current === tabId) return;
    flushChange();
    statesRef.current.set(activeTabRef.current, view.state);
    activeTabRef.current = tabId;
    let next = statesRef.current.get(tabId);
    if (!next || next.doc.toString() !== initialText) {
      // First visit, or the tab's text was changed outside the editor (e.g.
      // reloaded from the library): start a fresh state for it.
      next = EditorState.create({ doc: initialText, extensions: buildExtensions() });
    }
    view.setState(next);
    reconfigureAll(view);
    reportCursor(view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // ---------- imperative API ----------
  React.useImperativeHandle(ref, (): SqlEditorHandle => ({
    getText: () => viewRef.current?.state.doc.toString() ?? "",
    getSelection: () => {
      const v = viewRef.current;
      if (!v) return { from: 0, to: 0, text: "" };
      const { from, to } = v.state.selection.main;
      return { from, to, text: v.state.sliceDoc(from, to) };
    },
    getCursor: () => viewRef.current?.state.selection.main.head ?? 0,
    getStatements: (opts) => {
      const v = viewRef.current;
      if (!v) return [];
      return splitSqlStatements(v.state.doc.toString(), dbType, {
        blankLineDelimiter: opts?.blankLines ?? settingsRef.current.blankLineDelimiter,
      });
    },
    getCurrentStatement: () => {
      const v = viewRef.current;
      if (!v) return null;
      const doc = v.state.doc.toString();
      const stmts = splitSqlStatements(doc, dbType, { blankLineDelimiter: settingsRef.current.blankLineDelimiter });
      return statementAt(stmts, v.state.selection.main.head, doc);
    },
    setSelection: (from, to, scroll = true) => {
      const v = viewRef.current;
      if (!v) return;
      const max = v.state.doc.length;
      v.dispatch({
        selection: EditorSelection.range(Math.min(from, max), Math.min(to ?? from, max)),
        scrollIntoView: scroll,
      });
      v.focus();
    },
    replaceRange: (from, to, text) => {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch({ changes: { from, to, insert: text }, userEvent: "input.replace" });
    },
    insertAtCursor: (text, opts) => {
      const v = viewRef.current;
      if (!v) return;
      const sel = v.state.selection.main;
      let insert = text;
      if (opts?.newLine) {
        const line = v.state.doc.lineAt(sel.from);
        const before = line.text.slice(0, sel.from - line.from);
        if (before.trim()) insert = "\n" + insert;
      }
      v.dispatch({
        changes: { from: sel.from, to: sel.to, insert },
        selection: EditorSelection.cursor(sel.from + insert.length),
        scrollIntoView: true,
        userEvent: "input.paste",
      });
      v.focus();
    },
    setText: (text) => {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    },
    focus: () => viewRef.current?.focus(),
    setDiagnostics: (d) => {
      const v = viewRef.current;
      if (!v) return;
      const max = v.state.doc.length;
      const diags: Diagnostic[] = d.map((x) => ({
        from: Math.max(0, Math.min(x.from, max)),
        to: Math.max(0, Math.min(Math.max(x.to, x.from), max)),
        message: x.message,
        severity: x.severity ?? "error",
      }));
      v.dispatch(setDiagnostics(v.state, diags));
    },
    flashRange: (from, to) => {
      const v = viewRef.current;
      if (!v) return;
      const max = v.state.doc.length;
      v.dispatch({ effects: flashEffect.of({ from: Math.min(from, max), to: Math.min(to, max) }) });
      setTimeout(() => {
        if (viewRef.current === v) v.dispatch({ effects: flashEffect.of(null) });
      }, 1600);
    },
    format: async () => {
      const v = viewRef.current;
      if (!v || readOnly) return;
      const sel = v.state.selection.main;
      const whole = sel.empty;
      const from = whole ? 0 : sel.from;
      const to = whole ? v.state.doc.length : sel.to;
      const src = v.state.sliceDoc(from, to);
      if (!src.trim()) return;
      try {
        const out = await formatSql(src, normalizeDialect(dbType), {
          tabWidth: settingsRef.current.tabSize,
          keywordCase: settingsRef.current.uppercaseKeywords ? "upper" : "preserve",
        });
        if (viewRef.current !== v || v.state.sliceDoc(from, to) !== src) return; // changed meanwhile
        v.dispatch({
          changes: { from, to, insert: out },
          selection: whole ? EditorSelection.cursor(Math.min(sel.head, out.length)) : EditorSelection.range(from, from + out.length),
          userEvent: "input.format",
          scrollIntoView: true,
        });
      } catch (e: any) {
        toast.error("Could not format this SQL", { description: String(e?.message ?? e).slice(0, 300) });
      }
    },
    command: (name) => {
      const v = viewRef.current;
      if (!v) return;
      v.focus();
      if (name === "undo") {
        undo(v);
        return;
      }
      if (name === "redo") {
        redo(v);
        return;
      }
      const id = ({
        comment: "edit.comment", blockComment: "edit.blockComment", find: "edit.find", replace: "edit.replace",
        gotoLine: "edit.gotoLine", upper: "edit.upper", lower: "edit.lower", complete: "edit.complete",
        nextStatement: "edit.nextStatement", prevStatement: "edit.prevStatement", selectStatement: "edit.selectStatement",
      } as const)[name];
      localCommands[id]?.(v);
    },
    forget: (id) => {
      statesRef.current.delete(id);
    },
  }), [dbType, readOnly, localCommands]);

  const themeClass =
    settings.editorTheme === "github-light" ? "dv-ed-light" : settings.editorTheme === "github-dark" ? "dv-ed-dark" : "";

  return (
    <div
      ref={hostRef}
      className={cn("dv-ed h-full w-full overflow-hidden [&_.cm-editor]:h-full", themeClass, className)}
      style={{
        ["--ed-font" as any]: settings.fontFamily,
        ["--ed-font-size" as any]: `${settings.fontSize}px`,
        ["--ed-line-height" as any]: String(settings.lineHeight),
        backgroundColor: "var(--ed-bg)",
      }}
      onBlur={flushChange}
    />
  );
});

