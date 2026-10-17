/**
 * Tailwind 3 gives every element and pseudo-element ~35 `--tw-*` variables
 * (`*, ::before, ::after { --tw-translate-x: 0; ... }`). Applying them on
 * every style recalculation doubles its cost, which made scrolling large
 * grids lag on slow or GPU-less PCs. The same defaults are declared once
 * with `@property` (non-inherited, like Tailwind's per-element reset) - the
 * approach Tailwind 4 uses - and the per-element rules are removed.
 */
const SELECTORS = new Set(["*, ::before, ::after", "*,::before,::after", "::backdrop"]);

export default function twProperties() {
  return {
    postcssPlugin: "tw-properties",
    OnceExit(root, { AtRule }) {
      const vars = new Map();
      root.walkRules((rule) => {
        const sel = rule.selector.replace(/\s+/g, " ").trim();
        if (!SELECTORS.has(sel) && !SELECTORS.has(rule.selector.replace(/\s+/g, ""))) return;
        const decls = rule.nodes.filter((n) => n.type === "decl");
        if (!decls.length || !decls.every((d) => d.prop.startsWith("--tw-"))) return;
        for (const d of decls) if (!vars.has(d.prop)) vars.set(d.prop, d.value.trim());
        rule.remove();
      });
      for (const [prop, value] of vars) {
        root.prepend(new AtRule({ name: "property", params: prop, nodes: [] })
          .append({ prop: "syntax", value: '"*"' })
          .append({ prop: "inherits", value: "false" })
          .append({ prop: "initial-value", value: value === "" ? " " : value }));
      }
    },
  };
}
twProperties.postcss = true;
