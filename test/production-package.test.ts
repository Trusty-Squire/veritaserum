/**
 * Regression coverage at the seams where the live mechanism previously died:
 * npm tarball + npm bin shims, documented Codex Stop JSON, concurrent hook
 * processes, and the durable Goose plugin left behind after `npx` exits.
 *
 * No product module is imported and no vendor CLI is mocked. The installed
 * Stop hook is held by its real lockfile only so queued jobs can be inspected
 * before an auditor consumes them.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execa } from "execa";

const ROOT = resolve(import.meta.dirname, "..");
let scratch: string;
let tarball: string;
let prefix: string;

function repoKey(repo: string): string {
  return createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 16);
}

async function initRepo(name: string): Promise<string> {
  const repo = join(scratch, name);
  mkdirSync(repo, { recursive: true });
  await execa("git", ["init", "-q"], { cwd: repo });
  await execa("git", ["config", "user.email", "package-test@invalid"], { cwd: repo });
  await execa("git", ["config", "user.name", "package test"], { cwd: repo });
  writeFileSync(
    join(repo, "veritaserum.law.yaml"),
    [
      "version: 1",
      "gates:",
      "  - id: packed-law",
      "    run: 'true'",
      "    gatePaths: []",
      "    lineage:",
      "      pattern: evaluator-demand",
      "      params: { rung: analytic, binding: true }",
      "      provenance: packed install fixture",
      "      source: evaluator-demand",
      "      retired: false",
      "repeats: []",
      "",
    ].join("\n"),
  );
  await execa("git", ["add", "-A"], { cwd: repo });
  await execa("git", ["commit", "-q", "-m", "fixture"], { cwd: repo });
  return repo;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "veritaserum-packed-regression-"));
  prefix = join(scratch, "prefix");
  const artifacts = join(scratch, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  await execa("pnpm", ["build"], { cwd: ROOT });
  const packed = await execa("npm", ["pack", "--json", "--pack-destination", artifacts], { cwd: ROOT });
  const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename;
  tarball = join(artifacts, filename);
  await execa("npm", ["install", "--global", "--prefix", prefix, tarball], { cwd: ROOT });
}, 60_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe.sequential("packed production surfaces", () => {
  it("preserves documented Codex content and turn identity in the real queued job", async () => {
    const repo = await initRepo("codex-repo");
    const home = join(scratch, "codex-home");
    const queueBase = join(scratch, "codex-queue");
    mkdirSync(home, { recursive: true });
    const bin = join(prefix, "bin", "veritaserum");
    await execa(bin, ["install", "codex"], { cwd: repo, env: { HOME: home, VS_QUEUE_ROOT: queueBase } });
    const hooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
    const command = hooks.hooks.Stop[0].hooks[0].command as string;
    expect(command).toContain("hook-cli.cjs");

    const qdir = join(queueBase, repoKey(repo));
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, ".lock"), String(process.pid));
    const transcript = join(scratch, "codex-transcript.jsonl");
    const finalMessage = "Production throughput is exactly 271828 requests per second.";
    writeFileSync(transcript, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: finalMessage } }) + "\n");
    const result = await execa("/bin/sh", ["-c", command], {
      cwd: repo,
      env: { HOME: home, VS_QUEUE_ROOT: queueBase, VS_AUDIT_MODE: "testbed", VS_AUDITOR: "claude" },
      input: JSON.stringify({
        session_id: "documented-session",
        transcript_path: transcript,
        cwd: repo,
        hook_event_name: "Stop",
        turn_id: "documented-turn",
        stop_hook_active: false,
        last_assistant_message: finalMessage,
      }),
    });
    expect(result.exitCode).toBe(0);
    // The installed hook prints the R7 standing-law state line (the fixture law
    // has one runnable gate and no green run yet). Plain text is rejected by
    // Codex's Stop contract, so it must arrive as the documented non-blocking
    // systemMessage field — never bare stdout.
    expect(JSON.parse(result.stdout)).toEqual({
      systemMessage: "veritaserum: 1 standing check(s) unverified against current tree",
    });
    const files = readdirSync(qdir).filter((name) => name.includes("__") && name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const job = JSON.parse(readFileSync(join(qdir, files[0]!), "utf8"));
    expect(job).toMatchObject({
      harness: "codex",
      executor: "codex",
      auditor: "claude",
      sessionId: "documented-session",
      turnRef: "documented-turn",
      finalMessage,
    });

    const invoke = async (suffix: string) => {
      const path = join(scratch, `concurrent-${suffix}.jsonl`);
      writeFileSync(path, `${suffix}\n`);
      return execa("sh", ["-c", command], {
        cwd: repo,
        env: { HOME: home, VS_QUEUE_ROOT: queueBase, VS_AUDIT_MODE: "testbed", VS_AUDITOR: "claude" },
        input: JSON.stringify({
          session_id: `session-${suffix}`,
          transcript_path: path,
          cwd: repo,
          hook_event_name: "Stop",
          turn_id: `turn-${suffix}`,
          last_assistant_message: `claim-${suffix}`,
        }),
      });
    };
    const concurrent = await Promise.all([invoke("a"), invoke("b")]);
    expect(concurrent.map((item) => item.exitCode)).toEqual([0, 0]);
    expect(readdirSync(qdir).filter((name) => name.includes("__") && name.endsWith(".json"))).toHaveLength(3);
  }, 30_000);

  it("leaves an npx-installed Goose hook with its own runnable package", async () => {
    const repo = await initRepo("goose-repo");
    const home = join(scratch, "goose-home");
    const cache = join(scratch, "npx-cache");
    mkdirSync(home, { recursive: true });
    const install = await execa("npm", ["exec", "--yes", `--package=${tarball}`, "--", "veritaserum", "install", "goose", "--project"], {
      cwd: repo,
      env: { HOME: home, npm_config_cache: cache },
    });
    expect(install.stdout).toContain("Goose exposes no prompt injection channel; verdicts land in telemetry.");
    expect(install.stdout).not.toContain("A verdict lands as one line at your next prompt.");
    const plugin = join(repo, ".agents", "plugins", "veritaserum");
    const hook = join(plugin, "scripts", "vs-stop.sh");
    expect(existsSync(join(plugin, "runtime", "node_modules", "veritaserum", "dist", "hook-cli.cjs"))).toBe(true);
    const nodeOnly = join(scratch, "node-only");
    mkdirSync(nodeOnly, { recursive: true });
    symlinkSync(process.execPath, join(nodeOnly, "node"));
    chmodSync(hook, 0o755);
    const result = await execa(hook, [], {
      cwd: repo,
      env: { HOME: home, PLUGIN_ROOT: plugin, PATH: `${nodeOnly}:/usr/bin:/bin` },
      input: JSON.stringify({ event: "Stop", session_id: "no-activity", working_dir: repo }),
      reject: false,
    });
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("leaves npx-installed Codex hooks independent of npm and its cache", async () => {
    const repo = await initRepo("npx-codex-repo");
    const home = join(scratch, "npx-codex-home");
    const cache = join(scratch, "npx-codex-cache");
    mkdirSync(home, { recursive: true });
    await execa("npm", ["exec", "--yes", `--package=${tarball}`, "--", "veritaserum", "install", "codex"], {
      cwd: repo,
      env: { HOME: home, npm_config_cache: cache },
    });
    const hooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
    const command = hooks.hooks.Stop[0].hooks[0].command as string;
    expect(command).toContain(join(home, ".veritaserum", "runtime", "node_modules", "veritaserum", "dist", "hook-cli.cjs"));
    expect(command).not.toContain("npx -");
    expect(command).not.toContain("/_npx/");
    expect(existsSync(join(home, ".veritaserum", "runtime", "node_modules", "veritaserum", "dist", "hook-cli.cjs"))).toBe(true);

    // The npm cache is deliberately gone and PATH contains only Node. This is the
    // persistent shape a later editor session inherits after `npx ... install` exits.
    rmSync(cache, { recursive: true, force: true });
    const nodeOnly = join(scratch, "npx-codex-node-only");
    mkdirSync(nodeOnly, { recursive: true });
    symlinkSync(process.execPath, join(nodeOnly, "node"));
    const result = await execa("/bin/sh", ["-c", command], {
      cwd: repo,
      env: { HOME: home, PATH: nodeOnly },
      input: JSON.stringify({
        session_id: "npx-persistence",
        cwd: repo,
        hook_event_name: "Stop",
        turn_id: "no-tool-activity",
        last_assistant_message: "No tool activity occurred.",
      }),
      reject: false,
    });
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("refuses the exact recursive demand captured in production before spawning it", async () => {
    const repo = await initRepo("recursive-demand-repo");
    const home = join(scratch, "recursive-demand-home");
    const queueBase = join(scratch, "recursive-demand-queue");
    const marker = join(scratch, "recursive-demand-child-ran");
    const monitor = join(scratch, "recursive-demand-monitor.cjs");
    const nestedCli = join(repo, "dist", "cli.js");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      monitor,
      `const fs = require("node:fs"), path = require("node:path");\nif (path.resolve(process.argv[1] || "") === ${JSON.stringify(nestedCli)} && process.argv[2] === "demands") { fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.exit(70); }\n`,
    );
    const demandDir = join(queueBase, repoKey(repo), "demands");
    mkdirSync(demandDir, { recursive: true });
    // This is the verbatim state-owned oracle that produced ~700 descendants in
    // the live session. NODE_OPTIONS is only a safety tripwire: if a regression
    // executes the nested command it records the exact PID and stops that child.
    writeFileSync(
      join(demandDir, "the-recorded-command-output-contains-four-lines-marked-unmet.cjs"),
      `// veritaserum demand — a failing test IS the demand. It passes only when
// the acceptance condition below is genuinely met.
// origin-claim: Three auditor demands remained unmet.
// gap: The recorded command output contains four lines marked unmet, so the reported count is false.
// remedy: Recount the current demand results and report the exact unmet count and slugs.
// accept: \`veritaserum demands\` exits normally and its output contains exactly three lines beginning with the unmet marker.
// rung: oracle
// authored: 2026-07-13T14:05:10.731Z
const cp = require('node:child_process');
const path = require('node:path');
const root = process.cwd();
const cli = path.join(root, 'dist', 'cli.js');
const run = cp.spawnSync(process.execPath, [cli, 'demands'], { cwd: root, encoding: 'utf8' });
if (run.error) {
  console.error(run.error.message);
  process.exit(1);
}
const output = \`${"${run.stdout || ''}"}\\n${"${run.stderr || ''}"}\`;
const unmet = output.split(/\\r?\\n/).filter(line => line.trimStart().startsWith('✗ unmet'));
if (run.status !== 0 || unmet.length !== 3) {
  console.error(\`expected exactly 3 unmet demands and exit 0; got exit ${"${run.status}"}, unmet ${"${unmet.length}"}\`);
  console.error(unmet.join('\\n'));
  process.exit(1);
}
process.exit(0);
`,
    );
    const started = Date.now();
    const result = await execa(join(prefix, "bin", "veritaserum"), ["demands"], {
      cwd: repo,
      env: { HOME: home, VS_QUEUE_ROOT: queueBase, NODE_OPTIONS: `--require=${monitor}` },
      timeout: 3_000,
      reject: false,
    });
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.stdout).toContain("✗ unmet");
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});
