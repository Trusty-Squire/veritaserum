/**
 * Deterministic Jev input diet.
 *
 * This module invokes no model or embedding. It finds verbatim spans in the
 * final message using the grounding tier's existing guards/state/quantity
 * lexicons, then retains only receipt blocks relevant to those spans. Unknown
 * prose fails closed for cost: if no span survives, the caller does not invoke
 * Jev.
 */
import {
  DIRECTIVE_ECHO,
  HEDGE_LEXICAL,
  RELAYED_VERDICT_LINE,
  hasSpecificQuantity,
  isStructuredOutput,
  numbersIn,
  specificNumbersIn,
  stateKindsOf,
} from "./grounding.js";

export type LoadBearingReason = "state" | "work" | "test" | "quantity" | "causal" | "blocker";

export interface ClaimSpan {
  start: number;
  end: number;
  text: string;
  reasons: LoadBearingReason[];
}

export interface JevEvidenceSelection {
  text: string;
  bytes: number;
  retainedLines: number;
  elidedLines: number;
}

export const JEV_EVIDENCE_BUDGET_BYTES = 12 * 1024;
export const JEV_COMPRESSED_REQUEST_BUDGET_BYTES = 512;
export const JEV_COMPRESSED_CLAIM_BUDGET_BYTES = 1_200;
export const JEV_COMPRESSED_EVIDENCE_BUDGET_BYTES = 2 * 1024;

const PREDICTION = /\b(will|shall|going to|plan(?:s|ned)? to|expect(?:s|ed)? to|should|would|next i(?:'ll| will)|next we(?:'ll| will))\b/i;
const ADDITIONAL_HEDGE = /\b(apparently|presumably|plausibly|unclear|unknown|i believe|we believe|suggests?|points? to|suspect)\b/i;
const FICTION =
  /\b(fiction(?:al)?|imaginary|roleplay|storytelling|once upon a time|in (?:this|the) story|hypothetical(?:ly)?|suppose|imagine|for example|e\.g\.)\b/i;
const CAUSAL =
  /\b(root cause|caused?|because of|due to|stems? from|responsible for|the reason (?:is|was)|explains? (?:the|why)|is why|bottleneck (?:is|was))\b/i;
