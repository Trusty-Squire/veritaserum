/**
 * `veritaserum install goose` (Lane D1 task item 4): the v1 branch only ever
 * resolved a hooks.local.json for a human to copy by hand. v3 installs the
 * rebuilt plugin (adapters/goose/{hooks,scripts}) straight into the real goose
 * plugin directory — user scope by default, project scope with `--project`.
 * The claude-code branch is untouched (no coverage change here).
 */
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyPackageRuntimeFrom, installTarget } from "../src/install.js";

// The harness only ever records the STABLE launcher path — never dist, never the
// interpreter. Those move; the command must not, or codex revokes trust and the hook goes
// silently inert. The volatile entry point lives inside the launcher script.
const expectedHookRef = "vs-hook-stop";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
  delete process.env.HOME;
  delete process.env.VS_ADVISORY;
});

describe("harness installs", () => {
  it("wires an idempotent Stop hook into Claude Code — and no VS_ADVISORY", async () => {
    const home = await withHome();
    const cwd = process.cwd();
    process.chdir(home);
    try {
      await installTarget("claude-code", {});
      await installTarget("claude-code", {});
      const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
      expect(settings.hooks.Stop[0].hooks[0].command).toContain(expectedHookRef);
      expect(settings.hooks.Stop).toHaveLength(1); // installing twice adds one hook, not two
      // VS_ADVISORY gated nothing (R5: the audit path never blocks), and the install
      // ceremony's "unset it to enable blocking" was false. It is not written any more.
      expect(settings.hooks.Stop[0].hooks[0].command).not.toContain("VS_ADVISORY");
    } finally {
      process.chdir(cwd);
    }
  });

  it("merges a Stop hook into Codex's live hooks.json", async () => {
    const home = await withHome();
    const res = await installTarget("codex", {});
    const settings = JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(expectedHookRef);
    expect(settings.hooks.Stop[0].hooks[0].command).not.toContain("VS_ADVISORY");
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain("hook-prompt");
    expect(res.primaryFile).toBe(join(home, ".codex", "hooks.json"));
  });

  it("registers Stop plus the documented prompt-feedback hook on codex — never SessionStart", async () => {
    const home = await withHome();
    await installTarget("codex", {});
    const settings = JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"));
    expect(Object.keys(settings.hooks)).toEqual(["Stop", "UserPromptSubmit"]);
    expect(settings.hooks.Stop[0].hooks).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit[0].hooks).toHaveLength(1);
  });
});

