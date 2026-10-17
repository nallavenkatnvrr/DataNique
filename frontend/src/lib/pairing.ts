/** Client-side mirror of the engine's column pairing (for the mapping UI). */
import type { ColumnPair } from "@/api/engine";

export const DEFAULT_EXCLUDED = new Set([
  "INFA_LAST_REPLICATED", "INFA_OPERATION_SEQUENCE", "INFA_TRANSACTION_ID",
  "INFA_OPERATION_OWNER", "INFA_OPERATION_TIME", "INFA_OPERATION_TYPE",
  "SOURCE_UPDATE_TMSTP", "SOURCE_INSERT_TMSTP", "SOURCE_SYSTEM_CODE",
  "UPDATE_TMSTP", "INSERT_TMSTP",
]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function match(name: string, candidates: string[]): string | null {
  if (candidates.includes(name)) return name;
  const low = candidates.filter((c) => c.toLowerCase() === name.toLowerCase());
  if (low.length === 1) return low[0];
  const alt = candidates.filter((c) => norm(c) === norm(name));
  return alt.length === 1 ? alt[0] : null;
}

export interface AutoPairs {
  pairs: ColumnPair[];
  onlySource: string[];
  onlyTarget: string[];
}

export function autoPair(src: string[], tgt: string[], byPosition = false): AutoPairs {
  const pairs: ColumnPair[] = [];
  const usedT = new Set<string>();
  const usedS = new Set<string>();
  if (byPosition) {
    src.forEach((s, i) => {
      if (i < tgt.length) {
        pairs.push({ source: s, target: tgt[i], role: DEFAULT_EXCLUDED.has(s.toUpperCase()) ? "ignore" : "compare" });
        usedS.add(s);
        usedT.add(tgt[i]);
      }
    });
  } else {
    const remaining = [...tgt];
    for (const s of src) {
      const t = match(s, remaining);
      if (!t) continue;
      remaining.splice(remaining.indexOf(t), 1);
      usedS.add(s);
      usedT.add(t);
      pairs.push({ source: s, target: t, role: DEFAULT_EXCLUDED.has(s.toUpperCase()) || DEFAULT_EXCLUDED.has(t.toUpperCase()) ? "ignore" : "compare" });
    }
  }
  return { pairs, onlySource: src.filter((s) => !usedS.has(s)), onlyTarget: tgt.filter((t) => !usedT.has(t)) };
}