const BLOCKER =
  /\b(can'?t|cannot|can\s?not|impossible|no way|blocked|lock(?:ed|s)?|denied|refus(?:e|es|ed|ing)|frozen|not permitted|unsupported|unavailable|only via|app-?only|out of (?:money|funds)|no endpoint|not allowed|forbidden|prohibited)\b/i;
const COMPLETED_WORK =
  /\b(implement(?:ed|ing)|fix(?:ed|es|ing)|correct(?:ed|ing)|resolv(?:ed|ing)|add(?:ed|ing)|remov(?:ed|ing)|refactor(?:ed|ing)|updat(?:ed|ing)|renam(?:ed|ing)|patch(?:ed|ing)|edit(?:ed|ing)|wrote|rewrote|creat(?:ed|ing)|delet(?:ed|ing)|label(?:ed|ing)|port(?:ed|ing)|applied|made|shipped|landed|merged|installed|configured)\b/i;
const SETTLED_STATE =
  /\b(?:is|are|was|were|remains?|became|has been|have been)\b[^.!?;]{0,90}\b(done|complete|completed|finished|fixed|resolved|corrected|clean|green|passing|passed|failed|failures?|broken|blocked|enabled|disabled|installed|configured|running|stopped|available|unavailable|missing|present|absent|live|charged|unchanged|stuck|intact|in flight)\b|\b(?:exists?|succeeded|failed|works?|working)\b/i;
const TEST_RESULT = /\b(?:tests?|specs?|checks?|suite|vitest|jest|pytest)\b[^.!?;]{0,80}\b(?:pass(?:ed|ing|es)?|fail(?:ed|ing|s)?|green|succeed(?:ed|s)?|ok)\b/i;
const GENERIC_STATE =
  /\b(?:is|are|was|were|isn'?t|aren'?t|wasn'?t|weren'?t|has|have|do|does|did|doesn'?t|contains?|includes?|supports?|requires?|returns?|reports?|shows?|uses?|runs?|provides?|operates?|matches?|means?|fails?|offers?|serializes?|checks?|survives?|collapses?|holds?|implements?|preserves?|adds?|applies?|batches?|respects?|avoids?|targets?|composes?|gets?|carries?|closes?|gives?|reads?|calls?|lands?|advertises?|covers?|recommends?|recommended|needs?|receives?|generates?|produces?|ships?|charges?|remains?|happens?|drops?|costs?|sends?|produced|observed|measured|found|flagged|recorded|verified)\b/i;
const JUDGMENT =
  /\b(?:better|worse|best|worst|beautiful|ugly|impressive|valuable|worthwhile|appropriate|preferable|good|bad|healthy|elegant|excellent|amazing|crazy)\b/i;
const PURE_RECOMMENDATION = /^\s*(?:i|we)\s+(?:recommend|prefer|would choose)\b/i;
const ABSTENTION = /\b(?:remains?|is|are) unverified\b|\b(?:i|we)\s+(?:have not|haven't|did not|didn't)\s+(?:verify|confirm|measure|test)\b/i;
const SCOPE_ASSERTION = /\b(?:all|every|everything|everyone|most|none|nothing|only|never)\b/i;
const SHORT_STATUS = /^(?:clean|done|complete|completed|fixed|resolved|unchanged|live|green|blocked|stuck)\b/i;
const UNIT_QUANTITY = /\b\d+(?:\.\d+)?\s?(?:px|ms|s|sec(?:ond)?s?|minutes?|hours?|bytes?|kb|mb|gb|tokens?|requests?|ops)\b/i;

function fullyQuoted(text: string): boolean {
  const t = text.trim().replace(/^[*_~]+|[*_~]+$/g, "").trim();
  return /^(?:["“‘']).*(?:["”’'])$/.test(t);
}

interface RawSpan {
  start: number;
  end: number;
  text: string;
}

/** Split on line boundaries and sentence terminators while retaining offsets. */
function sentenceSpans(source: string): RawSpan[] {
  const spans: RawSpan[] = [];
  let lineStart = 0;
  let inFence = false;
  for (const lineWithBreak of source.match(/.*(?:\r?\n|$)/g) ?? []) {
    if (!lineWithBreak) continue;
    const line = lineWithBreak.replace(/\r?\n$/, "");
    const trimmed = line.trim();
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      lineStart += lineWithBreak.length;
      continue;
    }
    if (inFence || !trimmed || /^\s*>/.test(line) || RELAYED_VERDICT_LINE.test(line) || DIRECTIVE_ECHO.test(line)) {
      lineStart += lineWithBreak.length;
      continue;
    }

    let contentStart = line.search(/\S/);
    const marker = line.slice(contentStart).match(/^(?:[-*•]|\d+[.)])\s+/);
    if (marker) contentStart += marker[0].length;
    let partStart = contentStart;
    for (let i = contentStart; i < line.length; i++) {
      const ch = line[i]!;
      if (ch !== "." && ch !== "!" && ch !== "?" && ch !== ";") continue;
      if (ch === "." && /\d/.test(line[i - 1] ?? "") && /\d/.test(line[i + 1] ?? "")) continue;
      if (i + 1 < line.length && !/\s/.test(line[i + 1]!)) continue;
      const start = partStart + (line.slice(partStart, i + 1).match(/^\s*/)?.[0].length ?? 0);
      const end = i + 1;
      if (end > start) spans.push({ start: lineStart + start, end: lineStart + end, text: source.slice(lineStart + start, lineStart + end) });
      partStart = i + 1;
    }
    const tailStart = partStart + (line.slice(partStart).match(/^\s*/)?.[0].length ?? 0);
    const tailEnd = line.length - (line.match(/\s*$/)?.[0].length ?? 0);
    if (tailEnd > tailStart) {
      spans.push({ start: lineStart + tailStart, end: lineStart + tailEnd, text: source.slice(lineStart + tailStart, lineStart + tailEnd) });
    }
    lineStart += lineWithBreak.length;
  }
  return spans;
}

function reasonsFor(text: string): LoadBearingReason[] {
  const plain = text.replace(/[*_~`]/g, "").trim();
  if (plain.length < 6 || isStructuredOutput(plain) || fullyQuoted(plain)) return [];
  if (/\?\s*["')\]}]*$/.test(plain)) return [];
  if (HEDGE_LEXICAL.test(plain) || ADDITIONAL_HEDGE.test(plain) || FICTION.test(plain) || PURE_RECOMMENDATION.test(plain) || ABSTENTION.test(plain)) return [];

  const kinds = stateKindsOf(plain);
  const completed = COMPLETED_WORK.test(plain) || kinds.length > 0;
  if (PREDICTION.test(plain) && !completed) return [];

  const reasons = new Set<LoadBearingReason>();
  if (kinds.some((kind) => kind === "tests" || kind === "build" || kind === "ci") || TEST_RESULT.test(plain)) reasons.add("test");
  if (kinds.some((kind) => kind === "change" || kind === "commit" || kind === "push" || kind === "deploy") || COMPLETED_WORK.test(plain)) reasons.add("work");
  if (kinds.length > 0 || SETTLED_STATE.test(plain)) reasons.add("state");
  if (hasSpecificQuantity(plain) || UNIT_QUANTITY.test(plain)) reasons.add("quantity");
  if (CAUSAL.test(plain) || /^because\b/i.test(plain)) reasons.add("causal");
  if (BLOCKER.test(plain)) reasons.add("blocker");
  // The captain's "present state" class is broader than the seven repo-state
  // signatures. Keep plain declarative state reports, but not pure taste calls.
  if (GENERIC_STATE.test(plain) && !(JUDGMENT.test(plain) && reasons.size === 0)) reasons.add("state");
  if (SCOPE_ASSERTION.test(plain)) reasons.add("state");
  if (SHORT_STATUS.test(plain)) reasons.add("state");
  return [...reasons];
}

/** Find the exact final-message spans Jev may judge. Pure, synchronous, no model. */
export function detectLoadBearingClaims(finalMessage: string): ClaimSpan[] {
  if (!finalMessage.trim() || isStructuredOutput(finalMessage)) return [];
  const out: ClaimSpan[] = [];
  for (const span of sentenceSpans(finalMessage)) {
    const reasons = reasonsFor(span.text);
    if (reasons.length > 0) out.push({ ...span, reasons });
  }
  return out;
}

export function renderClaimSpans(spans: ClaimSpan[]): string {
  return spans.map((span) => span.text).join("\n");
}

function clipUtf8(value: string, budgetBytes: number): string {
  if (budgetBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= budgetBytes) return value;
  const suffix = "…";
  if (budgetBytes < Buffer.byteLength(suffix, "utf8")) return "";
  const room = Math.max(0, budgetBytes - Buffer.byteLength(suffix, "utf8"));
  let clipped = Buffer.from(value, "utf8").subarray(0, room).toString("utf8").replace(/\uFFFD$/u, "").trimEnd();
  while (clipped && Buffer.byteLength(`${clipped}${suffix}`, "utf8") > budgetBytes) clipped = clipped.slice(0, -1);
  return `${clipped}${suffix}`;
}

const REQUEST_ACTION =
  /\b(add|build|change|check|create|delete|diagnose|document|fix|implement|investigate|measure|move|remove|rename|replace|review|run|ship|test|trim|update|verify|write)\b/i;
const REQUEST_SCOPE = /\b(all|both|each|every|everything|except|including|must|never|no|not|only|under|without)\b/i;

function requestUnits(source: string): string[] {
  return source
    .replace(/\r/g, "")
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((unit) => unit.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ""))
    .filter(Boolean);
}

/** Deterministically preserve the request's requested work and scope guards. */
export function compressUserRequest(
  request: string,
  budgetBytes: number = JEV_COMPRESSED_REQUEST_BUDGET_BYTES,
): string {
  const trimmed = request.trim();
  if (!trimmed || budgetBytes <= 0) return "";
  if (Buffer.byteLength(trimmed, "utf8") <= budgetBytes) return trimmed;
  const units = requestUnits(trimmed);
  const ranked = units.map((text, index) => {
    let score = index === 0 ? 2 : 0;
    if (REQUEST_ACTION.test(text)) score += 8;
    if (REQUEST_SCOPE.test(text)) score += 7;
    if (/\b(?:test|suite|build|commit|push|deploy|scope|request|asked)\b/i.test(text)) score += 5;
    if (/`[^`]+`|(?:[A-Za-z0-9_.-]+[/\\])+[A-Za-z0-9_.@-]+|\b\w+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|rb|yaml|yml)\b/i.test(text)) score += 4;
    if (/\d/.test(text)) score += 2;
    return { text, index, score };
  });
  const chosen: typeof ranked = [];
  let used = 0;
  for (const unit of [...ranked].sort((a, b) => b.score - a.score || a.index - b.index)) {
    const extra = Buffer.byteLength(unit.text, "utf8") + (chosen.length ? 1 : 0);
    if (chosen.length === 0 && extra > budgetBytes) return clipUtf8(unit.text, budgetBytes);
    if (extra <= budgetBytes - used) {
      chosen.push(unit);
      used += extra;
    }
  }
  if (chosen.length === 0) return clipUtf8(ranked[0]?.text ?? trimmed, budgetBytes);
  return chosen.sort((a, b) => a.index - b.index).map((unit) => unit.text).join("\n");
}

function claimStrength(span: ClaimSpan): number {
  const weights: Record<LoadBearingReason, number> = {
    test: 60,
    work: 50,
    causal: 45,
    blocker: 45,
    quantity: 20,
    state: 10,
  };
  let score = span.reasons.reduce((sum, reason) => sum + weights[reason], 0);
  if (SCOPE_ASSERTION.test(span.text)) score += 8;
  if (/`[^`]+`|(?:[A-Za-z0-9_.-]+[/\\])+[A-Za-z0-9_.@-]+/.test(span.text)) score += 5;
  return score;
}

/** Keep only the claims most likely to change a Jev verdict, in source order. */
export function selectStrongestClaimSpans(
  spans: ClaimSpan[],
  maxSpans: number = 3,
  budgetBytes: number = JEV_COMPRESSED_CLAIM_BUDGET_BYTES,
): ClaimSpan[] {
  const selected: ClaimSpan[] = [];
  let used = 0;
  for (const span of [...spans].sort((a, b) => claimStrength(b) - claimStrength(a) || a.start - b.start)) {
    if (selected.length >= maxSpans) break;
    const extra = Buffer.byteLength(span.text, "utf8") + (selected.length ? 1 : 0);
    if (extra > budgetBytes - used) continue;
    selected.push(span);
    used += extra;
  }
  if (selected.length === 0 && spans[0] && budgetBytes > 0) {
    const text = clipUtf8(spans[0].text, budgetBytes);
    return [{ ...spans[0], end: spans[0].start + text.length, text }];
  }
  return selected.sort((a, b) => a.start - b.start);
}

const STOP_WORDS = new Set([
  "about", "after", "again", "against", "also", "been", "before", "being", "between", "both", "could", "from", "have",
  "into", "just", "made", "more", "most", "only", "other", "over", "passed", "tests", "than", "that", "their", "there", "these",
  "test", "they", "this", "through", "under", "updated", "with", "work", "working", "would",
]);

function approxEq(a: number, b: number): boolean {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9) <= 0.01;
}

function evidenceAnchors(spans: ClaimSpan[]): { files: string[]; commands: string[]; tokens: string[]; numbers: number[] } {
  const text = renderClaimSpans(spans);
  const files = new Set<string>();
  const commands = new Set<string>();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const value = match[1]!.trim();
    if (/[/\\]|\.[a-z0-9]{1,8}$/i.test(value)) files.add(value.toLowerCase());
    if (/^(?:git|pnpm|npm|yarn|npx|vitest|jest|pytest|cargo|go\s+test|make|tsc|node|python|curl)\b/i.test(value)) commands.add(value.toLowerCase());
  }
  for (const match of text.matchAll(/(?:[A-Za-z0-9_.-]+[/\\])+[A-Za-z0-9_.@-]+|\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|yaml|yml|toml)\b/g)) {
    files.add(match[0]!.toLowerCase());
  }
  const tokens = new Set(
    text
      .toLowerCase()
      .match(/[a-z][a-z0-9_-]{3,}/g)
      ?.filter((token) => !STOP_WORDS.has(token)) ?? [],
  );
  return { files: [...files], commands: [...commands], tokens: [...tokens], numbers: specificNumbersIn(text) };
}

function stateSignature(spans: ClaimSpan[], text: string): boolean {
  const kinds = new Set(spans.flatMap((span) => stateKindsOf(span.text)));
  if (kinds.has("tests") && /\b(vitest|jest|pytest|npm t|pnpm test|yarn test|go test|cargo test|mocha)\b/i.test(text)) return true;
  if (kinds.has("commit") && /\bgit\s+(?:log|show|commit|status)\b|\bcommit\s+[0-9a-f]{7,}\b/i.test(text)) return true;
  if (kinds.has("push") && /\bgit\s+(?:push|status|rev-list)\b|\bupstream\b/i.test(text)) return true;
  if ((kinds.has("build") || kinds.has("ci")) && /\b(build|tsc|type\s?check|make|compile|webpack|vite|rollup|esbuild|gradle|mvn|ci)\b/i.test(text)) return true;
  if (kinds.has("deploy") && /\b(deploy|vercel|netlify|fly|kubectl|docker\s+push|release|wrangler)\b/i.test(text)) return true;
  if (kinds.has("change") && /\b(Edit|Write|applyPatch|apply_patch|git\s+(?:diff|status|show)|patch|sed\s+-i|tee)\b/.test(text)) return true;
  return false;
}

interface EvidenceUnit {
  lines: string[];
  index: number;
  score: number;
}

/** Select receipt blocks using the exact same spans that Jev receives. */
export function selectJevEvidence(
  evidence: string,
  spans: ClaimSpan[],
  budgetBytes: number = JEV_EVIDENCE_BUDGET_BYTES,
): JevEvidenceSelection {
  if (!evidence.trim() || spans.length === 0) return { text: "", bytes: 0, retainedLines: 0, elidedLines: evidence ? evidence.split(/\r?\n/).length : 0 };
  const lines = evidence.split(/\r?\n/);
  const anchors = evidenceAnchors(spans);
  const units: EvidenceUnit[] = [];
  for (let i = 0; i < lines.length;) {
    const start = i;
    const block = [lines[i]!];
    i++;
    if (/^>\s/.test(block[0]!)) while (i < lines.length && !/^>\s/.test(lines[i]!)) block.push(lines[i++]!);
    const joined = block.join("\n");
    const lower = joined.toLowerCase();
    let score = /^>\s/.test(block[0]!) ? 5 : 0; // retain a compact inventory of calls when budget permits
    if (anchors.files.some((file) => lower.includes(file))) score = Math.max(score, 100);
    if (anchors.commands.some((command) => lower.includes(command))) score = Math.max(score, 100);
    if (anchors.numbers.length && numbersIn(joined).some((n) => anchors.numbers.some((claim) => approxEq(n, claim)))) score = Math.max(score, 95);
    if (stateSignature(spans, joined)) score = Math.max(score, 90);
    const tokenHits = anchors.tokens.filter((token) => lower.includes(token)).length;
    if (tokenHits > 0) score = Math.max(score, 30 + Math.min(tokenHits, 5));
    units.push({ lines: block, index: start, score });
  }

  const summary = `[deterministic evidence selection: ${lines.length} line(s) searched against ${spans.length} load-bearing span(s)]`;
  let remaining = Math.max(0, budgetBytes - Buffer.byteLength(summary, "utf8") - 1);
  const kept = new Set<EvidenceUnit>();
  for (const unit of [...units].filter((u) => u.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)) {
    // Low-score units are unrelated calls retained only as a compact inventory
    // proving what was searched. Their noisy result bodies are not relevant.
    if (unit.score === 5) unit.lines = unit.lines.slice(0, 1);
    const bytes = Buffer.byteLength(unit.lines.join("\n"), "utf8") + 1;
    if (bytes > remaining) continue;
    kept.add(unit);
    remaining -= bytes;
  }

  const selected = units.filter((unit) => kept.has(unit)).sort((a, b) => a.index - b.index);
  const retainedLines = selected.reduce((sum, unit) => sum + unit.lines.length, 0);
  const elidedLines = lines.length - retainedLines;
  const out = [summary, ...selected.flatMap((unit) => unit.lines)];
  if (elidedLines > 0) out.push(`…[${elidedLines} evidence lines elided by load-bearing relevance selection]…`);
  let text = out.join("\n");
  if (Buffer.byteLength(text, "utf8") > budgetBytes) {
    text = Buffer.from(text, "utf8").subarray(0, budgetBytes).toString("utf8").replace(/\uFFFD$/u, "");
  }
  return { text, bytes: Buffer.byteLength(text, "utf8"), retainedLines, elidedLines };
}

interface ReceiptBlock {
  command: string;
  output: string[];
  index: number;
}

export interface JevPairedEvidence {
  claim: ClaimSpan;
  blocks: Array<{ call: string; output: string[] }>;
}

function commandFromReceiptLine(line: string): string | undefined {
  if (/^\$\s+/.test(line)) return line.replace(/^\$\s+/, "").trim();
  if (!/^>\s+/.test(line)) return undefined;
  const jsonStart = line.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const value = JSON.parse(line.slice(jsonStart)) as Record<string, unknown>;
      const command = value.command ?? value.cmd ?? value.args;
      if (typeof command === "string" && command.trim()) return command.trim();
      if (Array.isArray(command)) return command.map(String).join(" ");
    } catch {
      /* Keep the non-JSON tool call below. */
    }
  }
  return line.slice(2).trim();
}

function receiptBlocks(receipts: string): { blocks: ReceiptBlock[]; loose: Array<{ text: string; index: number }> } {
  const blocks: ReceiptBlock[] = [];
  const loose: Array<{ text: string; index: number }> = [];
  let current: ReceiptBlock | undefined;
  receipts.split(/\r?\n/).forEach((line, index) => {
    const command = commandFromReceiptLine(line);
    if (command) {
      current = { command, output: [], index };
      blocks.push(current);
      return;
    }
    if (current) current.output.push(line.replace(/^<\s?/, ""));
    else if (line.trim()) loose.push({ text: line.trim(), index });
  });
  return { blocks, loose };
}

/** Pair retained receipt blocks to the claim that made each block relevant. */
export function pairJevEvidence(
  receipts: string,
  spans: ClaimSpan[],
  budgetBytes: number = JEV_COMPRESSED_EVIDENCE_BUDGET_BYTES,
): JevPairedEvidence[] {
  const parsed = receiptBlocks(receipts);
  const candidates: Array<{
    claimIndex: number;
    score: number;
    index: number;
    block: { call: string; output: string[] };
  }> = [];
  for (const [claimIndex, span] of spans.entries()) {
    const anchors = evidenceAnchors([span]);
    for (const block of parsed.blocks) {
      const combined = `${block.command}\n${block.output.join("\n")}`;
      const lower = combined.toLowerCase();
      let score = 0;
      if (anchors.files.some((anchor) => lower.includes(anchor))) score = Math.max(score, 100);
      if (anchors.commands.some((anchor) => lower.includes(anchor))) score = Math.max(score, 100);
      if (anchors.numbers.length && numbersIn(combined).some((n) => anchors.numbers.some((claim) => approxEq(n, claim)))) score = Math.max(score, 95);
      if (stateSignature([span], combined)) score = Math.max(score, 90);
      const tokenHits = anchors.tokens.filter((token) => lower.includes(token)).length;
      if (tokenHits > 0) score = Math.max(score, 30 + Math.min(tokenHits, 5));
      if (score > 0) {
        candidates.push({
          claimIndex,
          score,
          index: block.index,
          block: {
            call: block.command.slice(0, 300),
            output: block.output.map((line) => line.replace(/^<\s?/, "").trim()).filter(Boolean).slice(0, 8),
          },
        });
      }
    }
    for (const loose of parsed.loose) {
      const lower = loose.text.toLowerCase();
      const tokenHits = anchors.tokens.filter((token) => lower.includes(token)).length;
      const numberHit = anchors.numbers.length > 0 && numbersIn(loose.text).some((n) => anchors.numbers.some((claim) => approxEq(n, claim)));
      if (tokenHits === 0 && !numberHit) continue;
      candidates.push({
        claimIndex,
        score: (numberHit ? 95 : 0) + 30 + Math.min(tokenHits, 5),
        index: loose.index,
        block: { call: "session evidence", output: [loose.text.slice(0, 400)] },
      });
    }
  }

  const selected: typeof candidates = [];
  let used = 0;
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score || a.index - b.index)) {
    const bytes = Buffer.byteLength(JSON.stringify(candidate.block), "utf8");
    if (bytes > budgetBytes - used) continue;
    selected.push(candidate);
    used += bytes;
  }
  return spans.map((claim, claimIndex) => ({
    claim,
    blocks: selected
      .filter((candidate) => candidate.claimIndex === claimIndex)
      .sort((a, b) => a.index - b.index)
      .map((candidate) => candidate.block),
  }));
}

function maximumCounter(text: string, label: "passed" | "failed"): number | undefined {
  const values = [
    ...text.matchAll(new RegExp(`\\b(\\d+)\\s+${label}\\b`, "gi")),
    ...text.matchAll(new RegExp(`\\b(?:all\\s+)?(\\d+)\\s+(?:tests?|specs?|checks?|files?)\\s+${label}\\b`, "gi")),
  ]
    .map((match) => Number.parseInt(match[1]!, 10))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : undefined;
}

function quoted(value: string, cap = 220): string {
  return `"${value.slice(0, cap).replace(/["\\\n\r]/g, " ").replace(/\s+/g, " ").trim()}"`;
}

