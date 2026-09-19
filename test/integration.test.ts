/**
 * Sanity E2E: queueJob + runQueue running the REAL runAudit with Jev mocked
 * via fetch. Asserts the queue drains and telemetry records the Jev verdict.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempRepo, JEV_STATE_CONFAB } from "./helpers.js";
import { queueJob, queueRoot, runQueue, type AuditJob } from "../src/audit-runner.js";
import { runAudit } from "../src/run-audit.js";
import { readFirings, type Firing } from "../src/telemetry.js";

const ENV_KEYS = ["PATH", "VS_QUEUE_ROOT", "VS_TELEMETRY_PATH", "VS_EXECUTOR", "TYPESAFE_API_KEY"] as const;

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

async function repo(): Promise<string> {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  return dir;
}

describe("integration — sync enqueue → real runAudit → telemetry", () => {
  it("wires the whole chain: queue drains cleanly and a telemetry audit event is written", async () => {
    const dir = await repo();

    const transcriptPath = join(dir, "transcript.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "build the MCCFR solver" } }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Done — wrote an MCCFR solver, it's working well." }] },
        }),
      ].join("\n") + "\n",
    );

    const telemetryDir = await mkdtemp(join(tmpdir(), "vs-int-tel-"));
    const queueDir = await mkdtemp(join(tmpdir(), "vs-int-queue-"));
    cleanups.push(async () => {
      await rm(telemetryDir, { recursive: true, force: true });
      await rm(queueDir, { recursive: true, force: true });
    });

    const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
    for (const k of ENV_KEYS) {
      const v = process.env[k];
      if (v !== undefined) saved[k] = v;
    }
    process.env.PATH = `/usr/bin:/bin`;
    process.env.VS_QUEUE_ROOT = queueDir;
    process.env.VS_TELEMETRY_PATH = join(telemetryDir, "telemetry.jsonl");
    process.env.VS_EXECUTOR = "unknown";
    process.env.TYPESAFE_API_KEY = "sk-test";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(JEV_STATE_CONFAB), { status: 200 }));

    try {
      const job: AuditJob = { dir, sessionId: "s-int", turnRef: "t-int", mode: "live", transcriptPath };
      queueJob(dir, job);

      await runQueue(dir, runAudit);

      const qdir = queueRoot(dir);
      expect(existsSync(join(qdir, "dead"))).toBe(true);
      expect(readdirSync(join(qdir, "dead")).filter((f) => f.endsWith(".json"))).toHaveLength(0);

      const firings: Firing[] = readFirings();
      const auditFirings = firings.filter((f) => f.event === "audit");
      expect(auditFirings.length).toBeGreaterThanOrEqual(1);
      const last = auditFirings[auditFirings.length - 1]!;
      expect(last.verdict).toBe("contradicted");
      expect(last.auditor_vendor).toBe("jev");

      expect(existsSync(join(dir, "veritaserum.law.yaml"))).toBe(false);
    } finally {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
