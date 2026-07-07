import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logFiring, readFirings, summarize, telemetryPath, type Firing } from "../src/telemetry.js";

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