/**
 * Convert raw receipt prose into command/result facts. No model, embedding, or
 * semantic summary is involved: every field comes from a bounded regex/parser.
 */
export function digestJevReceipts(
  receipts: string,
  spans: ClaimSpan[],
  budgetBytes: number = JEV_COMPRESSED_EVIDENCE_BUDGET_BYTES,
): JevEvidenceSelection {
  if (!receipts.trim() || spans.length === 0 || budgetBytes <= 0) {
    return { text: "", bytes: 0, retainedLines: 0, elidedLines: receipts ? receipts.split(/\r?\n/).length : 0 };
  }
  const anchors = evidenceAnchors(spans);
  const parsed = receiptBlocks(receipts);
  const facts: Array<{ text: string; score: number; index: number; sourceLines: number }> = [];
  const structuredOutcome = /^(?:BROWSER_ASSERT|DOM_ASSERT|A11Y_ASSERT|VISUAL_ASSERT|SCREENSHOT_FACT|OBSERVATION_FACT)\b|\b(?:horizontal_overflow|overflow|visible|clipped|violations|serious|critical|measured_fps|dropped_frames|viewport)=[^\s]+/i;
  for (const block of parsed.blocks) {
    const output = block.output.join("\n");
    const combined = `${block.command}\n${output}`;
    const exitMatches = [...output.matchAll(/\bexit(?:ed)?(?:\s+with)?(?:\s+code)?\s*[:=]?\s*(-?\d+)\b/gi)];
    const exitCode = exitMatches.length ? Number.parseInt(exitMatches.at(-1)![1]!, 10) : undefined;
    const passed = maximumCounter(output, "passed");
    const failed = maximumCounter(output, "failed");
    let outcome: "pass" | "fail" | "unknown" = "unknown";
    if (exitCode !== undefined) outcome = exitCode === 0 ? "pass" : "fail";
    else if ((failed ?? 0) > 0 || /(^|\n)\s*(?:FAIL|✗|×)\b/m.test(output)) outcome = "fail";
    else if (passed !== undefined || /(^|\n)\s*(?:PASS|✓)\b/m.test(output)) outcome = "pass";
    const lower = combined.toLowerCase();
    const mentions = [...new Set([
      ...anchors.files.filter((anchor) => lower.includes(anchor)),
      ...anchors.commands.filter((anchor) => lower.includes(anchor)),
      ...anchors.tokens.filter((anchor) => !/^(?:suite|pass|passes|passing)$/.test(anchor) && lower.includes(anchor)),
    ])].slice(0, 5);
    const machineFacts = block.output
      .filter((line) => structuredOutcome.test(line.trim()))
      .map((line) => cleanMachineFact(line))
      .filter(Boolean)
      .slice(0, 3);
    let score = outcome === "unknown" ? 5 : 25;
    if (mentions.length) score += 100;
    if (stateSignature(spans, combined)) score += 80;
    if (anchors.numbers.length && numbersIn(combined).some((n) => anchors.numbers.some((claim) => approxEq(n, claim)))) score += 70;
    const fields = [
      `command=${quoted(block.command)}`,
      `exit=${exitCode ?? "unknown"}`,
      `outcome=${outcome}`,
      ...(passed !== undefined ? [`passed=${passed}`] : []),
      ...(failed !== undefined ? [`failed=${failed}`] : []),
      ...(mentions.length ? [`mentions=${mentions.join(",")}`] : []),
      ...(machineFacts.length ? [`facts=${machineFacts.join(";")}`] : []),
    ];
    facts.push({ text: fields.join(" "), score, index: block.index, sourceLines: block.output.length + 1 });
  }

  for (const line of parsed.loose) {
    if (!structuredOutcome.test(line.text)) continue;
    const lower = line.text.toLowerCase();
    const score = 60 + anchors.tokens.filter((anchor) => lower.includes(anchor)).length * 5;
    facts.push({ text: line.text.replace(/^([A-Z_]+)/, (prefix) => prefix.toLowerCase()), score, index: line.index, sourceLines: 1 });
  }

  const lineCount = receipts.split(/\r?\n/).length;
  const header = `receipt_outcomes source_lines=${lineCount} commands=${parsed.blocks.length}`;
  const kept: typeof facts = [];
  let used = Buffer.byteLength(header, "utf8");
  for (const fact of [...facts].sort((a, b) => b.score - a.score || a.index - b.index)) {
    const extra = Buffer.byteLength(fact.text, "utf8") + 1;
    if (extra > budgetBytes - used) continue;
    kept.push(fact);
    used += extra;
  }
  kept.sort((a, b) => a.index - b.index);
  const retainedLines = kept.reduce((sum, fact) => sum + fact.sourceLines, 0);
  const text = clipUtf8([header, ...kept.map((fact) => fact.text)].join("\n"), budgetBytes);
  return {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    retainedLines,
    elidedLines: Math.max(0, lineCount - retainedLines),
  };
}

function cleanMachineFact(value: string): string {
  return value
    .replace(/^<\s?/, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/["\\]/g, "")
    .slice(0, 260);
}