async function withHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vs-install-home-"));
  cleanups.push(async () => {
    await rm(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  return home;
}


describe("installTarget(\"goose\") — rebuilt plugin install (SPEC §3 goose adapter)", () => {
  it(
    "user scope (default): copies hooks/hooks.json + scripts/vs-stop.sh into ~/.agents/plugins/veritaserum/, script chmod +x",
    async () => {
      const home = await withHome();
      const res = await installTarget("goose", {});

      const dest = join(home, ".agents", "plugins", "veritaserum");
      const hooksJson = await readFile(join(dest, "hooks", "hooks.json"), "utf8");
      expect(JSON.parse(hooksJson).hooks.Stop).toBeDefined();

      const scriptPath = join(dest, "scripts", "vs-stop.sh");
      const st = await stat(scriptPath);
      expect(st.mode & 0o111).not.toBe(0); // executable bits set

      expect(res.steps.some((l) => l.includes("hooks.json"))).toBe(true);
      expect(res.steps.some((l) => l.includes("vs-stop.sh"))).toBe(true);
      expect(res.manual.some((l) => l.includes("user scope"))).toBe(true);
    },
    120_000,
  );

  it("--project: installs into <cwd>/.agents/plugins/veritaserum/ instead", async () => {
    await withHome();
    const projectDir = await mkdtemp(join(tmpdir(), "vs-install-project-"));
    cleanups.push(async () => {
      await rm(projectDir, { recursive: true, force: true });
    });
    const originalCwd = process.cwd();
    process.chdir(projectDir);
    try {
      const res = await installTarget("goose", { project: true });
      const dest = join(projectDir, ".agents", "plugins", "veritaserum");
      await stat(join(dest, "hooks", "hooks.json")); // throws if missing
      await stat(join(dest, "scripts", "vs-stop.sh"));
      expect(res.manual.some((l) => l.includes("project scope"))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  }, 120_000);
});

describe("copyPackageRuntimeFrom — nested dependency closure", () => {
  it("preserves conflicting transitive versions in a nested runtime layout", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vs-runtime-closure-"));
    cleanups.push(async () => {
      rmSync(workspace, { recursive: true, force: true });
    });

    const packageDir = join(workspace, "pkg");
    const runtimeModules = join(workspace, "runtime", "node_modules");
    mkdirSync(join(packageDir, "dist"), { recursive: true });
    mkdirSync(join(packageDir, "node_modules", "foo"), { recursive: true });
    mkdirSync(join(packageDir, "node_modules", "bar", "node_modules", "foo"), { recursive: true });

    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "root-app", version: "1.0.0", dependencies: { foo: "1.0.0", bar: "1.0.0" } }, null, 2) + "\n",
    );
    writeFileSync(
      join(packageDir, "dist", "entry.cjs"),
      "module.exports = { foo: require('foo').version, bar: require('bar') };\n",
    );
    writeFileSync(join(packageDir, "node_modules", "foo", "package.json"), JSON.stringify({ name: "foo", version: "1.0.0", main: "index.cjs" }, null, 2) + "\n");
    writeFileSync(join(packageDir, "node_modules", "foo", "index.cjs"), "module.exports = { version: 'foo-v1' };\n");
    writeFileSync(
      join(packageDir, "node_modules", "bar", "package.json"),
      JSON.stringify({ name: "bar", version: "1.0.0", main: "index.cjs", dependencies: { foo: "2.0.0" } }, null, 2) + "\n",
    );
    writeFileSync(
      join(packageDir, "node_modules", "bar", "index.cjs"),
      "module.exports = { version: 'bar-v1', fooVersion: require('foo').version };\n",
    );
    writeFileSync(
      join(packageDir, "node_modules", "bar", "node_modules", "foo", "package.json"),
      JSON.stringify({ name: "foo", version: "2.0.0", main: "index.cjs" }, null, 2) + "\n",
    );
    writeFileSync(join(packageDir, "node_modules", "bar", "node_modules", "foo", "index.cjs"), "module.exports = { version: 'foo-v2' };\n");

    copyPackageRuntimeFrom(packageDir, runtimeModules);

    const runtimeRoot = join(runtimeModules, "veritaserum");
    const runtimeRequire = createRequire(join(runtimeRoot, "dist", "entry.cjs"));
    const entry = runtimeRequire(join(runtimeRoot, "dist", "entry.cjs")) as { foo: string; bar: { version: string; fooVersion: string } };

    expect(entry).toEqual({ foo: "foo-v1", bar: { version: "bar-v1", fooVersion: "foo-v2" } });
    expect(existsSync(join(runtimeRoot, "node_modules", "foo", "index.cjs"))).toBe(true);
    expect(existsSync(join(runtimeRoot, "node_modules", "bar", "node_modules", "foo", "index.cjs"))).toBe(true);
  });

  it("terminates on a dependency cycle — the cyclic dep resolves to its ancestor copy", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vs-runtime-cycle-"));
    cleanups.push(async () => {
      rmSync(workspace, { recursive: true, force: true });
    });

    const packageDir = join(workspace, "pkg");
    const runtimeModules = join(workspace, "runtime", "node_modules");
    mkdirSync(join(packageDir, "dist"), { recursive: true });
    mkdirSync(join(packageDir, "node_modules", "a"), { recursive: true });
    mkdirSync(join(packageDir, "node_modules", "b"), { recursive: true });

    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "root-app", version: "1.0.0", dependencies: { a: "1.0.0" } }, null, 2) + "\n",
    );
    writeFileSync(join(packageDir, "dist", "entry.cjs"), "module.exports = require('a');\n");
    writeFileSync(
      join(packageDir, "node_modules", "a", "package.json"),
      JSON.stringify({ name: "a", version: "1.0.0", main: "index.cjs", dependencies: { b: "1.0.0" } }, null, 2) + "\n",
    );
    writeFileSync(join(packageDir, "node_modules", "a", "index.cjs"), "module.exports = { name: 'a', b: require('b').name };\n");
    writeFileSync(
      join(packageDir, "node_modules", "b", "package.json"),
      JSON.stringify({ name: "b", version: "1.0.0", main: "index.cjs", dependencies: { a: "1.0.0" } }, null, 2) + "\n",
    );
    writeFileSync(join(packageDir, "node_modules", "b", "index.cjs"), "module.exports = { name: 'b' };\n");

    copyPackageRuntimeFrom(packageDir, runtimeModules);

    const runtimeRoot = join(runtimeModules, "veritaserum");
    const runtimeRequire = createRequire(join(runtimeRoot, "dist", "entry.cjs"));
    expect(runtimeRequire(join(runtimeRoot, "dist", "entry.cjs"))).toEqual({ name: "a", b: "b" });
    expect(existsSync(join(runtimeRoot, "node_modules", "a", "node_modules", "b"))).toBe(true);
    expect(existsSync(join(runtimeRoot, "node_modules", "a", "node_modules", "b", "node_modules", "a"))).toBe(false);
  });
});

