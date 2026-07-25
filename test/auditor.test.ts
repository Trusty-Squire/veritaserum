import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { tempRepo, write } from "./helpers.js";
import { audit, addressee, claimWarning, unaccountableWarning, groundingWarning, type AuditJob } from "../src/auditor.js";
import { selectEvidence, type EvidenceSelectionContext } from "../src/grounding.js";
import type { Auditor, AuditorTier } from "../src/resolve.js";
import type { Embedder } from "../src/embed.js";
import { readFirings, type Firing } from "../src/telemetry.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

async function repo(): Promise<string> {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  return dir;
}

interface Recording {
  calls: { prompt: string; dir: string }[];
}

/** Injected Auditor double — no CLI/network, records every prompt it was invoked with. */
function fakeAuditor(
  tier: AuditorTier,
  reply: string | ((prompt: string) => string),
  opts: Partial<Pick<Auditor, "vendor" | "sameFamily" | "model">> = {},
): Auditor & Recording {
  const calls: { prompt: string; dir: string }[] = [];
  return {
    tier,
    vendor: opts.vendor ?? (tier === "agentic" ? "codex" : "openrouter"),
    sameFamily: opts.sameFamily ?? false,
    ...(opts.model ? { model: opts.model } : {}),
    calls,
    async invoke(prompt: string, dir: string) {
      calls.push({ prompt, dir });
      return typeof reply === "function" ? reply(prompt) : reply;
    },
  };
}

/** A no-op Embedder — grounding fails open to zero flags without a live ollama.
 *  (Every returned vector is empty, so cosine() is 0 and nothing ever classes.) */
function nullEmbedder(): Embedder {
  return { async embed(texts: string[]): Promise<number[][]> { return texts.map(() => []); } };
}

const OK_REPLY = '{"claims":[],"unaccountable":false,"note":""}';

// CHANGE 1 (the gate): a benign message + the null embedder (grounding returns
// zero flags, zero load-bearing sentences, NO error) is now gate-eligible, so the
// LLM audit is SKIPPED by default. These legacy tests exercise prompt/parse/verdict
// behaviour that only happens when the LLM runs, so they force the run through the
// shadow path (rng() < shadowRate). New gate/shadow/evidence behaviour is covered
// by the dedicated describes at the bottom of this file.
const FORCE_RUN = { rng: () => 0 } as const;

function job(dir: string, overrides: Partial<AuditJob> = {}): AuditJob {
  return {
    dir,
    sessionId: "s1",
    finalMessage: "Done — implemented the thing.",
    userRequest: "implement the thing",
    ...overrides,
  };
}

// CHANGE 1: the colloquial direct-address warning templates, built once in
// auditor.ts and carried to every audience. One test per addressee and per
// verdict/rule line.
describe("warning templates — addressee resolution", () => {
  it("maps the executor vendor to the spoken name; anything else → Agent", () => {
    expect(addressee("claude")).toBe("Claude");
    expect(addressee("claude:sonnet")).toBe("Claude");
    expect(addressee("codex")).toBe("Codex");
    expect(addressee("codex:gpt-5.6")).toBe("Codex");
    expect(addressee("goose")).toBe("Agent");
    expect(addressee("unknown")).toBe("Agent");
    expect(addressee(undefined)).toBe("Agent");
  });
});

