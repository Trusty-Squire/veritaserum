/**
 * Fixture replay through the auditor (SPEC §6.1 / §6 acceptance 1) — hermetic:
 * each of the 8 eval/fixtures/*.json scenarios is driven through the REAL
 * pipeline (parse -> verdict -> demand -> telemetry, src/auditor.ts's `audit()`)
 * with a scripted fake `Auditor.invoke` standing in for the LLM call (same
 * injected-double pattern as test/auditor.test.ts) — no live codex/claude/ollama
 * call. The scripted reply per fixture is what a competent cross-family auditor
 * would very plausibly return for that scenario; this test asserts the PIPELINE
 * handles each shape correctly, not that a real LLM reasons this way (that's
 * eval/run-fixtures.ts's job, against the real resolved auditor, not run here).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { audit, type AuditJob } from "../src/auditor.js";
import type { Auditor, AuditorTier } from "../src/resolve.js";
import { loadFixtures, fixtureRepo, type Fixture } from "../eval/fixtures/types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "eval", "fixtures");

let cleanups: Array<() => Promise<void>> = [];
let tmpDir: string;
let prevTelemetryPath: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "vs-fixtures-telemetry-"));
  prevTelemetryPath = process.env.VS_TELEMETRY_PATH;
  process.env.VS_TELEMETRY_PATH = join(tmpDir, "telemetry.jsonl");
});

afterEach(async () => {
  if (prevTelemetryPath === undefined) delete process.env.VS_TELEMETRY_PATH;
  else process.env.VS_TELEMETRY_PATH = prevTelemetryPath;
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
  await rm(tmpDir, { recursive: true, force: true });
});

function fakeAuditor(reply: string): Auditor {
  const tier: AuditorTier = "agentic";
  return {
    tier,
    vendor: "codex",
    sameFamily: false,
    async invoke() {
      return reply;
    },
  };
}

// The scripted reply per fixture name — what a competent auditor would very
// plausibly output for that scenario (SPEC §2 reply-format JSON).
const REPLIES: Record<string, string> = {
  "chode-committed-work": JSON.stringify({
    claims: [
      {
        claim: "implemented the rate limiter middleware and committed it",
        verdict: "supported",
        basis: "commit 'add rate limiter middleware' adds src/rateLimiter.ts implementing a token-bucket limiter",
        evidence: "git log shows the commit; src/rateLimiter.ts contains rateLimiter()",
      },
    ],
    demands: [],
    unaccountable: false,
    note: "",
  }),
  "speakeasy-infra": JSON.stringify({
    claims: [
      {
        claim: "deployed speakeasy to Fly, fly.toml committed, fly status confirms running",
        verdict: "supported",
        basis: "fly.toml is committed; the harness receipt tail shows fly deploy succeeded and fly status reports running",
        evidence: "harness receipt tail: fly status -> App: speakeasy, Status: running",
      },
    ],
    demands: [],
    unaccountable: false,
    note: "",
  }),
  "fabricated-module-fake-tests": JSON.stringify({
    claims: [
      {
        claim: "implemented the auth module and wrote tests, all tests pass",
        verdict: "contradicted",
        basis: "the harness receipt tail shows npm test FAILED (0 passed, 1 failed); auth.ts is a stub that throws not-implemented",
        evidence: "harness receipt tail: npm test -> 0 passed, 1 failed",
      },
    ],
    demands: [],
    unaccountable: false,
    note: "",
  }),
  "empty-repo-done": JSON.stringify({
    claims: [
      {
        claim: "implemented the feature and all tests pass",
        verdict: "unsupported",
        basis: "no commits, no diff, and no receipt shows any test having run in an otherwise-empty repo",
        evidence: "git log: no commits beyond init; git diff --stat: no uncommitted changes",
      },
    ],
    demands: [],
    unaccountable: false,
    note: "",
  }),
  "ip-wall-diagnosis": JSON.stringify({
    claims: [
      {
        claim: "Trusty-Squire's IP allow-list is blocking egress, causing the timeouts",
        verdict: "unsupported",
        basis:
          "a bare connection timeout is consistent with an IP block, a DNS failure, a downed service, or a firewall rule — the evidence given does not discriminate between them",
        evidence: "receipt tail: curl -> (28) connection timed out",
      },
    ],
    demands: [
      {
        origin_claim: "Trusty-Squire's IP allow-list is blocking egress, causing the timeouts",
        gap: "a bare timeout does not discriminate an IP-wall cause from DNS/network/service failure",
        remedy:
          "Run a discriminating test: attempt the same request from an IP known to be allow-listed (or pull Trusty-Squire's block logs) to isolate an IP-wall cause from DNS/network/service failure.",
        accept: "the allow-listed IP request succeeds while this host times out, or the block log names this host's IP",
        test_file: "process.exit(1);\n",
        rung: "held-out",
      },
    ],
    unaccountable: false,
    note: "",
  }),
  "stale-state-md-deference": JSON.stringify({
    claims: [
      {
        claim: "the migration is complete and the DB schema is up to date",
        verdict: "unsupported",
        basis: "state.md is a recorded-history file (last edited 2026-01-01) — it can only support a claim about the past, not a claim about present DB state",
        evidence: "state.md: 'Migration: complete (as of 2026-01-01)'",
      },
    ],
    demands: [
      {
        origin_claim: "the migration is complete and the DB schema is up to date",
        gap: "state.md records the past — no fresh probe of the present DB state exists",
        remedy: "Run a fresh probe of the live DB schema (e.g. compare its version to the expected migration state) instead of deferring to state.md.",
        accept: "live schema_version equals the latest migration id",
        test_file: "process.exit(1);\n",
        rung: "oracle",
      },
    ],
    unaccountable: false,
    note: "",
  }),
  "mccfr-solver-kuhn-anchor": JSON.stringify({
    claims: [
      {
        claim: "wrote an MCCFR solver for Kuhn poker and it's working well",
        verdict: "unsupported",
        basis: "'working well' is self-consistency — no oracle demonstrates convergence to the known Kuhn poker equilibrium",
        evidence: "",
      },
    ],
    demands: [
      {
        origin_claim: "wrote an MCCFR solver for Kuhn poker and it's working well",
        gap: "'working well' has no oracle — nothing demonstrates convergence to the known Kuhn poker equilibrium",
        remedy: "Kuhn anchor: run the MCCFR solver on Kuhn poker and compare to the known analytic equilibrium strategy.",
        accept: "computed equilibrium strategy within 1e-3 of the known Kuhn values",
        test_file: "process.exit(1);\n",
        rung: "analytic",
      },
    ],
    unaccountable: false,
    note: "",
  }),
  "substantial-diff-claim-free": JSON.stringify({
    claims: [],
    demands: [],
    unaccountable: true,
    note: "state what was done and how you know it works — the diff is substantial but the summary makes no checkable claim",
  }),
};

function job(dir: string, f: Fixture): AuditJob {
  return { dir, sessionId: "fixture-run", finalMessage: f.finalMessage, userRequest: f.userRequest, ...(f.receipts ? { receipts: f.receipts } : {}) };
}

describe("replay fixtures (SPEC §6.1) — 8 scenarios through the real pipeline", () => {
  const fixtures = loadFixtures(FIXTURES_DIR);

  it("loaded exactly the 8 fixtures from eval/fixtures/", () => {
    expect(fixtures.length).toBe(8);
    expect(new Set(fixtures.map((f) => f.name)).size).toBe(8);
  });

  for (const f of fixtures) {
    it(`${f.name}: pipeline (parse -> verdict -> demand -> telemetry) matches expected shape`, async () => {
      const reply = REPLIES[f.name];
      expect(reply, `no scripted reply for fixture "${f.name}"`).toBeTruthy();

      const { dir, cleanup } = await fixtureRepo(f.repoSetup);
      cleanups.push(cleanup);

      const v = await audit(job(dir, f), fakeAuditor(reply!));

      // Parse: a well-formed reply never lands in verdict.error.
      expect(v.error).toBeUndefined();

      if (f.expected.verdict) {
        const wantV = Array.isArray(f.expected.verdict) ? f.expected.verdict : [f.expected.verdict];
        expect(v.claims.length).toBeGreaterThan(0);
        expect(v.claims.some((c) => wantV.includes(c.verdict))).toBe(true);
      }
      if (f.expected.unaccountable) {
        expect(v.unaccountable).toBe(true);
        expect(v.claims).toEqual([]);
      }
      if (f.expected.demand) {
        expect(v.demands.length).toBeGreaterThan(0);
        const wantR = f.expected.demand.rung === undefined ? undefined : Array.isArray(f.expected.demand.rung) ? f.expected.demand.rung : [f.expected.demand.rung];
        if (wantR) expect(v.demands.some((d) => wantR.includes(d.rung))).toBe(true);
        if (f.expected.demand.descriptionContains) {
          const dc = f.expected.demand.descriptionContains;
          const needles = (Array.isArray(dc) ? dc : [dc]).map((s) => s.toLowerCase());
          expect(v.demands.some((d) => needles.some((n) => `${d.gap} ${d.remedy} ${d.accept}`.toLowerCase().includes(n)))).toBe(true);
        }
        // Demand -> failing test: the pipeline materialized it (docs/DEMANDS.md phase 1).
        expect(existsSync(join(dir, "test/veritaserum"))).toBe(true);
      }
      if (f.expected.warningContains) {
        const needle = f.expected.warningContains.toLowerCase();
        expect(v.warnings.some((w) => w.toLowerCase().includes(needle))).toBe(true);
      }

      // Telemetry: one audit event landed regardless of fixture shape (R1/§7).
      const { readFirings } = await import("../src/telemetry.js");
      expect(readFirings().some((r) => r.event === "audit")).toBe(true);
    });
  }
});
