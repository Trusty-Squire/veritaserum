import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { tempRepo, write } from "./helpers.js";
import { audit, type AuditJob } from "../src/auditor.js";
import type { Auditor, AuditorTier } from "../src/resolve.js";
import { appendDemand, readLawTreeSync } from "../src/law.js";
import { readFirings, type Firing } from "../src/telemetry.js";
import { existsSync, readFileSync, rmSync } from "node:fs";

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

const OK_REPLY = '{"claims":[],"demands":[],"unaccountable":false,"note":""}';

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
    await audit(job(dir), auditor);
    expect(auditor.calls).toHaveLength(1);
    const prompt = auditor.calls[0]!.prompt;
    expect(prompt).toContain("R9 (unaccountable work)");
    expect(prompt).toContain("MISSING PROOF");
    expect(prompt).toContain("discriminating test");
    expect(prompt).toContain("may be stale");
    expect(prompt).toContain("veritaserum.law.yaml");
    expect(prompt).toContain("HEAD");
    expect(prompt).toContain("READ-ONLY");
  });

  it("passes the repo dir through to invoke (agentic auditors run their own probes there)", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(job(dir), auditor);
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
    await audit(job(dir), auditor);
    const prompt = auditor.calls[0]!.prompt;
    expect(prompt).toContain("DEGRADED TIER");
    expect(prompt).toContain("git log -10");
    expect(prompt).toContain("add a");
  });

  it("includes the receipt tail when provided", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("pre-gathered", OK_REPLY);
    await audit(job(dir, { receipts: "ran: npm test -> exit 0" }), auditor);
    expect(auditor.calls[0]!.prompt).toContain("ran: npm test -> exit 0");
  });
});

describe("audit — verdict parsing never throws (R8)", () => {
  it("a non-JSON reply produces {error}, not a throw", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("agentic", "I refuse to answer in JSON, sorry.");
    const v = await audit(job(dir), auditor);
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
    const v = await audit(job(dir), auditor);
    expect(v.error).toContain("codex exec crashed");
  });

  it("tier absent: no invocation attempted, error is auditor_absent, mechanical checks still run (R8)", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "exit 0", rung: "oracle", originClaim: "prior demand" });
    const auditor: Auditor = {
      tier: "absent",
      vendor: "none",
      sameFamily: false,
      async invoke() {
        throw new Error("should never be called");
      },
    };
    const v = await audit(job(dir), auditor);
    expect(v.error).toBe("auditor_absent");
    expect(v.mechanicalChecks).toHaveLength(1);
    expect(v.mechanicalChecks[0]!.passed).toBe(true);
  });
});

describe("audit — R5 duplicate-warning suppression", () => {
  it("the same claim's warning is not repeated once it's in priorWarnings", async () => {
    const dir = await repo();
    const reply = '{"claims":[{"claim":"fixed the bug","verdict":"unsupported","basis":"no diff shows this change","evidence":""}],"demands":[],"unaccountable":false,"note":""}';
    const auditor = fakeAuditor("agentic", reply);
    const first = await audit(job(dir), auditor);
    expect(first.warnings).toEqual(["fixed the bug — unsupported: no diff shows this change"]);

    const second = await audit(job(dir, { priorWarnings: first.warnings }), auditor);
    expect(second.warnings).toEqual([]);
    // the claim verdict itself is still reported every run — only the warning repeats are suppressed.
    expect(second.claims[0]!.verdict).toBe("unsupported");
  });
});

describe("audit — R9 unaccountable work", () => {
  it("unaccountable:true from the auditor becomes a warning", async () => {
    const dir = await repo();
    const reply = '{"claims":[],"demands":[],"unaccountable":true,"note":"state what was done and how you know it works"}';
    const auditor = fakeAuditor("agentic", reply);
    const v = await audit(job(dir), auditor);
    expect(v.unaccountable).toBe(true);
    expect(v.warnings[0]).toContain("unaccountable work");
    expect(v.warnings[0]).toContain("state what was done");
  });
});

