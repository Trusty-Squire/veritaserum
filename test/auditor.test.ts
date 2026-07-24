import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { tempRepo, write } from "./helpers.js";
import { audit, addressee, claimWarning, unaccountableWarning, groundingWarning, type AuditJob } from "../src/auditor.js";
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

  it("grounding rules — each keeps the flag's basis (and its demand) as the second clause", () => {
    // number-no-receipt's demand wording is deliberate and must SURVIVE — it is
    // passed through as the basis clause verbatim.
    const demand = "cite the measurement or source that produced it, or state the number is illustrative.";
    expect(groundingWarning("Claude", "blocked-no-attempt", "no tool call attempted it")).toBe("Claude, you called this blocked but never attempted it — no tool call attempted it");
    expect(groundingWarning("Claude", "number-no-receipt", demand)).toBe(`Claude, nothing you ran produced that number — ${demand}`);
    expect(groundingWarning("Codex", "causal-no-referent", "nothing in the receipts is related to it")).toBe("Codex, you blamed a cause you never observed — nothing in the receipts is related to it");
    expect(groundingWarning("Agent", "scope-narrower", "enumerates only 3 item(s)")).toBe("Agent, you reported a total the evidence doesn't fully cover — enumerates only 3 item(s)");
    expect(groundingWarning("Claude", "state-no-receipt", "no commit receipt this session")).toBe("Claude, you claimed a repo state you never verified — no commit receipt this session");
  });
});

describe("audit — agentic prompt content (SPEC §2 rules)", () => {
  it("instructs R9, the missing-proof rule for causal/state/measurement, and doc-as-stale-proof", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(job(dir), auditor, nullEmbedder());
    expect(auditor.calls).toHaveLength(1);
    const prompt = auditor.calls[0]!.prompt;
    expect(prompt).toContain("R9 (unaccountable work)");
    expect(prompt).toContain("MISSING PROOF");
    expect(prompt).toContain("discriminating test");
    expect(prompt).toContain("may be stale");
    expect(prompt).toContain("HEAD");
    expect(prompt).toContain("READ-ONLY");
  });

  it("carries the ABSTENTION, JUDGMENT, and FICTION protected-deliverable guards", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(job(dir), auditor, nullEmbedder());
    const prompt = auditor.calls[0]!.prompt;
    // The confabulation-guard family: honest hedges, argued judgments, and requested
    // fiction are all the deliverable, never flagged for lacking a receipt.
    expect(prompt).toContain("ABSTENTION IS NOT CONFABULATION");
    expect(prompt).toContain("PREDICTIONS AND JUDGMENTS ARE NOT CONFABULATION");
    expect(prompt).toContain("FICTION IS NOT CONFABULATION");
    // The judgment guard keys on claim type (checkable now), not conversational genre.
    expect(prompt).toContain("neither possible nor expected");
    expect(prompt).toContain("flag only claims whose truth could have been checked");
    // The judgment guard audits cited evidence, never the opinion itself.
    expect(prompt).toContain("invented support, not opinion");
    // The fiction guard still catches real-world assertions inside a creative turn.
    expect(prompt).toContain("REAL session/codebase/world");
  });

  it("passes the repo dir through to invoke (agentic auditors run their own probes there)", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(job(dir), auditor, nullEmbedder());
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
    await audit(job(dir), auditor, nullEmbedder());
    const prompt = auditor.calls[0]!.prompt;
    expect(prompt).toContain("DEGRADED TIER");
    expect(prompt).toContain("git log -10");
    expect(prompt).toContain("add a");
  });

  it("includes the receipt tail when provided", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("pre-gathered", OK_REPLY);
    await audit(job(dir, { receipts: "ran: npm test -> exit 0" }), auditor, nullEmbedder());
    expect(auditor.calls[0]!.prompt).toContain("ran: npm test -> exit 0");
  });
});

describe("audit — verdict parsing never throws (R8)", () => {
  it("a non-JSON reply produces {error}, not a throw", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", "I refuse to answer in JSON, sorry.");
    const v = await audit(job(dir), auditor, nullEmbedder());
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
    const v = await audit(job(dir), auditor, nullEmbedder());
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
    const v = await audit(job(dir), auditor, nullEmbedder());
    expect(v.error).toBe("auditor_absent");
    expect(v.claims).toEqual([]);
  });
});

describe("audit — R5 duplicate-warning suppression", () => {
  it("the same claim's warning is not repeated once it's in priorWarnings", async () => {
    const dir = await repo();
    const reply = '{"claims":[{"claim":"fixed the bug","verdict":"unsupported","basis":"no diff shows this change","evidence":""}],"unaccountable":false,"note":""}';
    const auditor = fakeAuditor("agentic", reply);
    const first = await audit(job(dir), auditor, nullEmbedder());
    // CHANGE 1 correction: the warning is now the colloquial direct-address line
    // (built once in auditor.ts), not the old coroner's-report `claim — verdict:
    // basis`. Default job has no executor → addressee "Agent".
    expect(first.warnings).toEqual(['Agent, you have no basis to claim "fixed the bug" — no diff shows this change.']);

    const second = await audit(job(dir, { priorWarnings: first.warnings }), auditor, nullEmbedder());
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
    const v = await audit(job(dir), auditor, nullEmbedder());
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
    await audit(job(dir), auditor, nullEmbedder());

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
    await audit(job(dir), auditor, nullEmbedder());
    const firings = readFirings();
    expect(firings[0]!.auditor_tier).toBe("absent");
  });
});
