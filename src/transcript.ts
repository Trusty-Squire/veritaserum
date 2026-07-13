/**
 * Read a harness transcript (JSONL). Two shapes, both first-class:
 *
 *  - **Claude Code** — `{type:"assistant", message:{role, content:[{type:"text"|"tool_use"|
 *    "tool_result", …}]}}`, one record per line.
 *  - **codex rollout** — every record is WRAPPED: `{timestamp, type:"response_item", payload:{…}}`.
 *    The assistant turn is `payload:{type:"message", role:"assistant", content:[{type:
 *    "output_text", text}]}`, and tools are `function_call`/`custom_tool_call` +
 *    `…_output` records, NOT content parts.
 *
 * The wrapper is why codex coverage was fake: this reader looked for `role`/`content` at the
 * TOP level, found neither under codex's `payload`, and returned "" for every field. The
 * auditor then dutifully audited an empty string and reported "no-claim" — 830 audits in one
 * day, every one of them vacuous, on the busiest harness on the box, while telemetry looked
 * green. Unwrap `payload` and both schemas read the same way.
 *
 * Tolerant throughout: unknown/renamed shapes degrade to "" / empty, never throw — a
 * transcript-shape change can't take down the sync path or the async audit job (R8).
 */
import { readFileSync, existsSync } from "node:fs";

/** codex wraps every record in `payload`; Claude Code doesn't. Unwrap, then read alike. */
function unwrap(o: Record<string, unknown>): Record<string, unknown> {
  const p = o.payload;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : o;
}

/** codex's own record of what the HUMAN said: `payload:{type:"user_message", message:"…"}`.
 *  "" when this isn't a codex rollout. */
function readLastCodexUserMessage(path: string): string {
  try {
    if (!existsSync(path)) return "";
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj: unknown;
      try {
        obj = JSON.parse(lines[i] as string);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      const rec = unwrap(obj as Record<string, unknown>);
      if (rec.type !== "user_message") continue;
      const text = typeof rec.message === "string" ? rec.message.trim() : "";
      if (text) return text;
    }
    return "";
  } catch {
    return "";
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("")
      .trim();
  }
  return "";
}

/** Last assistant text in a JSONL transcript, or "" if none/unreadable. */
export function readLastAssistantMessage(path: string): string {
  try {
    if (!existsSync(path)) return "";
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj: unknown;
      try {
        obj = JSON.parse(lines[i] as string);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      const o = unwrap(obj as Record<string, unknown>);
      // Shapes: {type:"assistant", message:{role, content}} | {role, content} | codex's
      // unwrapped {type:"message", role:"assistant", content:[{type:"output_text", text}]}
      const role = o.role ?? (o.message as Record<string, unknown> | undefined)?.role ?? o.type;
      if (role !== "assistant") continue;
      const content = (o.message as Record<string, unknown> | undefined)?.content ?? o.content;
      const text = textFromContent(content);
      if (text) return text;
    }
    return "";
  } catch {
    return "";
  }
}

/** Same lookup as `readLastAssistantMessage`, but for the human's own last
 *  message — the async audit job's "the user's request" (SPEC §2 step 1).
 *
 *  codex first: its `role:"user"` records are NOT reliably the human — the harness injects
 *  AGENTS.md and `<environment_context>` as user-role messages, so on a first turn the last
 *  `role:"user"` record is boilerplate, and the audit would judge the work against the
 *  instructions file instead of the request. codex logs the human's own turn separately, as
 *  a `user_message` event; prefer it, and fall back to role-scanning for other harnesses. */
export function readLastUserMessage(path: string): string {
  const codex = readLastCodexUserMessage(path);
  if (codex) return codex;
  try {
    if (!existsSync(path)) return "";
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj: unknown;
      try {
        obj = JSON.parse(lines[i] as string);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      const o = unwrap(obj as Record<string, unknown>);
      // codex also logs a `developer` role (the injected permissions/system preamble) as a
      // message record — it is NOT the human, and auditing against it would judge the turn
      // against boilerplate instead of the request.
      const role = o.role ?? (o.message as Record<string, unknown> | undefined)?.role ?? o.type;
      if (role !== "user") continue;
      const content = (o.message as Record<string, unknown> | undefined)?.content ?? o.content;
      const text = textFromContent(content);
      if (text) return text;
    }
    return "";
  } catch {
    return "";
  }
}

interface TranscriptPart {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

/** Clip a long tool result keeping BOTH ends — biased to the tail, because a
 *  verification receipt (a test summary, an exit line, a build result) lives at
 *  the END of the output. A head-only slice systematically drops the one thing
 *  the mechanical tier reads: `npm test` → "Tests 215 passed" is the last line. */
function clipResult(text: string, cap = 2000): string {
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.35);
  const tail = cap - head;
  return `${text.slice(0, head)} …[${text.length - cap} chars elided]… ${text.slice(-tail)}`;
}

function toolLine(part: TranscriptPart): string | null {
  if (part.type === "tool_use") return `> ${part.name ?? "?"} ${JSON.stringify(part.input ?? {})}`;
  if (part.type === "tool_result") {
    const text = typeof part.content === "string" ? part.content : textFromContent(part.content) || JSON.stringify(part.content ?? {});
    return `< ${clipResult(text)}`;
  }
  return null;
}

/**
 * codex's receipts are not content parts — they are their own records:
 *   function_call        {name, arguments}      custom_tool_call        {name, input}
 *   function_call_output {output}               custom_tool_call_output {output}
 * The call and its output are separate lines, so a receipt tail assembled only from
 * `content[]` arrays (the Claude Code shape) sees NONE of a codex turn's tool activity —
 * which left the auditor judging codex claims with zero evidence of what actually ran.
 */
function codexToolLine(rec: Record<string, unknown>): string | null {
  const type = rec.type;
  const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));
  if (type === "function_call" || type === "custom_tool_call") {
    const args = str(rec.arguments ?? rec.input);
    return `> ${str(rec.name) || "?"} ${clipResult(args, 600)}`;
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    return `< ${clipResult(str(rec.output))}`;
  }
  return null;
}

const RECEIPTS_TAIL_CAP_BYTES = 256 * 1024;

/**
 * Last ~256KB of tool_use/tool_result activity in a Claude Code transcript
 * (JSONL), formatted compactly — the "harness's own record" receipt tail
 * (SPEC R1/§2 step 1/3) for a Claude Code turn, the same role goose's
 * `readGooseSession().receiptsTail` plays for a goose turn. "" when there's
 * no tool activity or the file is missing/garbage — never throws.
 */
export function readReceiptsTail(path: string, capBytes: number = RECEIPTS_TAIL_CAP_BYTES): string {
  try {
    if (!existsSync(path)) return "";
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const out: string[] = [];
    for (const line of lines) {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      const o = unwrap(obj as Record<string, unknown>);
      // codex: the tool call/result IS the record (no content[] to walk).
      const codexLine = codexToolLine(o);
      if (codexLine) {
        out.push(codexLine);
        continue;
      }
      const content = (o.message as Record<string, unknown> | undefined)?.content ?? o.content;
      if (!Array.isArray(content)) continue;
      for (const part of content as TranscriptPart[]) {
        const line2 = part && typeof part === "object" ? toolLine(part) : null;
        if (line2) out.push(line2);
      }
    }
    if (!out.length) return "";
    let tail = out.join("\n");
    if (tail.length > capBytes) tail = tail.slice(tail.length - capBytes);
    return tail;
  } catch {
    return "";
  }
}