describe("warning templates — one humane line per verdict/rule", () => {
  const c = (verdict: "unsupported" | "contradicted", claim = "tests pass", basis = "no test run on record") => ({ claim, verdict, basis, evidence: "" });

  it("unsupported claim — direct address, basis as second clause", () => {
    expect(claimWarning("Claude", c("unsupported"))).toBe('Claude, you have no basis to claim "tests pass" — no test run on record.');
    expect(claimWarning("Codex", c("unsupported"))).toBe('Codex, you have no basis to claim "tests pass" — no test run on record.');
  });

  it("contradicted claim — the stronger 'evidence contradicts' phrasing (the red-severity signal)", () => {
    expect(claimWarning("Claude", c("contradicted"))).toBe('Claude, the evidence contradicts your claim "tests pass" — no test run on record.');
    // The phrase cli.ts keys severity color off must be present verbatim.
    expect(claimWarning("Agent", c("contradicted"))).toContain("the evidence contradicts your claim");
  });

  it("truncates a long claim to ~120 chars with … so the line stays one-line-ish", () => {
    const long = "x".repeat(200);
    const line = claimWarning("Claude", c("unsupported", long));
    expect(line).toContain("…");
    // the clipped claim is ≤ ~121 chars; the raw 200-char claim never appears whole
    expect(line).not.toContain("x".repeat(200));
  });

  it("R9 unaccountable — fixed phrasing, no basis clause", () => {
    expect(unaccountableWarning("Claude")).toBe("Claude, you did substantial work but reported nothing checkable — state what you did and how you know it works.");
    expect(unaccountableWarning("Agent")).toBe("Agent, you did substantial work but reported nothing checkable — state what you did and how you know it works.");
  });

  it("grounding rules — each QUOTES the flagged claim and keeps the flag's basis (and its demand) as the second clause", () => {
    // number-no-receipt's demand wording is deliberate and must SURVIVE — it is
    // passed through as the basis clause verbatim. Every rule now quotes the
    // flagged sentence (GroundingFlag.claim) so a reader can tell what was flagged.
    const demand = "cite the measurement or source that produced it, or state the number is illustrative.";
    expect(groundingWarning("Claude", "blocked-no-attempt", "no tool call attempted it", "The vault cannot be armed from the API.")).toBe('Claude, you called this blocked but never attempted it: "The vault cannot be armed from the API." — no tool call attempted it');
    expect(groundingWarning("Claude", "number-no-receipt", demand, "Throughput is 400,000/sec.")).toBe(`Claude, nothing you ran produced that number: "Throughput is 400,000/sec." — ${demand}`);
    expect(groundingWarning("Codex", "causal-no-referent", "nothing in the receipts is related to it", "The failures are caused by the rate limiter.")).toBe('Codex, you blamed a cause you never observed: "The failures are caused by the rate limiter." — nothing in the receipts is related to it');
    expect(groundingWarning("Agent", "scope-narrower", "enumerates only 3 item(s)", "Total across all wallets: $2.31.")).toBe('Agent, you reported a total the evidence doesn\'t fully cover: "Total across all wallets: $2.31." — enumerates only 3 item(s)');
    expect(groundingWarning("Claude", "state-no-receipt", "no commit receipt this session", "Committed the fix.")).toBe('Claude, you claimed a repo state you never verified: "Committed the fix." — no commit receipt this session');
  });

  it("truncates a long grounding claim to ~100 chars with …", () => {
    const long = "y".repeat(200);
    const line = groundingWarning("Claude", "blocked-no-attempt", "no attempt", long);
    expect(line).toContain("…");
    expect(line).not.toContain("y".repeat(200));
  });
});

