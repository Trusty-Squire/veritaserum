/**
 * Read the last assistant message from a harness transcript. Claude Code hands
 * the Stop hook a `transcript_path` (JSONL) instead of the message inline; codex
 * and post-#9968 goose pass the message directly, so this is only used when a
 * path is supplied. Tolerant: unknown/renamed shapes degrade to "" (→ no claim →
 * no block), never throw into the hook path.
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
