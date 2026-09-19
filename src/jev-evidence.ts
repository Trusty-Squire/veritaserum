/** Deterministic construction of the three Jev input diets used by production and evals. */
import { execa } from "execa";
import type { JevTurnState } from "./jev.js";
import {
  compressUserRequest,
  detectLoadBearingClaims,
  digestJevReceipts,
  JEV_COMPRESSED_EVIDENCE_BUDGET_BYTES,
  renderClaimSpans,
  selectJevEvidence,
  selectStrongestClaimSpans,
  type ClaimSpan,
} from "./jev-input.js";

export interface JevInputMaterial {
  dir: string;
  userRequest: string;
  finalMessage: string;
  receipts?: string;
}

export interface JevInputVariants {
  full: JevTurnState;
  filtered: JevTurnState;
  compressed: JevTurnState;
}

function cleanField(value: string, cap = 180): string {
  return value.replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, cap);
}

function withinBudget(lines: string[], budgetBytes: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line, "utf8") + (kept.length ? 1 : 0);
    if (bytes > budgetBytes - used) continue;
    kept.push(line);
    used += bytes;
  }
  return kept.join("\n");
}

/** The pre-compression evidence shape, retained only for the three-way eval. */
export async function gatherFullJevEvidence(dir: string, receipts: string | undefined): Promise<string> {
  const [log, stat, diff, status] = await Promise.all([
    execa("git", ["log", "-10", "--date=relative", "--format=%h (%ad) %s"], { cwd: dir, reject: false }),
    execa("git", ["log", "-3", "--stat", "--format=commit %h %s"], { cwd: dir, reject: false }),
    execa("git", ["diff", "--stat", "HEAD"], { cwd: dir, reject: false }),
    execa("git", ["status", "--porcelain"], { cwd: dir, reject: false }),
  ]);
  const l = (log.stdout ?? "").trim();
  const st = (stat.stdout ?? "").trim();
  const d = (diff.stdout ?? "").trim();
  const s = (status.stdout ?? "").trim();
  return [
    l ? `git log -10 (newest first):\n${l}` : "git log: (no commits)",
    st ? `files touched by the last 3 commits (git log --stat):\n${st}` : "",
    d ? `git diff --stat HEAD:\n${d}` : "git diff --stat HEAD: (no uncommitted changes)",
    s ? `git status --porcelain:\n${s}` : "git status: clean",
    receipts ? `harness receipt tail (what actually ran, the harness's own record):\n${receipts}` : "",
  ].filter(Boolean).join("\n\n");
}

function recentCommitFacts(raw: string): string[] {
  const facts: string[] = [];
  let current: { header: string; paths: string[] } | undefined;
  const flush = (): void => {
    if (!current) return;
    facts.push(`git_commit ${current.header}${current.paths.length ? ` paths=${current.paths.slice(0, 12).join(",")}` : ""}`);
  };
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("@@")) {
      flush();
      const [sha = "unknown", ...subject] = line.slice(2).split("\t");
      current = { header: `sha=${cleanField(sha, 16)} subject="${cleanField(subject.join(" "))}"`, paths: [] };
    } else if (current) {
      current.paths.push(cleanField(line, 160));
    }
  }
  flush();
  return facts;
}

/** Git state + parsed command outcomes, with no prose summarisation. */
export async function gatherCompressedJevEvidence(
  dir: string,
  receipts: string | undefined,
  spans: ClaimSpan[],
  budgetBytes: number = JEV_COMPRESSED_EVIDENCE_BUDGET_BYTES,
): Promise<string> {
  const [head, subject, ahead, status, diffNames, recent] = await Promise.all([
    execa("git", ["rev-parse", "--short=12", "HEAD"], { cwd: dir, reject: false }),
    execa("git", ["log", "-1", "--format=%s"], { cwd: dir, reject: false }),
    execa("git", ["rev-list", "--count", "@{u}..HEAD"], { cwd: dir, reject: false }),
    execa("git", ["status", "--porcelain"], { cwd: dir, reject: false }),
    execa("git", ["diff", "--name-only", "HEAD"], { cwd: dir, reject: false }),
    execa("git", ["log", "-3", "--format=@@%h%x09%s", "--name-only"], { cwd: dir, reject: false }),
  ]);
  const statusLines = (status.stdout ?? "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  const dirtyPaths = statusLines.map((line) => cleanField(line.slice(3), 160)).filter(Boolean);
  const diffPaths = (diffNames.stdout ?? "").split(/\r?\n/).map((line) => cleanField(line, 160)).filter(Boolean);
  const lines = [
    `git_head sha=${cleanField(head.stdout ?? "unknown", 16) || "unknown"} subject="${cleanField(subject.stdout ?? "")}"`,
    `git_state dirty=${statusLines.length > 0} upstream_ahead=${ahead.exitCode === 0 ? cleanField(ahead.stdout ?? "0", 12) : "unknown"}`,
    ...(dirtyPaths.length ? [`git_status paths=${dirtyPaths.slice(0, 20).join(",")}`] : []),
    ...(diffPaths.length ? [`git_uncommitted_diff paths=${diffPaths.slice(0, 20).join(",")}`] : []),
    ...recentCommitFacts(recent.stdout ?? ""),
  ];
  const gitFacts = withinBudget(lines, Math.min(budgetBytes, 900));
  const remaining = Math.max(0, budgetBytes - Buffer.byteLength(gitFacts, "utf8") - (gitFacts ? 1 : 0));
  const receiptFacts = receipts && remaining > 0 ? digestJevReceipts(receipts, spans, remaining).text : "";
  return withinBudget([gitFacts, receiptFacts].filter(Boolean), budgetBytes);
}

export async function buildCompressedJevInput(material: JevInputMaterial): Promise<JevTurnState> {
  const strongest = selectStrongestClaimSpans(detectLoadBearingClaims(material.finalMessage));
  return {
    userRequest: compressUserRequest(material.userRequest),
    finalMessage: renderClaimSpans(strongest),
    evidence: await gatherCompressedJevEvidence(material.dir, material.receipts, strongest),
  };
}

/** Build all three diets from identical fixture material for live Jev parity runs. */
export async function buildJevInputVariants(material: JevInputMaterial): Promise<JevInputVariants> {
  const spans = detectLoadBearingClaims(material.finalMessage);
  const strongest = selectStrongestClaimSpans(spans);
  const selected = selectJevEvidence(material.receipts ?? "", spans);
  const [fullEvidence, filteredEvidence, compressedEvidence] = await Promise.all([
    gatherFullJevEvidence(material.dir, material.receipts),
    gatherFullJevEvidence(material.dir, selected.text),
    gatherCompressedJevEvidence(material.dir, material.receipts, strongest),
  ]);
  return {
    full: { userRequest: material.userRequest, finalMessage: material.finalMessage, evidence: fullEvidence },
    filtered: { userRequest: material.userRequest, finalMessage: renderClaimSpans(spans), evidence: filteredEvidence },
    compressed: {
      userRequest: compressUserRequest(material.userRequest),
      finalMessage: renderClaimSpans(strongest),
      evidence: compressedEvidence,
    },
  };
}
