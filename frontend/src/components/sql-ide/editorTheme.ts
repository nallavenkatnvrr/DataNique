/**
 * GitHub (Primer) inspired CodeMirror theme driven entirely by CSS custom
 * properties (see `.dv-ed` in index.css). Because colours come from CSS, the
 * editor follows the app's light/dark mode — or a forced GitHub Light / Dark
 * choice — without rebuilding any editor extension.
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const v = (name: string) => `var(--ed-${name})`;

export const githubHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: v("keyword") },
  { tag: [t.typeName, t.className], color: v("type") },
  { tag: [t.standard(t.name), t.function(t.variableName)], color: v("function") },
  { tag: [t.string, t.special(t.string)], color: v("string") },
  { tag: [t.number, t.bool, t.null, t.atom], color: v("number") },
  { tag: [t.lineComment, t.blockComment, t.comment], color: v("comment"), fontStyle: "italic" },
  { tag: [t.operator], color: v("operator") },
  { tag: [t.special(t.name), t.variableName], color: v("variable") },
  { tag: [t.name, t.propertyName], color: v("fg") },
  { tag: [t.punctuation, t.paren, t.brace, t.squareBracket], color: v("punct") },
  { tag: t.invalid, color: v("invalid") },
]);

export const githubTheme = EditorView.theme({
  "&": {
    color: v("fg"),
    backgroundColor: v("bg"),
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--ed-font)",
    fontSize: "var(--ed-font-size)",
    lineHeight: "var(--ed-line-height)",
    fontVariantLigatures: "none",
  },
  ".cm-content": { caretColor: v("cursor"), padding: "6px 0 40vh 4px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: v("cursor"), borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: v("selection") + " !important" },
  ".cm-activeLine": { backgroundColor: v("line-active") },
  ".cm-gutters": {
    backgroundColor: v("bg"),
    color: v("gutter-fg"),
    border: "none",
    paddingRight: "2px",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 12px", minWidth: "32px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: v("gutter-active") },
  ".cm-foldGutter .cm-gutterElement": { color: v("gutter-fg"), cursor: "pointer", padding: "0 1px", opacity: 0.7 },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: v("bracket"),
    outline: `1px solid ${v("bracket-outline")}`,
    borderRadius: "2px",
  },
  ".cm-nonmatchingBracket": { backgroundColor: v("invalid-bg") },
  ".cm-selectionMatch": { backgroundColor: v("selection-match") },
  ".cm-searchMatch": { backgroundColor: v("search"), outline: `1px solid ${v("search-outline")}` },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: v("search-active") },
  ".cm-foldPlaceholder": {
    backgroundColor: v("fold-bg"),
    border: `1px solid ${v("border")}`,
    color: v("gutter-fg"),
    padding: "0 6px",
    borderRadius: "10px",
  },
  ".cm-tooltip": {
    backgroundColor: v("popover"),
    color: v("fg"),
    border: `1px solid ${v("border")}`,
    borderRadius: "8px",
    boxShadow: "0 8px 24px rgba(0,0,0,.18)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--ed-font)",
    fontSize: "12.5px",
    maxHeight: "18em",
    minWidth: "260px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "3px 10px 3px 6px", lineHeight: "1.5" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: v("accent"), color: v("accent-fg") },
  ".cm-completionDetail": { opacity: 0.65, fontStyle: "normal", marginLeft: "1.2em", fontSize: "11px" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "700", color: v("match") },
  ".cm-tooltip-autocomplete ul li[aria-selected] .cm-completionMatchedText": { color: "inherit" },
  ".cm-completionInfo": { padding: "6px 10px", fontSize: "12px", maxWidth: "420px" },
  ".cm-panels": { backgroundColor: v("panel"), color: v("fg"), borderColor: v("border") },
  ".cm-panels-top": { borderBottom: `1px solid ${v("border")}` },
  ".cm-panel.cm-search": {
    padding: "6px 10px",
    fontFamily: "inherit",
    fontSize: "12px",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "4px 6px",
  },
  ".cm-panel.cm-search input, .cm-panel.cm-gotoLine input": {
    background: v("bg"),
    color: v("fg"),
    border: `1px solid ${v("border")}`,
    borderRadius: "6px",
    padding: "3px 8px",
    fontSize: "12px",
    outline: "none",
  },
  ".cm-panel.cm-search input:focus, .cm-panel.cm-gotoLine input:focus": { borderColor: v("cursor") },
  ".cm-panel.cm-search button, .cm-panel.cm-gotoLine button": {
    background: v("button"),
    color: v("fg"),
    border: `1px solid ${v("border")}`,
    borderRadius: "6px",
    padding: "2px 9px",
    fontSize: "12px",
    backgroundImage: "none",
    cursor: "pointer",
  },
  ".cm-panel.cm-search button:hover": { background: v("button-hover") },
  ".cm-panel.cm-search label": { fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "3px" },
  ".cm-panel.cm-search [name=close]": {
    background: "transparent",
    border: "none",
    color: v("gutter-fg"),
    fontSize: "16px",
    padding: "0 4px",
  },
  ".cm-panel.cm-gotoLine": { padding: "6px 10px", fontSize: "12px" },
  // Statement-aware decorations (see SqlEditor statement extension)
  ".cm-dv-stmt-line": { backgroundColor: v("stmt-bg") },
  ".cm-dv-stmt-gutter .cm-gutterElement": { padding: "0 0 0 4px", minWidth: "16px" },
  ".cm-dv-run-marker": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    height: "100%",
    color: v("run"),
    cursor: "pointer",
    opacity: 0.35,
    fontSize: "10px",
  },
  ".cm-dv-run-marker:hover": { opacity: 1 },
  ".cm-dv-run-marker.cm-dv-current": { opacity: 0.9 },
  ".cm-dv-stmt-bar": {
    position: "absolute",
    left: "1px",
    top: 0,
    bottom: 0,
    width: "2px",
    backgroundColor: v("stmt-bar"),
    borderRadius: "1px",
  },
  ".cm-dv-executed": { backgroundColor: v("executed"), transition: "background-color 1.5s ease" },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: `wavy underline ${v("error")}`,
    textUnderlineOffset: "3px",
  },
  ".cm-diagnostic-error": { borderLeftColor: v("error") },
  ".cm-tooltip-lint": { fontFamily: "var(--ed-font)", fontSize: "12px", maxWidth: "640px" },
  ".cm-lint-marker-error": { content: "none" },
  ".cm-placeholder": { color: v("comment"), fontStyle: "italic" },
  ".cm-snippetField": { backgroundColor: v("snippet") },
  ".cm-snippetFieldPosition": { borderLeft: `1.5px solid ${v("cursor")}` },
});

export const githubEditorTheme = [githubTheme, syntaxHighlighting(githubHighlight)];