/**
 * A hook runs in whatever environment the harness hands it. `node` on an interactive PATH is
 * often NOT a stable binary — under fnm it is /run/user/<uid>/fnm_multishells/<pid>_<ts>/bin/node,
 * a directory scoped to one shell that evaporates with it. A hook command that resolves the
 * interpreter through PATH dies with exit 127 in exactly the situations the user cannot see
 * (this is what "UserPromptSubmit hook (failed) — exited with code 127" was), and if some other
 * node IS found it may be too old for the builtins we need (node:sqlite → 22+), which crashes
 * differently. Pin the interpreter that ran the installer: it exists and is version-correct.
 */
describe("hook commands pin the interpreter — never a bare `node`", () => {
  it("writes an absolute node path, so PATH cannot break the hook", async () => {
    const home = await withHome();
    const res = await installTarget("codex", {});
    const settings = JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"));
    const commands: string[] = settings.hooks.Stop.concat(settings.hooks.UserPromptSubmit)
      .flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command));

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      // The command names only the stable launcher — that string must never move (trust).
      expect(command).toContain(join(home, ".veritaserum", "bin", "vs-hook"));
      expect(command).not.toMatch(/(^|\s)node\s/); // never a PATH-resolved bare `node`
    }
    // ...and the interpreter is pinned INSIDE the launcher, where it can change freely.
    for (const sub of ["vs-hook-stop", "vs-hook-prompt"]) {
      const body = await readFile(join(home, ".veritaserum", "bin", sub), "utf8");
      expect(body).toContain(process.execPath);
      expect(body).not.toMatch(/exec node\s/);
    }
    expect(res.hookCmd).toContain("vs-hook-stop");
  });
});

/**
 * codex hashes the hook COMMAND to decide trust. Any edit to that string — a pinned
 * interpreter, a moved dist, an upgrade — silently returns the hook to "needs review",
 * where codex loads it and runs NOTHING. No error, no warning. Veritaserum switched itself
 * off on codex three times this way, each time while fixing something else. An installer
 * whose every improvement disables the product is not viable.
 *
 * So the harness only ever sees a stable launcher path. Everything volatile lives inside it.
 */
describe("the hook command must survive an upgrade — trust is granted once", () => {
  it("moving the interpreter and the dist rewrites the LAUNCHER, never the command", async () => {
    const home = await withHome();

    const first = await installTarget("codex", {});
    const before = JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"));
    const cmdBefore: string = before.hooks.Stop[0].hooks[0].command;
    const launcherBefore = await readFile(join(home, ".veritaserum", "bin", "vs-hook-stop"), "utf8");

    // The harness records a path under the user's own state dir — not the dev tree, not an
    // npx cache, not a version-pinned node. Those are the things that move.
    expect(cmdBefore).toContain(join(home, ".veritaserum", "bin", "vs-hook-stop"));
    expect(first.hookCmd).toBe(cmdBefore);

    // Re-install (an upgrade). The launcher is rewritten; the command must not move.
    await installTarget("codex", {});
    const after = JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"));
    expect(after.hooks.Stop[0].hooks[0].command).toBe(cmdBefore);
    expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      before.hooks.UserPromptSubmit[0].hooks[0].command,
    );

    // ...and the launcher still points at a real, runnable entry point.
    const launcherAfter = await readFile(join(home, ".veritaserum", "bin", "vs-hook-stop"), "utf8");
    expect(launcherAfter).toMatch(/^#!\/bin\/sh/);
    expect(launcherAfter).toContain("exec ");
    expect(launcherAfter).toContain(process.execPath); // the volatile interpreter lives HERE
    expect(launcherBefore).toContain(process.execPath);

    // Installing twice must not accumulate hooks either.
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.UserPromptSubmit).toHaveLength(1);
  });
});
