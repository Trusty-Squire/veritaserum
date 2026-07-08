import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  logFiring,
  readFirings,
  summarize,
  summarizePrecision,
  markFalseFlag,
  telemetryPath,
  wilsonLowerBound,
  type Firing,
} from "../src/telemetry.js";

let tmpDir: string;
let prevPath: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ser-telemetry-test-"));
  prevPath = process.env.VS_TELEMETRY_PATH;
  process.env.VS_TELEMETRY_PATH = join(tmpDir, "telemetry.jsonl");
});

afterEach(() => {
  if (prevPath === undefined) delete process.env.VS_TELEMETRY_PATH;
  else process.env.VS_TELEMETRY_PATH = prevPath;
  rmSync(tmpDir, { recursive: true, force: true });
});

function firing(overrides: Partial<Omit<Firing, "ts">> = {}): Omit<Firing, "ts"> {
  return {
    harness: "claude-code",
    event: "stop",
    claim: "Done, tests pass!",
    verdict: "blocked",
    caught: "claims tests pass but no test ran",
    blocked: true,
    dir: "/tmp/whatever",
    ...overrides,
  };
}

describe("telemetry (hermetic — VS_TELEMETRY_PATH points at a temp file)", () => {
  it("logFiring twice then readFirings returns 2 records with a ts added", () => {
    expect(telemetryPath()).toBe(process.env.VS_TELEMETRY_PATH);
    logFiring(firing({ claim: "first" }));
    logFiring(firing({ claim: "second" }));
    const rows = readFirings();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.claim).toBe("first");
    expect(rows[1]?.claim).toBe("second");
    expect(typeof rows[0]?.ts).toBe("string");
    expect(rows[0]?.ts.length).toBeGreaterThan(0);
  });

  it("logFiring never throws even if the target dir is unwritable", () => {
    // A plain file where a directory is expected — mkdirSync(..., {recursive:true})
    // fails with ENOTDIR, deterministically and fast (an actually-impossible path
    // like a locked-down /proc subtree can hang mkdirSync's recursive walk instead
    // of failing outright, depending on the sandbox — this is the portable version).
    const blocker = join(tmpDir, "blocker-file");
    writeFileSync(blocker, "not a directory");
    process.env.VS_TELEMETRY_PATH = join(blocker, "sub", "x.jsonl");
    expect(() => logFiring(firing())).not.toThrow();
  });

  it("summarize reports the firing count and the caught count", () => {
    const rows: Firing[] = [
      { ts: "2026-01-01T00:00:00.000Z", ...firing({ caught: "unsupported claim A", blocked: true }) },
      { ts: "2026-01-01T00:01:00.000Z", ...firing({ caught: "", blocked: false, verdict: "grounded" }) },
      { ts: "2026-01-01T00:02:00.000Z", ...firing({ caught: "unsupported claim B", blocked: false, verdict: "error" }) },
    ];
    const s = summarize(rows);
    expect(s).toContain("3 firing(s)");
    expect(s).toMatch(/caught.*2/);
  });
});