describe("audit — agentic prompt content (SPEC §2 rules)", () => {
  it("instructs R9, the missing-proof rule for causal/state/measurement, and doc-as-stale-proof", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    expect(auditor.calls).toHaveLength(1);
    const prompt = auditor.calls[0]!.prompt;
    expect(prompt).toContain("R9 (unaccountable work)");
    expect(prompt).toContain("MISSING PROOF");
    expect(prompt).toContain("discriminating test");
    expect(prompt).toContain("may be stale");
    expect(prompt).toContain("HEAD");
    expect(prompt).toContain("READ-ONLY");
  });

  it("defines LOAD-BEARING sharply — not just confident, but something the user would act on", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    const prompt = auditor.calls[0]!.prompt;
    expect(prompt).toContain("RELY on it unexamined");
    expect(prompt).toContain("does not make a claim load-bearing");
    expect(prompt).toContain("the user is already their check");
  });

  it("carries the ABSTENTION, JUDGMENT, and FICTION protected-deliverable guards", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    const prompt = auditor.calls[0]!.prompt;
    // The confabulation-guard family: honest hedges, argued judgments, and requested
    // fiction are all the deliverable, never flagged for lacking a receipt.
    expect(prompt).toContain("ABSTENTION IS NOT CONFABULATION");
    expect(prompt).toContain("PREDICTIONS AND JUDGMENTS ARE NOT CONFABULATION");
    expect(prompt).toContain("REASONED INFERENCE IS NOT CONFABULATION");
    expect(prompt).toContain("FICTION IS NOT CONFABULATION");
    // The judgment guard keys on claim type (checkable now), not conversational genre.
    expect(prompt).toContain("neither possible nor expected");
    expect(prompt).toContain("flag only claims whose truth could have been checked");
    // The judgment guard audits cited evidence, never the opinion itself.
    expect(prompt).toContain("invented support, not opinion");
    // The inference guard flags concealment, never the act of inferring.
    expect(prompt).toContain("never the act of inferring");
    // The fiction guard still catches real-world assertions inside a creative turn.
    expect(prompt).toContain("REAL session/codebase/world");
  });

  it("passes the repo dir through to invoke (agentic auditors run their own probes there)", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    expect(auditor.calls[0]!.dir).toBe(dir);
  });
});

describe("audit — pre-gathered tier (degraded, completion-only)", () => {
  it("inlines gathered git evidence and says DEGRADED TIER", async () => {
    const dir = await repo();
    await write(dir, "a.txt", "x");
    await execa("git", ["add", "-A"], { cwd: dir });
    await execa("git", ["commit", "-q", "-m", "add a"], { cwd: dir });
    const auditor = fakeAuditor("pre-gathered", OK_REPLY, { vendor: "ollama", model: "qwen2.5:3b" });
    await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    const prompt = auditor.calls[0]!.prompt;
    expect(prompt).toContain("DEGRADED TIER");
    expect(prompt).toContain("git log -10");
    expect(prompt).toContain("add a");
  });

  it("includes the receipt tail when provided", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("pre-gathered", OK_REPLY);
    await audit(job(dir, { receipts: "ran: npm test -> exit 0" }), auditor, nullEmbedder(), FORCE_RUN);
    expect(auditor.calls[0]!.prompt).toContain("ran: npm test -> exit 0");
  });
});

describe("audit — verdict parsing never throws (R8)", () => {
  it("a non-JSON reply produces {error}, not a throw", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", "I refuse to answer in JSON, sorry.");
    const v = await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    expect(v.error).toBeTruthy();
    expect(v.claims).toEqual([]);
  });

  it("an auditor.invoke throw produces {error}, not a throw", async () => {
    const dir = await repo();
    const auditor: Auditor = {
      tier: "agentic",
      vendor: "codex",
      sameFamily: false,
      async invoke() {
        throw new Error("codex exec crashed");
      },
    };
    const v = await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    expect(v.error).toContain("codex exec crashed");
  });

  it("tier absent: no invocation attempted, error is auditor_absent (R8)", async () => {
    const dir = await repo();
    const auditor: Auditor = {
      tier: "absent",
      vendor: "none",
      sameFamily: false,
      async invoke() {
        throw new Error("should never be called");
      },
    };
    const v = await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    expect(v.error).toBe("auditor_absent");
    expect(v.claims).toEqual([]);
  });
});

