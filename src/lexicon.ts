/**
 * Deterministic lexical helpers shared by the Jev input filter and code-owned
 * warning templates. No model, no embeddings.
 */
export const HEDGE_LEXICAL =
  /\b(may|might|maybe|perhaps|likely|possibly|probably|appears?|seems?|roughly|approximately|approx|not sure|unsure|i think|i'd need|i would need|need to verify|to verify|can'?t determine|cannot determine|hard to say|not certain|estimate|guess)\b|~|\b(?:cannot|can'?t|could\s?not|couldn'?t|unable to)\s+(?:be\s+)?(?:confirm(?:ed)?|verif(?:y|ied)|determine[d]?)\b/i;

export const RELAYED_VERDICT_LINE = /^\s*(?:\*|⚠️?|\s)*veritaserum\b\s*(?:\([^)]*\))?\s*:/i;
export const DIRECTIVE_ECHO = /show the italicized line above/i;

const PROSE_MIN_CHARS = 40;

function parsesAsJsonPayload(trimmed: string): boolean {
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    const v = JSON.parse(trimmed);
    return typeof v === "object" && v !== null;
  } catch {
    return false;
  }
}

export function isStructuredOutput(finalMessage: string): boolean {
  const trimmed = finalMessage.trim();
  if (!trimmed) return false;
  if (parsesAsJsonPayload(trimmed)) return true;
  const hasFence = /```[\s\S]*?```|~~~[\s\S]*?~~~/.test(trimmed);
  if (!hasFence) return false;
  const withoutFences = trimmed
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ");
  const proseLen = withoutFences.replace(/\s+/g, " ").trim().length;
  return proseLen < PROSE_MIN_CHARS;
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

function stripHex(text: string): string {
  return text.replace(/0x[0-9a-fA-F]+/g, " ");
}

export function numbersIn(text: string): number[] {
  const clean = stripHex(text);
  const out: number[] = [];
  const re = /\$?\s?([\d]{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([kKmMbB])?\s?%?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    if (!m[1]) continue;
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(v)) continue;
    const suf = m[2]?.toLowerCase();
    if (suf && SUFFIX[suf]) v *= SUFFIX[suf];
    out.push(v);
  }
  return out;
}

export function specificNumbersIn(text: string): number[] {
  const clean = stripHex(text);
  const out: number[] = [];
  const re = /(\$)?\s?([\d]{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([kKmMbB]\b)?\s?(%)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    if (!m[2]) continue;
    const raw = m[2].replace(/,/g, "");
    let v = parseFloat(raw);
    if (Number.isNaN(v)) continue;
    const suf = m[3]?.toLowerCase();
    if (suf && SUFFIX[suf]) v *= SUFFIX[suf];
    const specific = Boolean(m[1] || m[4] || suf || raw.includes(".") || raw.replace(/^0+/, "").length >= 3);
    if (specific) out.push(v);
  }
  return out;
}

export function hasSpecificQuantity(text: string): boolean {
  const clean = stripHex(text);
  if (/\$\s?\d/.test(clean)) return true;
  if (/\d\s?%/.test(clean)) return true;
  if (/\d(?:\.\d+)?\s?[kKmMbB]\b/.test(clean)) return true;
  if (/\d+\.\d+/.test(clean)) return true;
  if (/\b\d{3,}\b/.test(clean)) return true;
  return false;
}

function approxEq(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale <= 0.01;
}

export function findNumberSnippet(value: number, haystack: string, snippetRadius = 30): string | null {
  const clean = stripHex(haystack);
  const re = /\$?\s?([\d]{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([kKmMbB])?\s?%?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    if (!m[1]) continue;
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(v)) continue;
    const suf = m[2]?.toLowerCase();
    if (suf && SUFFIX[suf]) v *= SUFFIX[suf];
    if (approxEq(v, value)) {
      const start = Math.max(0, m.index - snippetRadius);
      const end = Math.min(clean.length, m.index + m[0].length + snippetRadius);
      return clean.slice(start, end).replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

export type StateKind = "tests" | "commit" | "push" | "build" | "ci" | "deploy" | "change";

export function stateKindsOf(sentence: string): StateKind[] {
  const kinds: StateKind[] = [];
  if (/\b(all\s+)?(tests?|specs?|checks?|suite)\b[^.]*\b(pass|passing|passed|green|succeed|succeeded|ok)\b/i.test(sentence)) kinds.push("tests");
  if (/\bcommit(ted|s|ting)?\b/i.test(sentence)) kinds.push("commit");
  if (/\bpush(ed|es|ing)?\b/i.test(sentence)) kinds.push("push");
  if (/\b(build|compil|tsc|type\s?check|make)\w*\b[^.]*\b(green|pass|passes|passed|succeed|succeeded|ok|clean|success)\b/i.test(sentence)) kinds.push("build");
  if (/\bci\b[^.]*\b(pass|passing|passed|green|succeed|succeeded|ok)\b/i.test(sentence)) kinds.push("ci");
  if (/\bdeploy(ed|ing|s|ment)?\b/i.test(sentence)) kinds.push("deploy");
  if (
    /\b(implement(?:ed|ing)|fix(?:ed|es|ing)|add(?:ed|ing)|refactor(?:ed|ing)|updat(?:ed|ing)|renam(?:ed|ing)|patch(?:ed|ing)|edit(?:ed|ing)|wrote|rewrote|creat(?:ed|ing))\b/i.test(sentence) ||
    /\b(made|applied)\s+(?:the\s+|a\s+|my\s+)?(change|changes|edit|edits|fix|fixes|patch|modification|modifications)\b/i.test(sentence)
  )
    kinds.push("change");
  return kinds;
}
