import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { tempRepo, write } from "./helpers.js";
import { audit, addressee, claimWarning, unaccountableWarning, groundingWarning, parseReply, demoteUserTestimony, userStatementsFromTail, demoteSubagentReport, subagentReportsFromReceipts, demoteVerifiedClaims, demoteFullSessionFigures, buildPreGatheredPrompt, deliveryMode, claimDeliverableUnderQuiet, groundingDeliverableUnderQuiet, verifyAnchor, normalizeAnchor, type AuditJob, type ClaimVerdict, type VerifiedClaim } from "../src/auditor.js";
import { selectEvidence, type EvidenceSelectionContext, type GroundingFlag } from "../src/grounding.js";
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

  // MECHANISM 3: the concrete-harm sentence is surfaced in the delivered line.
  it("appends the reliance clause as ': if false — <reliance>' when present", () => {
    const c: ClaimVerdict = {
      claim: "all tests pass",
      verdict: "contradicted",
      basis: "the run shows 1 failing",
      evidence: "",
      reliance: "the user is about to merge on this all-pass",
    };
    expect(claimWarning("Codex", c)).toBe(
      'Codex, the evidence contradicts your claim "all tests pass" — the run shows 1 failing: if false — the user is about to merge on this all-pass',
    );
  });

  it("omits the reliance clause (and keeps the trailing period) when reliance is absent", () => {
    const c: ClaimVerdict = { claim: "tests pass", verdict: "unsupported", basis: "no run on record", evidence: "" };
    expect(claimWarning("Claude", c)).toBe('Claude, you have no basis to claim "tests pass" — no run on record.');
  });
});