describe("audit — R5 duplicate-warning suppression", () => {
  it("the same claim's warning is not repeated once it's in priorWarnings", async () => {
    const dir = await repo();
    const reply = '{"claims":[{"claim":"fixed the bug","verdict":"unsupported","basis":"no diff shows this change","evidence":""}],"unaccountable":false,"note":""}';
    const auditor = fakeAuditor("agentic", reply);
    const first = await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    // CHANGE 1 correction: the warning is now the colloquial direct-address line
    // (built once in auditor.ts), not the old coroner's-report `claim — verdict:
    // basis`. Default job has no executor → addressee "Agent".
    expect(first.warnings).toEqual(['Agent, you have no basis to claim "fixed the bug" — no diff shows this change.']);

    const second = await audit(job(dir, { priorWarnings: first.warnings }), auditor, nullEmbedder(), FORCE_RUN);
    expect(second.warnings).toEqual([]);
    // the claim verdict itself is still reported every run — only the warning repeats are suppressed.
    expect(second.claims[0]!.verdict).toBe("unsupported");
  });
});

describe("audit — R9 unaccountable work", () => {
  it("unaccountable:true from the auditor becomes a warning", async () => {
    const dir = await repo();
    const reply = '{"claims":[],"unaccountable":true,"note":"state what was done and how you know it works"}';
    const auditor = fakeAuditor("agentic", reply);
    const v = await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    expect(v.unaccountable).toBe(true);
    // CHANGE 1 correction: the R9 line is now fixed colloquial phrasing addressed
    // to the executor ("Agent" by default), not the old "unaccountable work: <note>".
    expect(v.warnings[0]).toContain("did substantial work but reported nothing checkable");
    expect(v.warnings[0]).toContain("state what you did and how you know it works");
  });
});

describe("audit — grounding tier folds into the verdict's warnings", () => {
  // A fake Embedder that classes the impossibility sentence as a BLOCKER and
  // every receipt/seed line as unrelated, so grounding.ts's blocked-no-attempt
  // rule fires — proving a grounding flag lands in verdict.warnings (never blocks).
  function groundingEmbedder(blockerSentence: string): Embedder {
    const BLOCKER = [1, 0];
    const OTHER = [0, 1];
    return {
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((t) => (t === blockerSentence || /can't be done|impossible|no way|locked|out of funds|blocked|frozen|no endpoint|denied|rejects all|app-only|cannot be automated/i.test(t) ? [...BLOCKER] : [...OTHER]));
      },
    };
  }

  it("a blocked-no-attempt grounding flag becomes a colloquial warning, verdict never blocks", async () => {
    const dir = await repo();
    const claim = "There is no way to arm the vault, so this cannot be automated.";
    const auditor = fakeAuditor("agentic", OK_REPLY);
    const v = await audit(
      job(dir, { finalMessage: claim, receipts: "> Bash {\"command\":\"git status\"}\n< clean" }),
      auditor,
      groundingEmbedder(claim),
    );
    // CHANGE 1 correction: grounding lines no longer carry a "grounding: <rule>"
    // prefix — the rule is conveyed by the humane phrasing addressed to the
    // executor ("Agent" by default). The flag's basis stays as the second clause.
    const groundingWarn = v.warnings.find((w) => w.includes("you called this blocked but never attempted it"));
    expect(groundingWarn).toBeDefined();
    expect(groundingWarn!.startsWith("Agent, ")).toBe(true);
    // R5: grounding flags are warnings only — nothing about the verdict blocks.
    expect(v.error).toBeUndefined();
  });

  it("fails open: a throwing embedder yields no grounding warning and never throws", async () => {
    const dir = await repo();
    const throwing: Embedder = { async embed(): Promise<number[][]> { throw new Error("ollama unreachable"); } };
    const auditor = fakeAuditor("agentic", OK_REPLY);
    // OK_REPLY has no claims and the embedder throws → grounding fails open to
    // zero flags, so there are no warnings at all (CHANGE 1: grounding lines no
    // longer share a "grounding: " prefix to key an absence check off).
    const v = await audit(job(dir, { finalMessage: "The funds are locked." }), auditor, throwing);
    expect(v.warnings).toEqual([]);
  });
});

describe("audit — telemetry (one event per audit)", () => {
  let tmpDir: string;
  let prevPath: string | undefined;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vs-audit-telemetry-"));
    prevPath = process.env.VS_TELEMETRY_PATH;
    process.env.VS_TELEMETRY_PATH = join(tmpDir, "telemetry.jsonl");
  });
  afterEach(async () => {
    if (prevPath === undefined) delete process.env.VS_TELEMETRY_PATH;
    else process.env.VS_TELEMETRY_PATH = prevPath;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("logs one 'audit' event with the v3 fields populated", async () => {
    const dir = await repo();
    const reply =
      '{"claims":[{"claim":"x","verdict":"unsupported","basis":"y","evidence":"z"}],"unaccountable":false,"note":""}';
    const auditor = fakeAuditor("agentic", reply, { vendor: "codex", sameFamily: true });
    await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);

    const firings: Firing[] = readFirings();
    expect(firings).toHaveLength(1);
    const f = firings[0]!;
    expect(f.event).toBe("audit");
    expect(f.blocked).toBe(false); // R5: audit never blocks by default
    expect(f.auditor_tier).toBe("same_family"); // sameFamily tags override the raw tier for telemetry
    expect(f.verdict_basis).toBe("probe"); // a claim carries evidence
    expect(f.scheduling_mode).toBe("live");
    expect(typeof f.vague_turn).toBe("boolean");
  });

  it("tags auditor_tier 'absent' when the auditor is unavailable", async () => {
    const dir = await repo();
    const auditor: Auditor = { tier: "absent", vendor: "none", sameFamily: false, async invoke() { throw new Error("x"); } };
    await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    const firings = readFirings();
    expect(firings[0]!.auditor_tier).toBe("absent");
  });
});

