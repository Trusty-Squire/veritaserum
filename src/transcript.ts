/**
 * Read a harness transcript (Claude Code's Stop-hook `transcript_path`, JSONL).
 * Tolerant throughout: unknown/renamed shapes degrade to "" / empty, never throw
 * — a transcript-shape change can't take down the sync path or the async audit
 * job (R8).
 */
import { readFileSync, existsSync } from "node:fs";

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
      const o = obj as Record<string, unknown>;
      // Common shapes: {type:"assistant", message:{role, content}} | {role, content}
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
 *  message — the async audit job's "the user's request" (SPEC §2 step 1). */
export function readLastUserMessage(path: string): string {
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
      const o = obj as Record<string, unknown>;
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
      const o = obj as Record<string, unknown>;
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
