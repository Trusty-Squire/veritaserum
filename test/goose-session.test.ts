/**
 * src/goose.ts — reading goose's own sessions.db (SPEC.md §3 "goose" section).
 * Builds a fixture db with node:sqlite (same shape verified against a live
 * goose sessions.db: messages(session_id, role, content_json, created_timestamp),
 * content_json blocks {"type": "text"|"thinking"|"toolRequest"|"toolResponse"}).
 * Every path here must be defensive (SPEC instruction) — missing db/table/session
 * degrade to null/false, never throw.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { defaultGooseSessionsDb, hasToolActivitySince, readGooseSession } from "../src/goose.js";

// See src/goose.ts for why this isn't a static `import ... from "node:sqlite"`.
const DatabaseSync: typeof DatabaseSyncType = createRequire(import.meta.url)("node:sqlite").DatabaseSync;

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vs-goose-db-"));
  dbPath = join(tmp, "sessions.db");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Row {
  sessionId: string;
  role: string;
  contentJson: unknown[];
  ts: number;
}

function makeDb(path: string, rows: Row[]): void {
  const db = new DatabaseSync(path);
  db.exec(
    `CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_timestamp INTEGER NOT NULL
    )`,
  );
  const insert = db.prepare(
    "INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?)",
  );
  for (const r of rows) insert.run(r.sessionId, r.role, JSON.stringify(r.contentJson), r.ts);
  db.close();
}

const textBlock = (text: string) => [{ type: "text", text }];
const thinkingBlock = (thinking: string) => [{ type: "thinking", thinking, signature: "" }];
const toolRequestBlock = (id: string, name: string, args: unknown) => [
  { type: "toolRequest", id, toolCall: { status: "success", value: { name, arguments: args } } },
];
const toolResponseBlock = (id: string, text: string) => [
  { type: "toolResponse", id, toolResult: { status: "success", value: { content: [{ type: "text", text }], isError: false } } },
];

describe("defaultGooseSessionsDb", () => {
  afterEach(() => {
    delete process.env.VS_GOOSE_SESSIONS_DB;
  });

  it("respects VS_GOOSE_SESSIONS_DB override", () => {
    process.env.VS_GOOSE_SESSIONS_DB = "/custom/path/sessions.db";
    expect(defaultGooseSessionsDb()).toBe("/custom/path/sessions.db");
  });

  it("falls back to goose's documented convention", () => {
    delete process.env.VS_GOOSE_SESSIONS_DB;
    expect(defaultGooseSessionsDb()).toContain(join(".local", "share", "goose", "sessions", "sessions.db"));
  });
});

describe("readGooseSession — extraction from a real-shaped fixture", () => {
  it("finds the last assistant text, the human's last (non-tool) request, and a compact receipt tail", () => {
    makeDb(dbPath, [
      { sessionId: "s1", role: "user", contentJson: textBlock("please add a reverse() helper"), ts: 100 },
      { sessionId: "s1", role: "assistant", contentJson: thinkingBlock("let me look at the repo"), ts: 101 },
      { sessionId: "s1", role: "assistant", contentJson: toolRequestBlock("c1", "shell", { command: "cat reverse.ts" }), ts: 102 },
      { sessionId: "s1", role: "user", contentJson: toolResponseBlock("c1", "export function reverse(s) {}"), ts: 103 },
      { sessionId: "s1", role: "assistant", contentJson: textBlock("Done — implemented reverse(), tests pass."), ts: 104 },
    ]);

    const s = readGooseSession("s1", dbPath);
    expect(s.finalAssistantMessage).toBe("Done — implemented reverse(), tests pass.");
    expect(s.userRequest).toBe("please add a reverse() helper");
    expect(s.receiptsTail).toContain("shell");
    expect(s.receiptsTail).toContain("cat reverse.ts");
    expect(s.receiptsTail).toContain("export function reverse(s) {}");
  });

  it("skips toolResponse blocks (role:user) when hunting for the human's actual last request", () => {
    makeDb(dbPath, [
      { sessionId: "s1", role: "user", contentJson: textBlock("the real request"), ts: 100 },
      { sessionId: "s1", role: "assistant", contentJson: toolRequestBlock("c1", "shell", { command: "ls" }), ts: 101 },
      { sessionId: "s1", role: "user", contentJson: toolResponseBlock("c1", "file.txt"), ts: 102 }, // NOT the human's request
    ]);
    expect(readGooseSession("s1", dbPath).userRequest).toBe("the real request");
  });

  it("returns nulls for an unknown session_id in a real db (never throws)", () => {
    makeDb(dbPath, [{ sessionId: "s1", role: "user", contentJson: textBlock("hi"), ts: 100 }]);
    const s = readGooseSession("no-such-session", dbPath);
    expect(s).toEqual({ finalAssistantMessage: null, userRequest: null, receiptsTail: null });
  });

  it("returns nulls for a missing db file (never throws)", () => {
    const s = readGooseSession("s1", join(tmp, "does-not-exist.db"));
    expect(s).toEqual({ finalAssistantMessage: null, userRequest: null, receiptsTail: null });
  });

  it("returns nulls when the messages table doesn't exist (schema drift, never throws)", () => {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE unrelated (id INTEGER)");
    db.close();
    const s = readGooseSession("s1", dbPath);
    expect(s).toEqual({ finalAssistantMessage: null, userRequest: null, receiptsTail: null });
  });

  it("tolerates a corrupt content_json row (skips it, never throws)", () => {
    const db = new DatabaseSync(dbPath);
    db.exec(
      `CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content_json TEXT NOT NULL, created_timestamp INTEGER NOT NULL
      )`,
    );
    db.prepare("INSERT INTO messages (session_id, role, content_json, created_timestamp) VALUES (?, ?, ?, ?)").run(
      "s1",
      "assistant",
      "{not valid json",
      100,
    );
    db.close();
    expect(readGooseSession("s1", dbPath)).toEqual({ finalAssistantMessage: null, userRequest: null, receiptsTail: null });
  });
});

describe("hasToolActivitySince — the sync-path nothing-to-audit probe", () => {
  it("true when a toolRequest/toolResponse row lands after the watermark", () => {
    makeDb(dbPath, [
      { sessionId: "s1", role: "user", contentJson: textBlock("old chatter"), ts: 100 },
      { sessionId: "s1", role: "assistant", contentJson: toolRequestBlock("c1", "shell", { command: "ls" }), ts: 500 },
    ]);
    expect(hasToolActivitySince(dbPath, "s1", 200_000)).toBe(true); // 200s in ms
  });

  it("true when only text/thinking rows exist after the watermark — armchair claims get audited too", () => {
    makeDb(dbPath, [
      { sessionId: "s1", role: "assistant", contentJson: toolRequestBlock("c1", "shell", { command: "ls" }), ts: 100 },
      { sessionId: "s1", role: "assistant", contentJson: thinkingBlock("just thinking"), ts: 500 },
      { sessionId: "s1", role: "user", contentJson: textBlock("more chat"), ts: 600 },
    ]);
    // A misdiagnosis in a zero-tool-call turn is exactly the cause-attribution
    // class the auditor exists for; any new message counts as auditable.
    expect(hasToolActivitySince(dbPath, "s1", 200_000)).toBe(true);
  });

  it("false for a session with no rows at all after the watermark", () => {
    makeDb(dbPath, [{ sessionId: "s1", role: "assistant", contentJson: toolRequestBlock("c1", "shell", {}), ts: 100 }]);
    expect(hasToolActivitySince(dbPath, "s1", 200_000)).toBe(false);
  });

  it("false for a missing db file (never throws)", () => {
    expect(hasToolActivitySince(join(tmp, "nope.db"), "s1", 0)).toBe(false);
  });

  it("false for an unknown session_id (never throws)", () => {
    makeDb(dbPath, [{ sessionId: "s1", role: "assistant", contentJson: toolRequestBlock("c1", "shell", {}), ts: 999 }]);
    expect(hasToolActivitySince(dbPath, "no-such-session", 0)).toBe(false);
  });
});