describe("wilsonLowerBound — hand-computed spot checks (z=1.96, textbook formula)", () => {
  it("9/10 successes → LB ≈ 0.596", () => {
    expect(wilsonLowerBound(9, 10)).toBeCloseTo(0.596, 2);
  });
  it("45/50 successes → LB ≈ 0.787", () => {
    expect(wilsonLowerBound(45, 50)).toBeCloseTo(0.787, 2);
  });
  it("0 trials → 0 (no evidence, no bound to report)", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
  it("more trials at the same ratio tightens the bound (precedent amortizes, SPEC §2)", () => {
    expect(wilsonLowerBound(45, 50)).toBeGreaterThan(wilsonLowerBound(9, 10));
  });
});

describe("summarizePrecision — per-law-entry precision + vague-turn rate (SPEC §7)", () => {
  function audit(overrides: Partial<Firing> = {}): Firing {
    return {
      ts: "2026-01-01T00:00:00.000Z",
      harness: "goose",
      event: "audit",
      claim: "x",
      verdict: "supported",
      caught: "",
      blocked: false,
      dir: "/tmp/repo",
      ...overrides,
    };
  }

  it("counts judged events and catches per law id, and computes precision with a Wilson LB", () => {
    const rows: Firing[] = [
      audit({ ts: "1", law_ids: ["law1"], verdict: "supported" }),
      audit({ ts: "2", law_ids: ["law1"], verdict: "contradicted" }), // a true catch
      audit({ ts: "3", law_ids: ["law1"], verdict: "contradicted", false_flag: true }), // a wrong catch
      audit({ ts: "4", law_ids: ["law2"], verdict: "contradicted" }),
    ];
    const report = summarizePrecision(rows);
    const law1 = report.byLaw.find((l) => l.lawId === "law1")!;
    expect(law1.judgedEvents).toBe(3);
    expect(law1.catches).toBe(2);
    expect(law1.falseFlags).toBe(1);
    expect(law1.precision).toBeCloseTo(0.5, 5); // 1 true catch / 2 total catches
    expect(law1.precisionLowerBound).toBe(wilsonLowerBound(1, 2));

    const law2 = report.byLaw.find((l) => l.lawId === "law2")!;
    expect(law2.judgedEvents).toBe(1);
    expect(law2.catches).toBe(1);
    expect(law2.falseFlags).toBe(0);
    expect(law2.precision).toBe(1);
  });

  it("precision is null for a law entry that has never caught anything", () => {
    const rows: Firing[] = [audit({ ts: "1", law_ids: ["law1"], verdict: "supported" })];
    const report = summarizePrecision(rows);
    expect(report.byLaw[0]!.precision).toBeNull();
    expect(report.byLaw[0]!.precisionLowerBound).toBe(0);
  });

  it("vague-turn rate = R9 events / audited turns, ignoring non-audit events", () => {
    const rows: Firing[] = [
      audit({ ts: "1", vague_turn: true }),
      audit({ ts: "2", vague_turn: false }),
      audit({ ts: "3", vague_turn: true }),
      { ts: "4", harness: "goose", event: "stop", claim: "", verdict: "pass", caught: "", blocked: false, dir: "/tmp" },
    ];
    const report = summarizePrecision(rows);
    expect(report.auditedTurns).toBe(3);
    expect(report.vagueTurns).toBe(2);
    expect(report.vagueTurnRate).toBeCloseTo(2 / 3, 5);
  });

  it("empty input → zeroed report, no division by zero", () => {
    const report = summarizePrecision([]);
    expect(report.byLaw).toEqual([]);
    expect(report.auditedTurns).toBe(0);
    expect(report.vagueTurnRate).toBe(0);
  });
});

describe("markFalseFlag", () => {
  it("marks the matching firing's false_flag=true, in place, and leaves others untouched", () => {
    // Explicit, distinct ts values — two logFiring calls in the same tick can
    // otherwise share one Date.toISOString() millisecond and collide.
    const rows: Firing[] = [
      { ts: "2026-01-01T00:00:00.001Z", ...firing({ claim: "a", verdict: "contradicted" }) },
      { ts: "2026-01-01T00:00:00.002Z", ...firing({ claim: "b", verdict: "contradicted" }) },
    ];
    writeFileSync(telemetryPath(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const targetTs = rows[0]!.ts;

    const n = markFalseFlag(targetTs);
    expect(n).toBe(1);

    const after = readFirings();
    expect(after[0]!.false_flag).toBe(true);
    expect(after[1]!.false_flag).toBeUndefined();
  });

  it("a non-matching timestamp updates nothing and never throws", () => {
    logFiring(firing());
    expect(markFalseFlag("no-such-ts")).toBe(0);
    expect(readFirings()[0]!.false_flag).toBeUndefined();
  });

  it("never throws even when the telemetry file doesn't exist yet", () => {
    expect(() => markFalseFlag("whatever")).not.toThrow();
    expect(markFalseFlag("whatever")).toBe(0);
  });
});
