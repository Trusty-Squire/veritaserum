/**
 * Fresh-install contract: no ollama, no claude, no codex on PATH. The audit
 * either produces a Jev verdict or reports that Jev did not run. It must not
 * silently degrade to a CLI auditor, a local embedder, or an empty success.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "os";
import { join } from "node:path";
import { tempRepo } from "./helpers.js";
import { audit } from "../src/auditor.js";
import { resolveAuditor } from "../src/resolve.js";
import { runAudit } from "../src/run-audit.js";
import { readFirings } from "../src/telemetry.js";

const ENV_KEYS = [
  "PATH",
  "TYPESAFE_API_KEY",
  "VS_AUDITOR",
  "VS_AUDITOR_METERED",
  "OPENROUTER_API_KEY",
  "OLLAMA_HOST",
  "OLLAMA_BASE_URL",
  "VS_DOCTOR_CACHE_PATH",
  "VS_QUEUE_ROOT",
  "VS_TELEMETRY_PATH",
  "VS_EXECUTOR",
] as const;

const LOAD_BEARING = "I updated src/cache.ts; all 128 tests passed in 4.2 seconds.";

let saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let shimDir: string;
let cacheDir: string;
let queueDir: string;
let telemetryDir: string;
let repoDir: string;
let repoCleanup: () => Promise<void>;
let invoked: string[];

beforeEach(async () => {
  shimDir = await mkdtemp(join(tmpdir(), "vs-jev-only-shim-"));
  cacheDir = await mkdtemp(join(tmpdir(), "vs-jev-only-cache-"));
  queueDir = await mkdtemp(join(tmpdir(), "vs-jev-only-queue-"));
  telemetryDir = await mkdtemp(join(tmpdir(), "vs-jev-only-telemetry-"));
  const { dir, cleanup } = await tempRepo();
  repoDir = dir;
  repoCleanup = cleanup;
  invoked = [];

  saved = {};
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) saved[k] = v;
  }

  // CLIs that would pass today's doctor smoke tests if resolution still probed PATH.
  for (const name of ["claude", "codex", "ollama"] as const) {
    const p = join(shimDir, name);
    await writeFile(
      p,
      `#!/bin/sh\necho invoked-${name} >> "${join(shimDir, "invoked.log")}"\necho ok\nexit 0\n`,
      "utf8",
    );
    await chmod(p, 0o755);
  }

  process.env.PATH = `${shimDir}:/usr/bin:/bin`;
  process.env.VS_DOCTOR_CACHE_PATH = join(cacheDir, "doctor.json");
  process.env.VS_QUEUE_ROOT = queueDir;
  process.env.VS_TELEMETRY_PATH = join(telemetryDir, "telemetry.jsonl");
  process.env.VS_EXECUTOR = "unknown";
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.VS_AUDITOR;
  delete process.env.VS_AUDITOR_METERED;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_BASE_URL;
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await Promise.all([
    rm(shimDir, { recursive: true, force: true }),
    rm(cacheDir, { recursive: true, force: true }),
    rm(queueDir, { recursive: true, force: true }),
    rm(telemetryDir, { recursive: true, force: true }),
    repoCleanup(),
  ]);
});

describe("fresh install — Jev is the only classifier", () => {
  it("with no key, a load-bearing turn reports that Jev did not run — it does not pick a PATH CLI or silently succeed", async () => {
    const auditor = await resolveAuditor("unknown");
    expect(auditor.vendor).toBe("none");
    expect(auditor.tier).toBe("absent");

    const verdict = await audit(
      {
        dir: repoDir,
        sessionId: "fresh-install",
        finalMessage: LOAD_BEARING,
        userRequest: "fix the cache",
        harness: "unknown",
      },
      auditor,
    );

    expect(verdict.error, "parent silently degrades: empty success or auditor_absent without naming Jev").toMatch(/jev did not run/i);
    expect(verdict.claims).toEqual([]);
    expect(["jev", "none"]).toContain(verdict.vendor);

    try {
      invoked = (await import("node:fs")).readFileSync(join(shimDir, "invoked.log"), "utf8").trim().split("\n").filter(Boolean);
    } catch {
      invoked = [];
    }
    expect(invoked).toEqual([]);
  });

  it("runAudit with no key records Jev-did-not-run in telemetry and never execs claude/codex/ollama", async () => {
    const transcript = join(shimDir, "transcript.jsonl");
    await writeFile(
      transcript,
      [
        JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "fix the cache" }] } }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: LOAD_BEARING }] } }),
      ].join("\n") + "\n",
      "utf8",
    );

    await runAudit({
      dir: repoDir,
      sessionId: "fresh-run-audit",
      turnRef: "t1",
      mode: "live",
      transcriptPath: transcript,
    });

    const firings = readFirings().filter((f) => f.event === "audit");
    expect(firings.length).toBeGreaterThanOrEqual(1);
    expect(firings[0]!.caught).toMatch(/jev did not run/i);
    expect(firings[0]!.verdict).toBe("error");
    expect(["jev", "none", undefined]).toContain(firings[0]!.auditor_vendor);

    try {
      invoked = (await import("node:fs")).readFileSync(join(shimDir, "invoked.log"), "utf8").trim().split("\n").filter(Boolean);
    } catch {
      invoked = [];
    }
    expect(invoked).toEqual([]);
  });
});
