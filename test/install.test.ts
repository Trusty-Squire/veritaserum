/**
 * `veritaserum install goose` (Lane D1 task item 4): the v1 branch only ever
 * resolved a hooks.local.json for a human to copy by hand. v3 installs the
 * rebuilt plugin (adapters/goose/{hooks,scripts}) straight into the real goose
 * plugin directory — user scope by default, project scope with `--project`.
 * The claude-code branch is untouched (no coverage change here).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTarget } from "../src/install.js";

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
      expect(settings.hooks.Stop[0].hooks[0].command).toContain("hook-stop");
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
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("hook-stop");
    expect(settings.hooks.Stop[0].hooks[0].command).not.toContain("VS_ADVISORY");
    expect(res.primaryFile).toBe(join(home, ".codex", "hooks.json"));
  });

  it("registers exactly ONE hook on codex (Stop) — it does not touch SessionStart", async () => {
    const home = await withHome();
    await installTarget("codex", {});
    const settings = JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"));
    expect(Object.keys(settings.hooks)).toEqual(["Stop"]);
    expect(settings.hooks.Stop[0].hooks).toHaveLength(1);
  });
});

async function withHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vs-install-home-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  process.env.HOME = home;
  return home;
}


describe("installTarget(\"goose\") — rebuilt plugin install (SPEC §3 goose adapter)", () => {
  it("user scope (default): copies hooks/hooks.json + scripts/vs-stop.sh into ~/.agents/plugins/veritaserum/, script chmod +x", async () => {
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
  });

  it("--project: installs into <cwd>/.agents/plugins/veritaserum/ instead", async () => {
    await withHome();
    const projectDir = await mkdtemp(join(tmpdir(), "vs-install-project-"));
    cleanups.push(() => rm(projectDir, { recursive: true, force: true }));
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
  });
});