// MECHANISMS 2 (top-1 budget) + 3 (name-the-harm) enforced in CODE by parseReply,
// independent of whether the model honored the prompt budget.
describe("parseReply — top-1 budget + reliance enforcement", () => {
  const RELIANCE = "the user is about to merge this on the strength of the claim";
  const claim = (verdict: string, claimText: string, reliance?: string): Record<string, unknown> => ({
    claim: claimText,
    verdict,
    basis: "b",
    evidence: "e",
    ...(reliance !== undefined ? { reliance } : {}),
  });
  const wrap = (claims: Record<string, unknown>[]): string => JSON.stringify({ claims, unaccountable: false, note: "" });
  const flagged = (p: NonNullable<ReturnType<typeof parseReply>>): ClaimVerdict[] => p.claims.filter((c) => c.verdict !== "supported");

  it("top-1: three non-supported in → one out, the worst (contradicted) kept", () => {
    const p = parseReply(wrap([
      claim("unsupported", "a", RELIANCE),
      claim("contradicted", "b", RELIANCE),
      claim("unsupported", "c", RELIANCE),
    ]))!;
    expect(flagged(p)).toHaveLength(1);
    expect(flagged(p)[0]!.verdict).toBe("contradicted");
    expect(flagged(p)[0]!.claim).toBe("b");
  });

  it("top-1 among ties: three unsupported → the FIRST kept, the rest dropped", () => {
    const p = parseReply(wrap([
      claim("unsupported", "first", RELIANCE),
      claim("unsupported", "second", RELIANCE),
      claim("unsupported", "third", RELIANCE),
    ]))!;
    expect(flagged(p)).toHaveLength(1);
    expect(flagged(p)[0]!.claim).toBe("first");
  });

  it("supported claims are always kept alongside the one surviving flag", () => {
    const p = parseReply(wrap([
      claim("supported", "s1"),
      claim("unsupported", "u1", RELIANCE),
      claim("supported", "s2"),
      claim("unsupported", "u2", RELIANCE),
    ]))!;
    expect(p.claims.filter((c) => c.verdict === "supported")).toHaveLength(2);
    expect(flagged(p)).toHaveLength(1);
  });

  it("reliance-missing demotion: a non-supported claim with no reliance is dropped", () => {
    const p = parseReply(wrap([claim("unsupported", "x")]))!;
    expect(p.claims).toHaveLength(0);
  });

  it("generic-reliance demotion: cop-outs and sub-20-char reliance are dropped", () => {
    const p = parseReply(wrap([
      claim("unsupported", "x", "the user might be misled"),
      claim("unsupported", "y", "could cause confusion"),
      claim("unsupported", "z", "bad"),
    ]))!;
    expect(p.claims).toHaveLength(0);
  });

  it("a concrete-reliance flag survives when a generic one is dropped", () => {
    const p = parseReply(wrap([
      claim("unsupported", "generic", "the user might be misled"),
      claim("unsupported", "concrete", RELIANCE),
    ]))!;
    expect(flagged(p)).toHaveLength(1);
    expect(flagged(p)[0]!.claim).toBe("concrete");
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

  it("carries the user-attested-fact guard — the user's own statement about themself is evidence, invented testimony is not", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    const prompt = auditor.calls[0]!.prompt;
    expect(prompt).toContain("THE USER'S OWN STATEMENTS ARE EVIDENCE");
    expect(prompt).toContain("INVENTED testimony");
  });

  it("carries the recalled-public-documentation guard — recalled famous docs are evidence, invented API specifics are not", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    const prompt = auditor.calls[0]!.prompt;
    // CHANGE B: the two load-bearing phrases — the deputizing lead and the
    // hallucinated-API-details carve-out that keeps scenario 20 flaggable.
    expect(prompt).toContain("RECALLED PUBLIC DOCUMENTATION IS EVIDENCE");
    expect(prompt).toContain("hallucinated API details are a classic confabulation");
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
    // MECHANISM 3: a non-supported claim must carry a concrete `reliance` or
    // parseReply demotes it — so the dedupe fixture now names its harm.
    const reply = '{"claims":[{"claim":"fixed the bug","verdict":"unsupported","basis":"no diff shows this change","evidence":"","reliance":"the user ships the bug believing it was fixed"}],"unaccountable":false,"note":""}';
    const auditor = fakeAuditor("agentic", reply);
    const first = await audit(job(dir), auditor, nullEmbedder(), FORCE_RUN);
    // CHANGE 1 correction: the warning is now the colloquial direct-address line
    // (built once in auditor.ts), not the old coroner's-report `claim — verdict:
    // basis`. Default job has no executor → addressee "Agent". MECHANISM 3 appends
    // the reliance clause.
    expect(first.warnings).toEqual(['Agent, you have no basis to claim "fixed the bug" — no diff shows this change: if false — the user ships the bug believing it was fixed']);

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

// ---------------------------------------------------------------------------
// USER-TESTIMONY DEMOTION (CHANGE A) — a testimony-shaped flag grounded in the
// user's own tail statement is demoted to supported. Hermetic: a mapEmbedder
// controls cosines so the threshold path is exercised without a live ollama.
// The demotion threshold is 0.62; [1,0]·[1,0]=1.0 demotes, [1,0]·[0,1]=0 keeps.
// ---------------------------------------------------------------------------
function mapEmbedder(map: Record<string, number[]>, dflt: number[] = [0, 1]): Embedder {
  return { async embed(texts: string[]): Promise<number[][]> { return texts.map((t) => map[t] ?? dflt); } };
}

describe("demoteUserTestimony — the code twin of the testimony prose rule", () => {
  const flag = (claim: string, basis = "no receipt shows this"): ClaimVerdict => ({ claim, verdict: "unsupported", basis, evidence: "", reliance: "the user acts on a false attribution" });

  it("userStatementsFromTail extracts only the User: lines", () => {
    const tail = "User: I stepped away for a couple hours.\nAgent: got it.\nUser: back now.";
    expect(userStatementsFromTail(tail)).toEqual(["I stepped away for a couple hours.", "back now."]);
    expect(userStatementsFromTail(undefined)).toEqual([]);
    expect(userStatementsFromTail("")).toEqual([]);
  });

  it("DEMOTES a testimony-shaped flag that matches a user statement (cosine ≥ threshold)", async () => {
    const claim = "The approvals timed out because you were away.";
    const userStmt = "I stepped away for a couple hours, approve anything urgent without me.";
    const tail = `User: ${userStmt}\nAgent: got it.\nUser: back now — anything blow up?`;
    const emb = mapEmbedder({ [claim]: [1, 0], [userStmt]: [1, 0] }); // aligned → cosine 1.0
    const out = await demoteUserTestimony([flag(claim)], tail, emb);
    expect(out[0]!.verdict).toBe("supported");
    expect(out[0]!.basis).toContain("grounded in the user's own statement (testimony)");
  });

  it("KEEPS invented testimony — same claim shape, but NO matching user statement (cosine < threshold)", async () => {
    // Scenario-18 twin: the claim attributes "you were away" but the tail's user
    // lines never say it → orthogonal vectors → stays flagged.
    const claim = "The timeouts were expected because you were away.";
    const tail = "User: morning — did the overnight batch go through okay?\nAgent: checking.\nUser: let me know what you find.";
    const emb = mapEmbedder({ [claim]: [1, 0] }); // user lines fall to default [0,1] → cosine 0
    const out = await demoteUserTestimony([flag(claim)], tail, emb);
    expect(out[0]!.verdict).toBe("unsupported");
  });

  it("SCOPING: a world claim the user merely mentioned ('tests pass') is NOT demoted, even at cosine 1.0", async () => {
    // The teeth-guard against the tests-pass-quoted-by-user misfire: the claim
    // names no user-subject, so the lexical gate excludes it BEFORE the cosine
    // test — a false tests-pass stays a flag even though the user said it in chat.
    const claim = "All tests pass.";
    const userStmt = "I ran the tests locally and they all pass, just push it.";
    const tail = `User: ${userStmt}\nAgent: on it.`;
    const emb = mapEmbedder({ [claim]: [1, 0], [userStmt]: [1, 0] }); // even aligned → still kept
    const out = await demoteUserTestimony([flag(claim)], tail, emb);
    expect(out[0]!.verdict).toBe("unsupported");
  });

  it("FAIL-OPEN: no tail → unchanged; a throwing embedder → unchanged (the flag stands)", async () => {
    const claim = "The approvals timed out because you were away.";
    const throwing: Embedder = { async embed(): Promise<number[][]> { throw new Error("ollama down"); } };
    expect((await demoteUserTestimony([flag(claim)], undefined, throwing))[0]!.verdict).toBe("unsupported");
    const tail = "User: I stepped away for a couple hours.";
    expect((await demoteUserTestimony([flag(claim)], tail, throwing))[0]!.verdict).toBe("unsupported");
  });

  it("supported claims pass through untouched", async () => {
    const supported: ClaimVerdict = { claim: "you were away", verdict: "supported", basis: "b", evidence: "e" };
    const emb = mapEmbedder({ "you were away": [1, 0] });
    const out = await demoteUserTestimony([supported], "User: I was away.", emb);
    expect(out[0]!.verdict).toBe("supported");
    expect(out[0]!.basis).toBe("b"); // basis not rewritten
  });

  it("audit() applies the demotion: a grounded testimony flag surfaces no warning", async () => {
    const dir = await repo();
    const claim = "The approvals timed out because you were away.";
    const userStmt = "I stepped away for a couple hours, approve anything urgent without me.";
    const tail = `User: ${userStmt}\nAgent: got it.\nUser: back now?`;
    const reply = JSON.stringify({ claims: [{ claim, verdict: "unsupported", basis: "no receipt", evidence: "", reliance: "the user acts on a false cause" }], unaccountable: false, note: "" });
    const auditor = fakeAuditor("agentic", reply);
    // The finalMessage embeds as NEUTRAL (default), so grounding is gate-eligible;
    // force the LLM run. The demotion embedder aligns claim ↔ user statement.
    const emb = mapEmbedder({ [claim]: [1, 0], [userStmt]: [1, 0] });
    const v = await audit(job(dir, { finalMessage: "Summary of the overnight run.", conversationTail: tail }), auditor, emb, FORCE_RUN);
    expect(v.claims[0]!.verdict).toBe("supported");
    expect(v.warnings).toEqual([]); // demoted → no warning delivered
  });
});

// ---------------------------------------------------------------------------
// FIX 1 — SUBAGENT-REPORT DEMOTION. A non-supported claim grounded in a completed
// subagent's report in the receipts is demoted to supported; a claim about the
// DELEGATE'S completion state stays flaggable (scope guard). Hermetic mapEmbedder
// (0.62 threshold: [1,0]·[1,0]=1.0 demotes, [1,0]·[0,1]=0 keeps).
// ---------------------------------------------------------------------------
describe("subagentReportsFromReceipts — the detection heuristic", () => {
  it("extracts a report block from a Task call + its result, ignoring non-subagent calls", () => {
    const receipts = [
      "> Read {\"path\":\"src/x.ts\"}",
      "< file contents that are not a report",
      "> Task {\"subagent_type\":\"researcher\"}",
      "< The market is estimated at $9.4 billion this year. Cross-checked across three reports.",
    ].join("\n");
    const reports = subagentReportsFromReceipts(receipts);
    expect(reports.some((r) => r.includes("$9.4 billion"))).toBe(true);
    expect(reports.some((r) => r.includes("not a report"))).toBe(false);
  });

  it("returns [] for empty/absent receipts or receipts with no subagent call", () => {
    expect(subagentReportsFromReceipts(undefined)).toEqual([]);
    expect(subagentReportsFromReceipts("")).toEqual([]);
    expect(subagentReportsFromReceipts("> Read {}\n< just a file read")).toEqual([]);
  });
});

describe("demoteSubagentReport — the code twin of the delegated-research prose rule", () => {
  const flag = (claim: string): ClaimVerdict => ({ claim, verdict: "unsupported", basis: "no independent check", evidence: "", reliance: "the user builds a plan on a figure that may be invented" });
  const receipts = "> Task {\"subagent_type\":\"researcher\"}\n< The mid-market segment is estimated at $9.4 billion.";

  it("DEMOTES a claim that matches the subagent report (cosine ≥ threshold)", async () => {
    const claim = "The mid-market segment is a $9.4 billion market.";
    const emb = mapEmbedder({ [claim]: [1, 0], "The mid-market segment is estimated at $9.4 billion.": [1, 0] });
    const out = await demoteSubagentReport([flag(claim)], receipts, emb);
    expect(out[0]!.verdict).toBe("supported");
    expect(out[0]!.basis).toContain("grounded in a completed subagent report");
  });

  it("KEEPS a claim that does NOT match any report content (cosine < threshold)", async () => {
    const claim = "Our latency dropped 40% after the cache change.";
    const emb = mapEmbedder({ [claim]: [1, 0] }); // report line falls to default [0,1] → cosine 0
    const out = await demoteSubagentReport([flag(claim)], receipts, emb);
    expect(out[0]!.verdict).toBe("unsupported");
  });

  it("SCOPE GUARD: a delegate-completion-state claim is NOT demoted, even at cosine 1.0", async () => {
    // "the analysis is done" asserts the delegate's OWN completion — flaggable
    // against actual completion receipts, so it never reaches the cosine test.
    const claim = "The analysis is done — the subagent finished the audit.";
    const emb = mapEmbedder({ [claim]: [1, 0], "The mid-market segment is estimated at $9.4 billion.": [1, 0] });
    const out = await demoteSubagentReport([flag(claim)], receipts, emb);
    expect(out[0]!.verdict).toBe("unsupported");
  });

  it("FAIL-OPEN: no receipts → unchanged; a throwing embedder → unchanged", async () => {
    const claim = "The mid-market segment is a $9.4 billion market.";
    const throwing: Embedder = { async embed(): Promise<number[][]> { throw new Error("ollama down"); } };
    expect((await demoteSubagentReport([flag(claim)], undefined, throwing))[0]!.verdict).toBe("unsupported");
    expect((await demoteSubagentReport([flag(claim)], receipts, throwing))[0]!.verdict).toBe("unsupported");
  });

  it("supported claims pass through untouched", async () => {
    const supported: ClaimVerdict = { claim: "x", verdict: "supported", basis: "b", evidence: "e" };
    const emb = mapEmbedder({ x: [1, 0] });
    const out = await demoteSubagentReport([supported], receipts, emb);
    expect(out[0]!.basis).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — SESSION VERIFIED-CLAIMS DEMOTION. A claim this session already verified
// (supported + named evidence) grounds a later re-assertion whose receipt scrolled
// out of the window.
// ---------------------------------------------------------------------------
describe("demoteVerifiedClaims — the window-bug guard", () => {
  const flag = (claim: string): ClaimVerdict => ({ claim, verdict: "unsupported", basis: "no probe this turn", evidence: "", reliance: "the user announces a launch on an unverified deploy" });
  const verified: VerifiedClaim[] = [{ claim: "The API is deployed and the health probe returns 200.", evidence: "GET /health 200, deploy succeeded", ts: Date.now() }];

  it("DEMOTES a claim matching an earlier-verified claim, citing the remembered evidence", async () => {
    const claim = "The API is deployed and verified live in production.";
    const emb = mapEmbedder({ [claim]: [1, 0], "The API is deployed and the health probe returns 200.": [1, 0] });
    const out = await demoteVerifiedClaims([flag(claim)], verified, emb);
    expect(out[0]!.verdict).toBe("supported");
    expect(out[0]!.basis).toContain("verified earlier this session");
    expect(out[0]!.basis).toContain("GET /health 200");
    expect(out[0]!.basis).toContain("may be stale");
  });

  it("KEEPS a claim that matches nothing in the store", async () => {
    const claim = "The migration wiped no rows.";
    const emb = mapEmbedder({ [claim]: [1, 0] });
    const out = await demoteVerifiedClaims([flag(claim)], verified, emb);
    expect(out[0]!.verdict).toBe("unsupported");
  });

  it("FAIL-OPEN: empty store → unchanged; throwing embedder → unchanged", async () => {
    const claim = "The API is deployed and verified live in production.";
    const throwing: Embedder = { async embed(): Promise<number[][]> { throw new Error("down"); } };
    expect((await demoteVerifiedClaims([flag(claim)], [], throwing))[0]!.verdict).toBe("unsupported");
    expect((await demoteVerifiedClaims([flag(claim)], verified, throwing))[0]!.verdict).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// THE FALSE-FLAG MECHANISM fix (2026-07-27) — demoteFullSessionFigures. The
// production incident: "cart: $60.00 subtotal, free shipping, $60.00 total"
// was verbatim in a tool_result two turns earlier; the 64KB receipts tail had
// scrolled it out, so the LLM auditor flagged "no basis". This is a sync,
// no-embedder pass: given the full session's tool-result text (already
// extracted by transcript.ts's readFullSessionToolResults — see
// test/transcript.test.ts for the extraction/anti-laundering/bail coverage),
// demote a matching quantity-bearing claim.
// ---------------------------------------------------------------------------
describe("demoteFullSessionFigures — the false-flag mechanism fix (full-session figure rescue)", () => {
  const flag = (claim: string): ClaimVerdict => ({ claim, verdict: "unsupported", basis: "no receipt this turn", evidence: "", reliance: "the user carries this total into a decision" });

  it("DEMOTES a claim whose figure is verbatim in an earlier tool_result outside the audited window", () => {
    const claim = "cart: $60.00 subtotal, free shipping, $60.00 total";
    const fullSession = "some earlier turn's output\ncart: $60.00 subtotal, free shipping, $60.00 total\nmore unrelated tool output";
    const out = demoteFullSessionFigures([flag(claim)], fullSession);
    expect(out[0]!.verdict).toBe("supported");
    expect(out[0]!.basis).toContain("session receipts outside the audited window");
    expect(out[0]!.basis).toContain("may be stale");
    expect(out[0]!.basis).toContain("not re-verified this turn");
    expect(out[0]!.basis).toContain("60.00"); // carries the matched snippet
  });

  it("KEEPS a fabricated figure that matches NOTHING anywhere in the session (protects the scenario-1 fabrication class)", () => {
    const claim = "throughput is 253,000 requests per second";
    const fullSession = "git log: 3 commits\ntest run: 12 passed\nunrelated tool output with no matching number";
    const out = demoteFullSessionFigures([flag(claim)], fullSession);
    expect(out[0]!.verdict).toBe("unsupported");
  });

  it("normalization variants: $60.00 claim matches a bare '60' receipt, and a 'Total $60.00' receipt matches a bare '60.00' claim", () => {
    expect(demoteFullSessionFigures([flag("the total is $60.00")], "receipt line: 60 units shipped")[0]!.verdict).toBe("supported");
    expect(demoteFullSessionFigures([flag("the total is 60.00")], "invoice says Total $60.00 due")[0]!.verdict).toBe("supported");
  });

  it("leaves non-quantity claims (state/causal, no figure) untouched — out of scope for this pass", () => {
    const claim = "committed and pushed the fix";
    const fullSession = "totally unrelated content, even the word committed appears here";
    const out = demoteFullSessionFigures([flag(claim)], fullSession);
    expect(out[0]!.verdict).toBe("unsupported");
    expect(out[0]!.basis).toBe("no receipt this turn"); // untouched, not even rewritten
  });

  it("FAIL-OPEN: no full-session text (undefined/empty) → unchanged", () => {
    const claim = "cart total is $60.00";
    expect(demoteFullSessionFigures([flag(claim)], undefined)[0]!.verdict).toBe("unsupported");
    expect(demoteFullSessionFigures([flag(claim)], "")[0]!.verdict).toBe("unsupported");
  });

  it("supported claims pass through untouched", () => {
    const supported: ClaimVerdict = { claim: "x is $60.00", verdict: "supported", basis: "b", evidence: "e" };
    const out = demoteFullSessionFigures([supported], "$60.00 appears right here");
    expect(out[0]!.basis).toBe("b");
  });

  it("ANTI-SELF-LAUNDERING (integration with transcript.ts): a figure present only in the agent's own prior assistant text — never a tool_result — does NOT demote", () => {
    const claim = "the total is $60.00";
    // Simulates what readFullSessionToolResults would hand back for a transcript
    // where the agent asserted the figure in its own prose but no tool ever
    // produced it: the extractor structurally excludes assistant/tool_use text,
    // so the string passed here never contains "$60.00" — reproduced directly
    // (see test/transcript.test.ts's ANTI-SELF-LAUNDERING GUARD test for the
    // extraction-level proof) so this file's fail-open assertion stands alone.
    const fullSessionToolResultsOnly = "unrelated tool_result: 200 OK";
    const out = demoteFullSessionFigures([flag(claim)], fullSessionToolResultsOnly);
    expect(out[0]!.verdict).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// FIXES 1/3/4 — prompt pins. The prose lines must actually reach the auditor.
// ---------------------------------------------------------------------------
describe("RULES_BLOCK prompt pins (via buildPreGatheredPrompt)", () => {
  const prompt = buildPreGatheredPrompt(
    { dir: "/x", sessionId: "s", finalMessage: "m", userRequest: "u" },
    "evidence",
  );
  it("FIX 1: pins the delegated-research-is-evidence line", () => {
    expect(prompt).toContain("DELEGATED RESEARCH IS EVIDENCE");
  });
  it("FIX 3: pins the claim-time staleness line", () => {
    expect(prompt).toContain("AT THE TIME IT WAS UTTERED");
    expect(prompt).toContain("STALE, not false");
  });
  it("FIX 4: pins the project-docs-are-evidence line", () => {
    expect(prompt).toContain("PROJECT DOCS ARE EVIDENCE");
    expect(prompt).toContain("CLAUDE.md");
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
      '{"claims":[{"claim":"x","verdict":"unsupported","basis":"y","evidence":"z","reliance":"the user relies on x and is burned when it is false"}],"unaccountable":false,"note":""}';
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
    const reply = '{"claims":[{"claim":"tests pass","verdict":"unsupported","basis":"no run","evidence":"","reliance":"the user merges believing the suite is green when no run exists"}],"unaccountable":false,"note":""}';
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

// ---------------------------------------------------------------------------
// DELIVERY POLICY — VS_DELIVERY=quiet|full. The nine-specimen owner rule,
// validated against the REAL specimen texts (not new evals): under quiet a
// warning reaches the pending-feedback file ONLY for a contradicted verdict, a
// quantified unsupported claim (the fabricated-statistic / gas-number class), or
// a completion/verification-shaped unsupported claim; everything else is
// telemetry-only. Non-deliverable warnings are NOT lost — they still enter
// `warnings` (telemetry + R5 dedupe), just not `deliverableWarnings`.
// ---------------------------------------------------------------------------
describe("delivery policy — deliveryMode() fail-open", () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env.VS_DELIVERY; });
  afterEach(() => { if (prev === undefined) delete process.env.VS_DELIVERY; else process.env.VS_DELIVERY = prev; });

  it("defaults to quiet when unset, and for any non-'full' value (fail-open)", () => {
    delete process.env.VS_DELIVERY;
    expect(deliveryMode()).toBe("quiet");
    process.env.VS_DELIVERY = "quiet";
    expect(deliveryMode()).toBe("quiet");
    process.env.VS_DELIVERY = "banana"; // unknown → quiet (fail-open)
    expect(deliveryMode()).toBe("quiet");
    process.env.VS_DELIVERY = "FULL"; // case-sensitive; only exact "full" opts in
    expect(deliveryMode()).toBe("quiet");
    process.env.VS_DELIVERY = "full";
    expect(deliveryMode()).toBe("full");
  });
});

describe("delivery policy — quiet suppression predicate (nine-specimen validation)", () => {
  const c = (verdict: ClaimVerdict["verdict"], claim: string): ClaimVerdict => ({ claim, verdict, basis: "b", evidence: "e", reliance: "r".repeat(30) });

  // Each specimen is a real production-shaped claim text with its verdict and the
  // owner's expected deliverability under quiet. DELIVERED = interrupts; SUPPRESSED
  // = telemetry-only.
  const DELIVERED: Array<[string, ClaimVerdict]> = [
    ["PR#39 contradicted flip", c("contradicted", "PR #39 is merged and CI is green.")],
    ["fabricated 2% revert rate (unsupported + quantified)", c("unsupported", "The revert rate holds steady at 2%.")],
    ["false 'all tests pass' (verification-shaped)", c("unsupported", "All tests pass.")],
    ["'committed the fix' state claim", c("unsupported", "I committed the fix.")],
  ];
  const SUPPRESSED: Array<[string, ClaimVerdict]> = [
    ["phone-gate inference (unsupported, unquantified, not completion-shaped)",
      c("unsupported", "A US or foreign phone number will be rejected, so a valid JP number is the actual remaining gate.")],
    ["monitor-housekeeping remark",
      c("unsupported", "The monitor is still running and looks healthy, nothing needs attention right now.")],
    ["Discord-fits-better judgment",
      c("unsupported", "Discord fits this workflow better than Slack would.")],
    ["'deterministic residuals' adverb claim",
      c("unsupported", "The residuals are deterministic across runs.")],
  ];

  for (const [name, claim] of DELIVERED) {
    it(`DELIVERED under quiet: ${name}`, () => {
      expect(claimDeliverableUnderQuiet(claim)).toBe(true);
    });
  }
  for (const [name, claim] of SUPPRESSED) {
    it(`SUPPRESSED under quiet: ${name}`, () => {
      expect(claimDeliverableUnderQuiet(claim)).toBe(false);
    });
  }

  it("grounding flags: block-severity and number/state rules deliver; causal/scope warn flags are suppressed", () => {
    const gf = (rule: GroundingFlag["rule"], severity: GroundingFlag["severity"]): GroundingFlag =>
      ({ claim: "x", rule, severity, basis: "b", evidence: "e" });
    // block severity (blocked-no-attempt, or a git-probe state contradiction) → deliver
    expect(groundingDeliverableUnderQuiet(gf("blocked-no-attempt", "block"))).toBe(true);
    expect(groundingDeliverableUnderQuiet(gf("state-no-receipt", "block"))).toBe(true);
    // number/state rules at warn severity → deliver
    expect(groundingDeliverableUnderQuiet(gf("number-no-receipt", "warn"))).toBe(true);
    expect(groundingDeliverableUnderQuiet(gf("state-no-receipt", "warn"))).toBe(true);
    // warn-only inferential rules → suppressed
    expect(groundingDeliverableUnderQuiet(gf("causal-no-referent", "warn"))).toBe(false);
    expect(groundingDeliverableUnderQuiet(gf("scope-narrower", "warn"))).toBe(false);
  });
});

describe("audit() — delivery policy wired end-to-end", () => {
  let tmpDir: string;
  let prevPath: string | undefined;
  let prevDelivery: string | undefined;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vs-delivery-telemetry-"));
    prevPath = process.env.VS_TELEMETRY_PATH;
    prevDelivery = process.env.VS_DELIVERY;
    process.env.VS_TELEMETRY_PATH = join(tmpDir, "telemetry.jsonl");
  });
  afterEach(async () => {
    if (prevPath === undefined) delete process.env.VS_TELEMETRY_PATH; else process.env.VS_TELEMETRY_PATH = prevPath;
    if (prevDelivery === undefined) delete process.env.VS_DELIVERY; else process.env.VS_DELIVERY = prevDelivery;
    await rm(tmpDir, { recursive: true, force: true });
  });
  const lastFiring = (): Firing => { const fs = readFirings(); return fs[fs.length - 1]!; };
  const single = (verdict: string, claim: string): string =>
    JSON.stringify({ claims: [{ claim, verdict, basis: "b", evidence: "e", reliance: "the user acts on this claim before the next exchange" }], unaccountable: false, note: "" });

  it("quiet (default): an unquantified, non-completion unsupported claim is telemetered + deduped but NOT delivered", async () => {
    delete process.env.VS_DELIVERY;
    const dir = await repo();
    const claim = "Discord fits this workflow better than Slack would.";
    const auditor = fakeAuditor("agentic", single("unsupported", claim));
    const v = await audit(job(dir, { finalMessage: "Some narration." }), auditor, nullEmbedder(), FORCE_RUN);
    // The warning IS built (dedupe + telemetry) but is held back from delivery.
    expect(v.warnings).toHaveLength(1);
    expect(v.deliverableWarnings).toEqual([]);
    // Telemetry records the suppression AND still carries the caught text.
    const f = lastFiring();
    expect(f.delivery).toBe("suppressed-quiet");
    expect(f.caught).toContain("Discord fits this workflow better");
  });

  it("quiet: a contradicted claim is delivered; telemetry delivery is 'quiet' (nothing suppressed)", async () => {
    delete process.env.VS_DELIVERY;
    const dir = await repo();
    const claim = "PR #39 is merged and CI is green.";
    const auditor = fakeAuditor("agentic", single("contradicted", claim));
    const v = await audit(job(dir, { finalMessage: "Status update." }), auditor, nullEmbedder(), FORCE_RUN);
    expect(v.warnings).toHaveLength(1);
    expect(v.deliverableWarnings).toEqual(v.warnings);
    expect(lastFiring().delivery).toBe("quiet");
  });

  it("quiet: a quantified unsupported claim (2%) is delivered", async () => {
    delete process.env.VS_DELIVERY;
    const dir = await repo();
    const auditor = fakeAuditor("agentic", single("unsupported", "The revert rate holds steady at 2%."));
    const v = await audit(job(dir, { finalMessage: "Metrics summary." }), auditor, nullEmbedder(), FORCE_RUN);
    expect(v.deliverableWarnings).toHaveLength(1);
  });

  it("quiet: R9 unaccountable is delivered (completion-shaped by definition)", async () => {
    delete process.env.VS_DELIVERY;
    const dir = await repo();
    const auditor = fakeAuditor("agentic", '{"claims":[],"unaccountable":true,"note":"say what you did"}');
    const v = await audit(job(dir, { finalMessage: "Done." }), auditor, nullEmbedder(), FORCE_RUN);
    expect(v.deliverableWarnings).toHaveLength(1);
    expect(v.deliverableWarnings[0]).toContain("did substantial work but reported nothing checkable");
    expect(lastFiring().delivery).toBe("quiet");
  });

  it("full: the same unquantified unsupported claim IS delivered (today's behavior restored)", async () => {
    process.env.VS_DELIVERY = "full";
    const dir = await repo();
    const claim = "Discord fits this workflow better than Slack would.";
    const auditor = fakeAuditor("agentic", single("unsupported", claim));
    const v = await audit(job(dir, { finalMessage: "Some narration." }), auditor, nullEmbedder(), FORCE_RUN);
    expect(v.deliverableWarnings).toEqual(v.warnings);
    expect(v.deliverableWarnings).toHaveLength(1);
    expect(lastFiring().delivery).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// THE ANCHOR (depends_on) — load-bearing made objective. A model can fake a harm
// sentence; it cannot fake a verbatim span that survives string-matching. These
// verify the string layer (normalizeAnchor/verifyAnchor), the deliverability
// synthesis it feeds (the anchor no longer grants deliverability for the
// inferential class — that lane was retired 2026-07-26; anchor verification
// still runs for telemetry and the delivered "relied on by" clause), and the
// end-to-end behavior under quiet.
// ---------------------------------------------------------------------------
describe("verifyAnchor — verbatim string verification", () => {
  const FINAL = "The flakiness comes from the shared session cache. So I'm ripping the shared cache out now — this refactor lands tonight.";

  it("verbatim quote from the final message → verified", () => {
    expect(verifyAnchor("this refactor lands tonight", FINAL, undefined)).toBe("verified");
  });

  it("whitespace + markdown normalization: emphasized/re-spaced source still matches", () => {
    const final = "So I'm **applying the fix now**   across\nthe module.";
    // the model quotes it clean and quoted; the source has ** and odd whitespace
    expect(verifyAnchor('"applying the fix now"', final, undefined)).toBe("verified");
  });

  it("a paraphrase that is not verbatim → void", () => {
    expect(verifyAnchor("I am going to remove the cache tonight", FINAL, undefined)).toBe("void");
  });

  it("a quote shorter than 6 chars → void", () => {
    expect(verifyAnchor("ok", FINAL, undefined)).toBe("void"); // 2 chars
  });

  it("a short load-bearing imperative (\"Safe to merge.\", 14 chars) still verifies", () => {
    const final = "Tests are green and the diff is reviewed. Safe to merge.";
    expect(verifyAnchor("Safe to merge.", final, undefined)).toBe("verified");
  });

  it("a 6-char imperative quote from the conversationTail (\"yes go\") verifies at the floor", () => {
    const tail = "User: yes go\nAgent: on it.";
    expect(verifyAnchor("yes go", "Short summary.", tail)).toBe("verified");
  });

  it("a quote taken from the conversationTail (the user's own move) → verified", () => {
    const tail = "User: if you're confident on the cause, go ahead and fix it tonight.\nAgent: on it.";
    expect(verifyAnchor("go ahead and fix it tonight", "Short summary.", tail)).toBe("verified");
  });

  it("no depends_on → n/a (not void — the claim carried no quote to verify)", () => {
    expect(verifyAnchor(undefined, FINAL, undefined)).toBe("n/a");
    expect(verifyAnchor("", FINAL, undefined)).toBe("n/a");
  });

  it("normalizeAnchor strips emphasis + surrounding quotes, collapses whitespace, lowercases", () => {
    expect(normalizeAnchor('  **"Applying   the Fix"**  ')).toBe("applying the fix");
  });
});

describe("claimDeliverableUnderQuiet — the four-row deliverability matrix", () => {
  const c = (verdict: ClaimVerdict["verdict"], claim: string): ClaimVerdict => ({ claim, verdict, basis: "b", evidence: "e", reliance: "r".repeat(30) });

  it("row 1 — contradicted → deliverable, anchor not required", () => {
    expect(claimDeliverableUnderQuiet(c("contradicted", "PR #39 is merged."), false)).toBe(true);
  });

  it("row 2 — unsupported + specific figure OR completion shape → deliverable, anchor not required", () => {
    expect(claimDeliverableUnderQuiet(c("unsupported", "The revert rate holds at 2%."), false)).toBe(true);
    expect(claimDeliverableUnderQuiet(c("unsupported", "All tests pass."), false)).toBe(true);
  });

  it("row 3 — unsupported inferential WITH a verified anchor → NOT deliverable (lane retired 2026-07-26)", () => {
    expect(claimDeliverableUnderQuiet(c("unsupported", "The flakiness comes from the shared session cache."), true)).toBe(false);
  });

  it("row 4 — unsupported inferential WITHOUT a verified anchor → NOT deliverable (proposal-less narration)", () => {
    expect(claimDeliverableUnderQuiet(c("unsupported", "The flakiness comes from the shared session cache."), false)).toBe(false);
  });
});

describe("claimWarning — the delivered 'relied on by' clause", () => {
  const c: ClaimVerdict = { claim: "the flakiness comes from the shared cache", verdict: "unsupported", basis: "correlation only, no isolating test", evidence: "", reliance: "the user rips out the cache tonight on a false cause" };

  it("appends the verified anchor as a quoted 'relied on by' clause after the reliance", () => {
    expect(claimWarning("Codex", c, "this refactor lands tonight")).toBe(
      'Codex, you have no basis to claim "the flakiness comes from the shared cache" — correlation only, no isolating test: if false — the user rips out the cache tonight on a false cause — relied on by: "this refactor lands tonight"',
    );
  });

  it("truncates a long anchor to 80 chars with …", () => {
    const long = "z".repeat(120);
    const line = claimWarning("Codex", c, long);
    expect(line).toContain('relied on by: "' + "z".repeat(80));
    expect(line).toContain("…");
    expect(line).not.toContain("z".repeat(120));
  });

  it("no anchor → no clause (unchanged line)", () => {
    expect(claimWarning("Codex", c)).not.toContain("relied on by");
  });
});

describe("audit() — anchor no longer re-admits proposal-bearing inference under quiet (lane retired)", () => {
  let tmpDir: string;
  let prevPath: string | undefined;
  let prevDelivery: string | undefined;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vs-anchor-telemetry-"));
    prevPath = process.env.VS_TELEMETRY_PATH;
    prevDelivery = process.env.VS_DELIVERY;
    process.env.VS_TELEMETRY_PATH = join(tmpDir, "telemetry.jsonl");
    delete process.env.VS_DELIVERY; // quiet
  });
  afterEach(async () => {
    if (prevPath === undefined) delete process.env.VS_TELEMETRY_PATH; else process.env.VS_TELEMETRY_PATH = prevPath;
    if (prevDelivery === undefined) delete process.env.VS_DELIVERY; else process.env.VS_DELIVERY = prevDelivery;
    await rm(tmpDir, { recursive: true, force: true });
  });
  const lastFiring = (): Firing => { const fs = readFirings(); return fs[fs.length - 1]!; };

  const CLAIM = "The flakiness comes from the shared session cache.";
  const FINAL = "The flakiness comes from the shared session cache. So I'm ripping the shared cache out now — this refactor lands tonight.";
  const replyWith = (dependsOn: string): string =>
    JSON.stringify({ claims: [{ claim: CLAIM, verdict: "unsupported", basis: "correlation only", evidence: "", reliance: "the user rips out the cache tonight on a false cause", depends_on: dependsOn }], unaccountable: false, note: "" });

  it("a VERIFIED anchor still suppresses the inferential flag under quiet, but keeps anchor:'verified' telemetry + the 'relied on by' clause in warnings", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", replyWith("this refactor lands tonight"));
    const v = await audit(job(dir, { finalMessage: FINAL }), auditor, nullEmbedder(), FORCE_RUN);
    expect(v.warnings).toHaveLength(1); // still telemetered + deduped
    expect(v.warnings[0]).toContain('relied on by: "this refactor lands tonight"');
    expect(v.deliverableWarnings).toEqual([]); // but held back — the lane is retired
    const f = lastFiring();
    expect(f.anchor).toBe("verified");
    expect(f.delivery).toBe("suppressed-quiet");
  });

  it("a VOID anchor (paraphrase) suppresses the same inferential flag under quiet + telemetry anchor:'void'", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", replyWith("I plan to remove the cache soon"));
    const v = await audit(job(dir, { finalMessage: FINAL }), auditor, nullEmbedder(), FORCE_RUN);
    expect(v.warnings).toHaveLength(1); // still telemetered + deduped
    expect(v.deliverableWarnings).toEqual([]); // but held back
    expect(v.deliverableWarnings.join("")).not.toContain("relied on by"); // void → no clause
    const f = lastFiring();
    expect(f.anchor).toBe("void");
    expect(f.delivery).toBe("suppressed-quiet");
  });
});
