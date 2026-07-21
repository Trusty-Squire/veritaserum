import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { tempRepo, write } from "./helpers.js";
import { audit, type AuditJob } from "../src/auditor.js";
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
    expect(first.warnings).toEqual(["fixed the bug — unsupported: no diff shows this change"]);

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
    expect(v.warnings[0]).toContain("unaccountable work");
    expect(v.warnings[0]).toContain("state what was done");
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

  it("a blocked-no-attempt grounding flag becomes a 'grounding: <rule>' warning, verdict never blocks", async () => {
    const dir = await repo();
    const claim = "There is no way to arm the vault, so this cannot be automated.";
    const auditor = fakeAuditor("agentic", OK_REPLY);
    const v = await audit(
      job(dir, { finalMessage: claim, receipts: "> Bash {\"command\":\"git status\"}\n< clean" }),
      auditor,
      groundingEmbedder(claim),
    );
    const groundingWarn = v.warnings.find((w) => w.startsWith("grounding: "));
    expect(groundingWarn).toBeDefined();
    expect(groundingWarn).toContain("blocked-no-attempt");
    // R5: grounding flags are warnings only — nothing about the verdict blocks.
    expect(v.error).toBeUndefined();
  });

  it("fails open: a throwing embedder yields no grounding warning and never throws", async () => {
    const dir = await repo();
    const throwing: Embedder = { async embed(): Promise<number[][]> { throw new Error("ollama unreachable"); } };
    const auditor = fakeAuditor("agentic", OK_REPLY);
    const v = await audit(job(dir, { finalMessage: "The funds are locked." }), auditor, throwing);
    expect(v.warnings.some((w) => w.startsWith("grounding: "))).toBe(false);
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
