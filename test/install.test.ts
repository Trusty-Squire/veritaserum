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

describe("advisory harness installs", () => {
  it("persists advisory mode in the Claude Code hook command", async () => {
    const home = await withHome();
    process.env.VS_ADVISORY = "1";
    const cwd = process.cwd();
    process.chdir(home);
    try {
      await installTarget("claude-code", {});
      await installTarget("claude-code", {});
      const settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
      expect(settings.hooks.Stop[0].hooks[0].command).toContain("VS_ADVISORY=1");
      expect(settings.hooks.Stop).toHaveLength(1);
    } finally {
      process.chdir(cwd);
    }
  });

  it("merges an advisory Stop hook into Codex's live hooks.json", async () => {
    const home = await withHome();
    process.env.VS_ADVISORY = "1";
    const res = await installTarget("codex", {});
    const settings = JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("VS_ADVISORY=1");
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("hook-stop");
    expect(res.primaryFile).toBe(join(home, ".codex", "hooks.json"));
  });
});

async function withHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "vs-install-home-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  process.env.HOME = home;
  return home;
}

describe("MCP registration on every target (not just claude-code)", () => {
  it("codex: upserts [mcp_servers.veritaserum] into ~/.codex/config.toml, replacing a stale entry and preserving the rest", async () => {
    const home = await withHome();
    await mkdir(join(home, ".codex"), { recursive: true });
    const seed = 'model = "o3"\n\n[mcp_servers.veritaserum]\ncommand = "node"\nargs = ["/stale/mcp.js"]\n\n[mcp_servers.other]\ncommand = "foo"\n';
    await writeFile(join(home, ".codex", "config.toml"), seed);

    await installTarget("codex", {});
    const first = await readFile(join(home, ".codex", "config.toml"), "utf8");
    expect(first).toContain('model = "o3"');
    expect(first).toContain("[mcp_servers.other]");
    expect(first).not.toContain("/stale/mcp.js");
    expect(first.match(/\[mcp_servers\.veritaserum\]/g)).toHaveLength(1);
    expect(await readFile(join(home, ".codex", "config.toml.vs-bak"), "utf8")).toBe(seed);

    await installTarget("codex", {});
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toBe(first);
  });

  it("goose: upserts extensions.veritaserum into ~/.config/goose/config.yaml, preserving comments and unrelated keys", async () => {
    const home = await withHome();
    await mkdir(join(home, ".config", "goose"), { recursive: true });
    const seed = "# keep-this-comment\nGOOSE_MODEL: gpt-x\nextensions:\n  other:\n    enabled: true\n    type: platform\n";
    await writeFile(join(home, ".config", "goose", "config.yaml"), seed);

    await installTarget("goose", {});
    const first = await readFile(join(home, ".config", "goose", "config.yaml"), "utf8");
    expect(first).toContain("keep-this-comment");
    expect(first).toContain("GOOSE_MODEL: gpt-x");
    expect(first).toContain("veritaserum:");
    expect(first).toContain("cmd: node");
    expect(await readFile(join(home, ".config", "goose", "config.yaml.vs-bak"), "utf8")).toBe(seed);

    await installTarget("goose", {});
    expect(await readFile(join(home, ".config", "goose", "config.yaml"), "utf8")).toBe(first);
  });

  it("cursor: writes .cursor/mcp.json in cwd (project) or ~/.cursor/mcp.json (--global), MCP only", async () => {
    const home = await withHome();
    const project = await mkdtemp(join(tmpdir(), "vs-install-cursor-"));
    cleanups.push(() => rm(project, { recursive: true, force: true }));
    const cwd = process.cwd();
    process.chdir(project);
    try {
      const res = await installTarget("cursor", {});
      const cfg = JSON.parse(await readFile(join(project, ".cursor", "mcp.json"), "utf8"));
      expect(cfg.mcpServers.veritaserum.command).toBe("node");
      expect(cfg.mcpServers.veritaserum.args[0]).toMatch(/dist\/mcp\.js$/);
      expect(res.manual.some((l) => l.includes("no veritaserum sentinel adapter"))).toBe(true);

      await installTarget("cursor", { global: true });
      const globalCfg = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8"));
      expect(globalCfg.mcpServers.veritaserum.command).toBe("node");
    } finally {
      process.chdir(cwd);
    }
  });
});

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