// ---------------------------------------------------------------------------
// CHANGE 1/2 helpers — a deterministic classifier embedder (orthonormal class
// directions, mirroring test/grounding.test.ts) so an audit test can drive the
// grounding gate/selection without a live ollama.
// ---------------------------------------------------------------------------
const CDIR = {
  BLOCKER: [1, 0, 0, 0, 0],
  CAUSAL: [0, 1, 0, 0, 0],
  SETTLED: [0, 0, 1, 0, 0],
  NEUTRAL: [0, 0, 0, 1, 0],
  HEDGED: [0, 0, 0, 0, 1],
} as const;
function cclassVec(text: string): number[] {
  const t = text.toLowerCase();
  if (/\b(might|maybe|possibly|roughly|not sure|verify|benchmark|measure|depends on)\b/.test(t)) return [...CDIR.HEDGED];
  if (/\b(impossible|locked|out of (funds|money)|no way|blocked|frozen|no endpoint|denied|cannot be automated)\b/.test(t))
    return [...CDIR.BLOCKER];
  if (/\b(caused by|because of|bottleneck|root cause|due to|stems from|responsible for|reason)\b|rate limit/.test(t))
    return [...CDIR.CAUSAL];
  if (/\d/.test(t) || /tests?\s+pass/.test(t) || /\b(commit|committed|push|pushed|implemented|fixed|added|refactored|updated)\b/.test(t))
    return [...CDIR.SETTLED];
  return [...CDIR.NEUTRAL];
}
function classEmbedder(overrides: Record<string, keyof typeof CDIR> = {}): Embedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => (t in overrides ? [...CDIR[overrides[t]!]] : cclassVec(t)));
    },
  };
}

