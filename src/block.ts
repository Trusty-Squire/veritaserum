/**
 * Captain's override of R5 (warn-primary). Blocking is not a missing feature
 * that was always intended — SPEC.md and the README said plainly that nothing
 * blocks, and that blocking is earned per standing-law entry and promoted by a
 * human. The captain overrode that so a confident confabulation can be sent
 * back for revision, now that Jev makes a same-turn audit affordable.
 *
 * On:  VS_BLOCK=1 (or true/yes/on)
 * Off: unset, VS_BLOCK=0, false, off, no — never requires a code edit
 * Cap: 2 blocks per session (VS_BLOCK_CAP overrides). After the cap, the turn
 *      finishes — never a deadlock.
 * Fail-open: only a positive, confident finding blocks. Outage, missing key,
 * malformed reply, timeout, or auditor_absent never block.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditVerdict } from "./auditor.js";
import { queueRoot } from "./audit-runner.js";

export const DEFAULT_BLOCK_CAP = 2;

export function isBlockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.VS_BLOCK ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Explicit off wins even for the goose block-plugin command. */
export function isBlockExplicitlyOff(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.VS_BLOCK ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

export function blockCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.VS_BLOCK_CAP);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BLOCK_CAP;
}

function sanitizeForFile(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function blockCountPath(qdir: string, sessionId: string): string {
  return join(qdir, "block-count", `${sanitizeForFile(sessionId)}.json`);
}

export function readBlockCount(qdir: string, sessionId: string): number {
  try {
    const v = JSON.parse(readFileSync(blockCountPath(qdir, sessionId), "utf8")) as { count?: number };
    return typeof v.count === "number" ? v.count : 0;
  } catch {
    return 0;
  }
}

export function writeBlockCount(qdir: string, sessionId: string, count: number): void {
  try {
    const p = blockCountPath(qdir, sessionId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ count }), "utf8");
  } catch {
    /* best-effort (R8) */
  }
}

export function sessionBlockCount(dir: string, sessionId: string): number {
  return readBlockCount(queueRoot(dir), sessionId);
}

export function bumpSessionBlockCount(dir: string, sessionId: string, next: number): void {
  writeBlockCount(queueRoot(dir), sessionId, next);
}

/**
 * A block exists so the agent can revise. Only unsupported/contradicted claims
 * count — R9 unaccountable work stays warn-only (low sensitivity; the captain
 * named two classes, not vagueness).
 */
export function shouldBlock(verdict: AuditVerdict, priorBlocks: number, cap: number = DEFAULT_BLOCK_CAP): boolean {
  if (priorBlocks >= cap) return false;
  if (verdict.error) return false;
  return verdict.claims.some((c) => c.verdict === "unsupported" || c.verdict === "contradicted");
}

export function formatBlockReason(verdict: AuditVerdict): string {
  const flagged = verdict.claims.filter((c) => c.verdict === "unsupported" || c.verdict === "contradicted");
  const lines = [`veritaserum: ${flagged.length} claim(s) not backed by the session's own evidence:`];
  for (const c of flagged) lines.push(`  - ${c.claim}: ${c.basis || c.evidence || "no basis given"}`);
  lines.push("Revise or retract before finishing. A block is a chance to correct, not a deadlock.");
  return lines.join("\n");
}

export interface BlockEmission {
  /** Process exit code for the Stop hook. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Harness-specific block emission:
 * - goose: exit 2 + stderr (feeds the reason back to the agent)
 * - claude-code / codex: exit 0 with JSON {decision:"block", reason} on stdout
 *   (Codex rejects plain-text Stop stdout; Claude Code accepts the JSON decision)
 */
export function emitBlock(harness: string, reason: string, gooseProtocol = false): BlockEmission {
  const h = harness.toLowerCase();
  if (gooseProtocol || h === "goose") {
    return { exitCode: 2, stdout: "", stderr: reason };
  }
  return {
    exitCode: 0,
    stdout: JSON.stringify({ decision: "block", reason }) + "\n",
    stderr: "",
  };
}