describe("audit — demand -> failing test materialization (docs/DEMANDS.md phase 1)", () => {
  const KUHN_DEMAND = {
    origin_claim: "wrote an MCCFR solver, working well",
    gap: "no oracle demonstrates convergence to the known Kuhn poker equilibrium",
    remedy: "run the MCCFR solver on Kuhn poker and compare to the known analytic equilibrium",
    accept: "computed strategy within 1e-3 of the known Kuhn equilibrium values",
    test_file: "process.exit(1);\n",
    rung: "analytic",
  };
  const kuhnPath = (dir: string) => join(dir, "test/veritaserum", "no-oracle-demonstrates-convergence-to-the-known-kuhn-poker-e.js");

  it("materializes a demand as a failing script under test/veritaserum/ with provenance header — no law-file entry", async () => {
    const dir = await repo();
    const reply = JSON.stringify({
      claims: [{ claim: "wrote an MCCFR solver, working well", verdict: "unsupported", basis: "no oracle exists", evidence: "" }],
      demands: [KUHN_DEMAND],
      unaccountable: false,
      note: "",
    });
    const v = await audit(job(dir), fakeAuditor("agentic", reply));
    expect(v.demands).toHaveLength(1);

    expect(existsSync(kuhnPath(dir))).toBe(true);
    const content = readFileSync(kuhnPath(dir), "utf8");
    expect(content).toContain("wrote an MCCFR solver, working well");
    expect(content).toContain("within 1e-3");
    expect(content).toContain("process.exit(1);");
    expect(readLawTreeSync(dir)).toBeNull(); // demands no longer write case law
  });

  it("a duplicate demand (same slug already on disk) is not overwritten and is omitted from verdict.demands", async () => {
    const dir = await repo();
    const reply = JSON.stringify({ claims: [], demands: [KUHN_DEMAND], unaccountable: false, note: "" });
    await audit(job(dir), fakeAuditor("agentic", reply));
    const before = readFileSync(kuhnPath(dir), "utf8");

    const v = await audit(job(dir), fakeAuditor("agentic", reply));
    expect(v.demands).toHaveLength(0);
    expect(readFileSync(kuhnPath(dir), "utf8")).toBe(before);
  });

  it("a demand without accept/test_file is unverifiable: nothing is written, nothing binds", async () => {
    const dir = await repo();
    const reply = JSON.stringify({
      claims: [],
      demands: [{ origin_claim: "c", gap: "vibes check", remedy: "", accept: "", rung: "unverifiable" }],
      unaccountable: false,
      note: "",
    });
    const v = await audit(job(dir), fakeAuditor("agentic", reply));
    expect(v.demands).toHaveLength(0);
    expect(existsSync(join(dir, "test/veritaserum"))).toBe(false);
  });

  it("an authored test that PASSES against the current tree is discarded — it discriminates nothing", async () => {
    const dir = await repo();
    const reply = JSON.stringify({
      claims: [],
      demands: [{ ...KUHN_DEMAND, gap: "a passing oracle", test_file: "process.exit(0);\n" }],
      unaccountable: false,
      note: "",
    });
    const v = await audit(job(dir), fakeAuditor("agentic", reply));
    expect(v.demands).toHaveLength(0);
    expect(existsSync(join(dir, "test/veritaserum", "a-passing-oracle.js"))).toBe(false);
  });

  it("committed demand scripts run FROM HEAD: deleting the working-tree copy cannot dodge the check", async () => {
    const dir = await repo();
    await write(dir, "test/veritaserum/kuhn-anchor.js", "// accept: known values\nprocess.exit(1);\n");
    await execa("git", ["add", "."], { cwd: dir });
    await execa("git", ["commit", "-qm", "demand: kuhn anchor"], { cwd: dir });
    rmSync(join(dir, "test/veritaserum/kuhn-anchor.js"), { force: true });

    const v = await audit(job(dir), fakeAuditor("agentic", OK_REPLY));
    const check = v.mechanicalChecks.find((c) => c.gateId === "demand:kuhn-anchor");
    expect(check).toBeDefined();
    expect(check!.passed).toBe(false);
  });
});

