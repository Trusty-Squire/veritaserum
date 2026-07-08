/**
 * goose `sessions.db` reader (SPEC.md §3 "goose" section, §2 sync-path step 1).
 *
 * goose's Stop hook payload is context-free by design (v3 deliberately does not
 * lean on `last_assistant_message`/`message` even where a build happens to send
 * one — SPEC §3: sessions.db is "a cleaner harness record than transcript
 * parsing"). Everything the sync path and the async auditor need — whether any
 * tool activity happened, the final assistant message, the user's request, and
 * a receipt tail — is read from goose's own SQLite record, keyed by session_id.
 *
 * Schema (goose `crates/goose/src/session/storage.rs`, verified against a live
 * `sessions.db`): `messages(session_id, role, content_json, created_timestamp)`,
 * where `content_json` is a JSON array of content blocks — `{"type":"text",...}`,
 * `{"type":"toolRequest",...}`, `{"type":"toolResponse",...}`, `{"type":"thinking",...}`.
 * `created_timestamp` is unix epoch SECONDS. Tool results ride back as
 * `role: "user"` messages (goose's own convention, not ours).
 *
 * Uses node:sqlite's DatabaseSync (stable in Node 24, no new npm dependency —
 * SPEC instruction). Opened `{ readOnly: true }`: this module never writes to
 * goose's database. Every export is defensive — a missing db file, a missing
 * table, or an unknown session all degrade to nulls/false, never throw, so a
 * goose upgrade that reshapes the schema can't take down the sync path (R8).
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// Loaded via createRequire rather than a static `import ... from "node:sqlite"`:
// this module needs to keep working under the project's current vitest/vite
// toolchain, which doesn't yet resolve the (Node 22+-only, no bare alias)
// "node:sqlite" specifier through its ESM import analysis. require() sidesteps
// that; the type-only import above keeps this fully typed.
const DatabaseSync: typeof DatabaseSyncType = createRequire(import.meta.url)("node:sqlite").DatabaseSync;

/** `goose info`'s documented sessions.db location; VS_GOOSE_SESSIONS_DB overrides (tests use this). */
export function defaultGooseSessionsDb(): string {
  return process.env.VS_GOOSE_SESSIONS_DB || join(homedir(), ".local", "share", "goose", "sessions", "sessions.db");
}

interface ContentBlock {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

function parseContentJson(raw: string): ContentBlock[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as ContentBlock[]) : [];
  } catch {
    return [];
  }
}

function isToolBlock(b: ContentBlock): boolean {
  return b?.type === "toolRequest" || b?.type === "toolResponse";
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

/** Open read-only; any failure (missing file, permissions, not a sqlite db) → null, never throws. */
function openReadOnly(dbPath: string): InstanceType<typeof DatabaseSync> | null {
  if (!existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

/**
 * Sync-path step 1 (SPEC §2): has any tool-bearing message for `sessionId` been
 * recorded after `sinceEpochMs`? Used to answer "nothing to audit" — a false
 * here is the ~0ms exit. Defensive: any DB/schema failure → false (fail toward
 * silence, never toward noise, on the sync path — R8).
 */
export function hasToolActivitySince(dbPath: string, sessionId: string, sinceEpochMs: number): boolean {
  const db = openReadOnly(dbPath);
  if (!db) return false;
  try {
    const sinceSec = Math.floor(sinceEpochMs / 1000);
    const rows = db
      .prepare("SELECT content_json FROM messages WHERE session_id = ? AND created_timestamp > ? ORDER BY id ASC")
      .all(sessionId, sinceSec) as { content_json: string }[];
    return rows.some((r) => parseContentJson(r.content_json).some(isToolBlock));
  } catch {
    return false;
  } finally {
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  }
}

export interface GooseSession {
  finalAssistantMessage: string | null;
  userRequest: string | null;
  /** Last N tool call/result messages as compact text, capped (never throws building it). */
  receiptsTail: string | null;
}

const RECEIPTS_TAIL_CAP_BYTES = 32 * 1024;
const RECEIPTS_LOOKBACK_MESSAGES = 40;

const EMPTY_SESSION: GooseSession = { finalAssistantMessage: null, userRequest: null, receiptsTail: null };

function toolLine(block: ContentBlock): string | null {
  if (block.type === "toolRequest") {
    const call = (block as { toolCall?: { value?: { name?: string; arguments?: unknown } } }).toolCall?.value;
    return `> ${call?.name ?? "?"} ${JSON.stringify(call?.arguments ?? {})}`;
  }
  if (block.type === "toolResponse") {
    const result = (block as { toolResult?: { value?: { content?: unknown } } }).toolResult?.value;
    const content = Array.isArray(result?.content) ? (result!.content as ContentBlock[]) : [];
    const text = content.length ? textOf(content) : JSON.stringify(result ?? {});
    return `< ${text.slice(0, 2000)}`;
  }
  return null;
}

/**
 * Read one goose session's final assistant message, the user's last request,
 * and a compact receipt tail — the three things the async auditor needs (SPEC
 * §2 "audit job" step 1/3). Never throws: missing db/session/table → all null.
 */
export function readGooseSession(sessionId: string, dbPath: string = defaultGooseSessionsDb()): GooseSession {
  const db = openReadOnly(dbPath);
  if (!db) return EMPTY_SESSION;
  try {
    // Callers may hold a session NAME rather than goose's generated id (`goose run
    // --name X` — this goose build refuses --session-id on fresh sessions). Try the
    // raw id first; fall back to the newest session whose name matches.
    let id = sessionId;
    const direct = db.prepare("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1").get(sessionId);
    if (!direct) {
      const byName = db.prepare("SELECT id FROM sessions WHERE name = ? ORDER BY created_at DESC LIMIT 1").get(sessionId) as
        | { id: string }
        | undefined;
      if (byName) id = byName.id;
    }
    const rows = db
      .prepare("SELECT role, content_json FROM messages WHERE session_id = ? ORDER BY id ASC")
      .all(id) as { role: string; content_json: string }[];
    if (!rows.length) return EMPTY_SESSION;

    let finalAssistantMessage: string | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (row.role !== "assistant") continue;
      const t = textOf(parseContentJson(row.content_json));
      if (t) {
        finalAssistantMessage = t;
        break;
      }
    }

    // Tool results also ride back as role:"user" — skip those when hunting for
    // the human's own last request text.
    let userRequest: string | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]!;
      if (row.role !== "user") continue;
      const blocks = parseContentJson(row.content_json);
      if (blocks.some(isToolBlock)) continue;
      const t = textOf(blocks);
      if (t) {
        userRequest = t;
        break;
      }
    }

    const lines: string[] = [];
    for (const row of rows) {
      const blocks = parseContentJson(row.content_json);
      if (!blocks.some(isToolBlock)) continue;
      for (const b of blocks) {
        const line = toolLine(b);
        if (line) lines.push(line);
      }
    }
    let receiptsTail: string | null = null;
    if (lines.length) {
      let tail = lines.slice(-RECEIPTS_LOOKBACK_MESSAGES).join("\n");
      if (tail.length > RECEIPTS_TAIL_CAP_BYTES) tail = tail.slice(tail.length - RECEIPTS_TAIL_CAP_BYTES);
      receiptsTail = tail;
    }

    return { finalAssistantMessage, userRequest, receiptsTail };
  } catch {
    return EMPTY_SESSION;
  } finally {
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  }
}