describe("audit — CHANGE 1: the gate (skips the no-claim 81%)", () => {
  let tmpDir: string;
  let prevPath: string | undefined;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vs-gate-telemetry-"));
    prevPath = process.env.VS_TELEMETRY_PATH;
    process.env.VS_TELEMETRY_PATH = join(tmpDir, "telemetry.jsonl");
  });
  afterEach(async () => {
    if (prevPath === undefined) delete process.env.VS_TELEMETRY_PATH;
    else process.env.VS_TELEMETRY_PATH = prevPath;
    await rm(tmpDir, { recursive: true, force: true });
  });

  const lastFiring = (): Firing => {
    const fs = readFirings();
    return fs[fs.length - 1]!;
  };

  it("a neutral-chat message → LLM NOT invoked; telemetry gated:'skipped', note 'no-claim (gated)'", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    // NEUTRAL message, null embedder → zero flags, zero load-bearing, no error →
    // gate-eligible. rng ≥ shadowRate → NOT sampled → the LLM audit is skipped.
    const v = await audit(
      job(dir, { finalMessage: "Thanks, that all makes sense to me." }),
      auditor,
      nullEmbedder(),
      { rng: () => 0.99 },
    );
    expect(auditor.calls).toHaveLength(0); // the whole point: no LLM invocation
    expect(v.claims).toEqual([]);
    expect(v.note).toBe("no-claim (gated)");
    expect(v.error).toBeUndefined();
    expect(lastFiring().gated).toBe("skipped");
  });

  it("a load-bearing blocker sentence → FULL audit (gate never skips a claim)", async () => {
    const dir = await repo();
    const claim = "There is no way to arm the vault, so this cannot be automated.";
    const auditor = fakeAuditor("agentic", OK_REPLY);
    const v = await audit(
      job(dir, { finalMessage: claim, receipts: '> Bash {"command":"git status"}\n< clean' }),
      auditor,
      classEmbedder({ [claim]: "BLOCKER" }),
      { rng: () => 0.99 }, // even with no shadow, a load-bearing turn is not gate-eligible
    );
    expect(auditor.calls).toHaveLength(1);
    expect(v.error).toBeUndefined();
    expect(lastFiring().gated).toBe("full");
  });

  it("embedder throws → grounding error → FULL audit (fail-open: a gate failure never skips)", async () => {
    const dir = await repo();
    const throwing: Embedder = { async embed(): Promise<number[][]> { throw new Error("ollama down"); } };
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(job(dir, { finalMessage: "Thanks, that all makes sense." }), auditor, throwing, { rng: () => 0.99 });
    expect(auditor.calls).toHaveLength(1);
    expect(lastFiring().gated).toBe("full");
  });

  it("injected RNG forces the shadow sample → LLM IS invoked, telemetry gated:'shadow'", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(
      job(dir, { finalMessage: "Thanks, that all makes sense." }),
      auditor,
      nullEmbedder(),
      { rng: () => 0 }, // 0 < shadowRate → sampled
    );
    expect(auditor.calls).toHaveLength(1);
    expect(lastFiring().gated).toBe("shadow");
  });

  it("a shadow audit that finds a substantive verdict sets gate_missed:true", async () => {
    const dir = await repo();
    const reply = '{"claims":[{"claim":"tests pass","verdict":"unsupported","basis":"no run","evidence":""}],"unaccountable":false,"note":""}';
    const auditor = fakeAuditor("agentic", reply);
    await audit(
      job(dir, { finalMessage: "Thanks, all good." }),
      auditor,
      nullEmbedder(),
      { rng: () => 0 }, // force the shadow sample
    );
    expect(auditor.calls).toHaveLength(1);
    const f = lastFiring();
    expect(f.gated).toBe("shadow");
    expect(f.gate_missed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CHANGE 2: claim-conditioned evidence selection. Receipts crafted so the always-
// keep families (numeric match, test/build/commit/push signatures, recency tail)
// are separable from droppable noise, and the budget forces elision.
// ---------------------------------------------------------------------------
function bigReceipts(): string {
  const lines: string[] = [
    '> Bash {"command":"pnpm test"}',
    "< Tests 12 passed (12) SIGTOKEN",
    '> Bash {"command":"bench throughput"}',
    "< throughput 400000 ops measured NUMTOKEN",
    "< MIDNOISE_EARLY alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima",
  ];
  // ~38 digit-free filler lines (~100 bytes each ≈ 3.8KB) so the numeric/signature
  // lines sit well outside the 2KB recency tail and the middle noise is elided.
  for (let i = 0; i < 38; i++) {
    lines.push(`< filler line ${"x".repeat(0)} mike november oscar papa quebec romeo sierra tango uniform tag${String.fromCharCode(97 + (i % 26))}${i}`);
  }
  lines.push("< end of run TAILTOKEN zulu final receipt line marker");
  return lines.join("\n");
}

describe("audit — CHANGE 2: claim-conditioned evidence selection", () => {
  let prevBudget: string | undefined;
  beforeEach(() => {
    prevBudget = process.env.VS_EVIDENCE_BUDGET_KB;
  });
  afterEach(() => {
    if (prevBudget === undefined) delete process.env.VS_EVIDENCE_BUDGET_KB;
    else process.env.VS_EVIDENCE_BUDGET_KB = prevBudget;
  });

  const claim = "Throughput is 400000 per second.";

  it("keeps the claim's number, the test-run signature, and the recency tail; drops the noise; marks elisions", async () => {
    process.env.VS_EVIDENCE_BUDGET_KB = "1"; // 1KB → forces heavy elision
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(
      job(dir, { finalMessage: claim, receipts: bigReceipts() }),
      auditor,
      classEmbedder({ [claim]: "SETTLED" }),
      { rng: () => 0.99 },
    );
    const prompt = auditor.calls[0]!.prompt;
    expect(prompt).toContain("400000 ops measured"); // (a) claim number's line survives mid-stream
    expect(prompt).toContain("12 passed"); // (b) test-run signature line survives
    expect(prompt).toContain("TAILTOKEN"); // (c) recency tail survives
    expect(prompt).not.toContain("MIDNOISE_EARLY"); // noise dropped
    expect(prompt).toContain("elided by relevance selection"); // elision marker present
    expect(prompt).toContain("RELEVANCE-SELECTED excerpt"); // the auditor is told it's a selection
  });

  it("records evidence_bytes below the full tail (budget respected)", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "vs-ev-telemetry-"));
    const prevPath = process.env.VS_TELEMETRY_PATH;
    process.env.VS_TELEMETRY_PATH = join(tmpDir, "telemetry.jsonl");
    process.env.VS_EVIDENCE_BUDGET_KB = "1";
    try {
      const dir = await repo();
      const receipts = bigReceipts();
      const auditor = fakeAuditor("agentic", OK_REPLY);
      await audit(job(dir, { finalMessage: claim, receipts }), auditor, classEmbedder({ [claim]: "SETTLED" }), { rng: () => 0.99 });
      const fs = readFirings();
      const f = fs[fs.length - 1]!;
      expect(typeof f.evidence_bytes).toBe("number");
      expect(f.evidence_bytes!).toBeGreaterThan(0);
      expect(f.evidence_bytes!).toBeLessThan(Buffer.byteLength(receipts, "utf8"));
    } finally {
      if (prevPath === undefined) delete process.env.VS_TELEMETRY_PATH;
      else process.env.VS_TELEMETRY_PATH = prevPath;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("full tail fits the budget → shipped verbatim, no elision, no selection note", async () => {
    process.env.VS_EVIDENCE_BUDGET_KB = "64"; // generous → the small tail fits whole
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(
      job(dir, { finalMessage: claim, receipts: bigReceipts() }),
      auditor,
      classEmbedder({ [claim]: "SETTLED" }),
      { rng: () => 0.99 },
    );
    const prompt = auditor.calls[0]!.prompt;
    expect(prompt).toContain("MIDNOISE_EARLY"); // nothing dropped
    expect(prompt).not.toContain("elided by relevance selection");
    expect(prompt).not.toContain("RELEVANCE-SELECTED excerpt");
  });

  it("FAIL-OPEN: a throwing selector → the full tail is shipped (more evidence, never less)", async () => {
    process.env.VS_EVIDENCE_BUDGET_KB = "1";
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(
      job(dir, { finalMessage: claim, receipts: bigReceipts() }),
      auditor,
      classEmbedder({ [claim]: "SETTLED" }),
      { rng: () => 0.99, selectEvidence: () => { throw new Error("selection boom"); } },
    );
    const prompt = auditor.calls[0]!.prompt;
    expect(prompt).toContain("MIDNOISE_EARLY"); // full tail, not the selected excerpt
    expect(prompt).not.toContain("elided by relevance selection");
  });
});

describe("selectEvidence — unit (pure, reuses precomputed vectors)", () => {
  const REL = [1, 0]; // aligned with the claim vector
  const IRREL = [0, 1]; // orthogonal to the claim vector
  const ctx = (lines: Array<{ text: string; vec: number[] }>, claimNumbers: number[] = []): EvidenceSelectionContext => ({
    claimVectors: [[1, 0]],
    claimNumbers,
    receiptLines: lines,
  });

  it("whole tail under budget → returned verbatim, elided 0", () => {
    const lines = [
      { text: "> Read a.ts", vec: IRREL },
      { text: "< contents", vec: IRREL },
    ];
    const r = selectEvidence(ctx(lines), 64 * 1024);
    expect(r.text).toBe("> Read a.ts\n< contents");
    expect(r.elided).toBe(0);
  });

  it("over budget → keeps a numeric-match line and a signature line, elides orthogonal noise, shrinks bytes", () => {
    // A bounding call line after the signature result stops the signature block
    // (it keeps following RESULT lines only until the next call) — otherwise a
    // synthetic tail of pure result lines would be swallowed whole.
    const noise = Array.from({ length: 60 }, (_, i) => ({ text: `< noise line padding padding padding ${String.fromCharCode(97 + (i % 26))}${i}`, vec: IRREL }));
    const lines = [
      { text: '> Bash {"command":"git commit -m x"}', vec: IRREL }, // signature call
      { text: "< [main abc1234] x", vec: IRREL }, // its result (kept with the block)
      { text: '> Bash {"command":"cat balance"}', vec: IRREL }, // bounding call (ends the block)
      { text: "< the balance is 2.31 usd", vec: IRREL }, // numeric match (2.31)
      ...noise,
      { text: "< tail keeper line", vec: IRREL },
    ];
    const full = lines.map((l) => l.text).join("\n");
    const r = selectEvidence(ctx(lines, [2.31]), 512); // tiny budget
    expect(r.text).toContain("git commit"); // signature call kept
    expect(r.text).toContain("[main abc1234]"); // signature result kept
    expect(r.text).toContain("balance is 2.31"); // numeric-match line kept
    expect(r.text).toContain("tail keeper line"); // recency tail kept
    expect(r.text).toContain("elided by relevance selection"); // noise collapsed
    expect(r.elided).toBeGreaterThan(0);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThan(Buffer.byteLength(full, "utf8"));
  });

  it("cosine fill prefers relevant lines over orthogonal ones within the budget", () => {
    // One relevant line at the TOP (outside the ~2KB recency tail), buried among
    // many orthogonal ones. Receipts exceed the tail and the budget exceeds the
    // tail, so the fill step runs and — ranking by cosine — must add the relevant
    // line (cosine 1) before any noise (cosine 0).
    const noise = Array.from({ length: 120 }, (_, i) => ({ text: `< irrelevant padding padding padding ${i}`, vec: IRREL }));
    const relevant = { text: "< RELEVANT the load-bearing detail lives here", vec: REL };
    const lines = [relevant, ...noise];
    const r = selectEvidence(ctx(lines), 3 * 1024); // > 2KB tail, < full → fill has room
    expect(r.text).toContain("RELEVANT the load-bearing detail"); // relevance beat the noise
    expect(r.elided).toBeGreaterThan(0); // and some noise was genuinely dropped
  });
});