describe("audit — mechanical standing-law checks fold into the verdict", () => {
  it("a failing runnable check overturns a 'supported' claim whose evidence names that exact command", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "exit 1", rung: "oracle", originClaim: "prior demand" });
    const reply =
      '{"claims":[{"claim":"the anchor still holds","verdict":"supported","basis":"matches prior run","evidence":"exit 1"}],"demands":[],"unaccountable":false,"note":""}';
    const auditor = fakeAuditor("agentic", reply);
    const v = await audit(job(dir), auditor);
    expect(v.mechanicalChecks).toHaveLength(1);
    expect(v.mechanicalChecks[0]!.passed).toBe(false);
    expect(v.claims[0]!.verdict).toBe("contradicted");
    expect(v.claims[0]!.basis).toContain("overturned");
  });

  it("a passing runnable check leaves a supported claim untouched", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "exit 0", rung: "oracle", originClaim: "prior demand" });
    const reply =
      '{"claims":[{"claim":"the anchor still holds","verdict":"supported","basis":"matches prior run","evidence":"exit 0"}],"demands":[],"unaccountable":false,"note":""}';
    const auditor = fakeAuditor("agentic", reply);
    const v = await audit(job(dir), auditor);
    expect(v.mechanicalChecks[0]!.passed).toBe(true);
    expect(v.claims[0]!.verdict).toBe("supported");
  });

  it("downgrades a supported claim to contradicted when a REFERENCED law id's check failed (linkage, not text-match)", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "exit 1", rung: "oracle", originClaim: "prior demand" });
    const gateId = readLawTreeSync(dir)!.gates[0]!.id;
    const reply =
      `{"claims":[{"claim":"the anchor still holds","verdict":"supported","basis":"matches prior run","evidence":"totally unrelated text","law_ids":["${gateId}"]}],"demands":[],"unaccountable":false,"note":""}`;
    const auditor = fakeAuditor("agentic", reply);
    const v = await audit(job(dir), auditor);
    expect(v.claims[0]!.verdict).toBe("contradicted");
    expect(v.claims[0]!.basis).toContain("overturned");
    expect(v.claims[0]!.basis).toContain(gateId);
  });

  it("a claim with law_ids that does NOT reference the failed id is left alone — no text-match fallback once law_ids is present", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "exit 1", rung: "oracle", originClaim: "prior demand" });
    const reply =
      '{"claims":[{"claim":"unrelated thing","verdict":"supported","basis":"fine","evidence":"exit 1","law_ids":["some-other-law-id"]}],"demands":[],"unaccountable":false,"note":""}';
    const auditor = fakeAuditor("agentic", reply);
    const v = await audit(job(dir), auditor);
    expect(v.claims[0]!.verdict).toBe("supported");
  });

  it("the law summary in the agentic prompt lists active law ids for the auditor to cite", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "exit 0", rung: "oracle", originClaim: "prior" });
    const gateId = readLawTreeSync(dir)!.gates[0]!.id;
    const auditor = fakeAuditor("agentic", OK_REPLY);
    await audit(job(dir), auditor);
    expect(auditor.calls[0]!.prompt).toContain(gateId);
    expect(auditor.calls[0]!.prompt).toContain("law_ids");
  });

  it("a retired law entry is never run mechanically", async () => {
    const dir = await repo();
    await appendDemand(dir, { run: "exit 1", rung: "oracle", originClaim: "old" });
    const { retireLaw } = await import("../src/law.js");
    const id = readLawTreeSync(dir)!.gates[0]!.id;
    await retireLaw(dir, id, "superseded");
    const auditor = fakeAuditor("agentic", OK_REPLY);
    const v = await audit(job(dir), auditor);
    expect(v.mechanicalChecks).toHaveLength(0);
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
    await appendDemand(dir, { run: "exit 0", rung: "oracle", originClaim: "prior" });
    const reply =
      '{"claims":[{"claim":"x","verdict":"unsupported","basis":"y","evidence":""}],"demands":[],"unaccountable":false,"note":""}';
    const auditor = fakeAuditor("agentic", reply, { vendor: "codex", sameFamily: true });
    await audit(job(dir), auditor);

    const firings: Firing[] = readFirings();
    expect(firings).toHaveLength(1);
    const f = firings[0]!;
    expect(f.event).toBe("audit");
    expect(f.blocked).toBe(false); // R5: audit never blocks by default
    expect(f.auditor_tier).toBe("same_family"); // sameFamily tags override the raw tier for telemetry
    expect(f.verdict_basis).toBe("standing-law"); // mechanical checks ran this turn
    expect(f.scheduling_mode).toBe("live");
    expect(Array.isArray(f.law_ids)).toBe(true);
    expect(f.law_ids!.length).toBe(1);
    expect(typeof f.vague_turn).toBe("boolean");
  });

  it("tags auditor_tier 'absent' when the auditor is unavailable", async () => {
    const dir = await repo();
    const auditor: Auditor = { tier: "absent", vendor: "none", sameFamily: false, async invoke() { throw new Error("x"); } };
    await audit(job(dir), auditor);
    const firings = readFirings();
    expect(firings[0]!.auditor_tier).toBe("absent");
  });
});
