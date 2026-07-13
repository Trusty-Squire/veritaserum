/**
 * Claude Code plugin manifest (SPEC.md §3 "Claude Code last" / §6.12 "Claude Code
 * plugin E2E"): `.claude-plugin/plugin.json` + `.mcp.json` + the contract-negotiation
 * skill, at the plugin root (this repo IS the plugin root — components at the root,
 * manifest under `.claude-plugin/`, per the current plugin reference layout).
 *
 * This is a static/structural check (parses, version sync, referenced commands
 * exist) — it does not install the plugin into a live Claude Code instance
 * (that's §6.12's "manifest install" acceptance item, not exercisable headlessly).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version: string };

interface HookEntry {
  hooks: { type: string; command: string }[];
}
interface PluginManifest {
  name: string;
  version: string;
  description: string;
  hooks?: Record<string, HookEntry[]>;
}

function loadPlugin(): PluginManifest {
  return JSON.parse(readFileSync(resolve(ROOT, ".claude-plugin", "plugin.json"), "utf8")) as PluginManifest;
}

describe("plugin manifest — .claude-plugin/plugin.json", () => {
  it("exists and parses as JSON", () => {
    expect(existsSync(resolve(ROOT, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(() => loadPlugin()).not.toThrow();
  });

  it("is named veritaserum", () => {
    expect(loadPlugin().name).toBe("veritaserum");
  });

  it("version is synced with package.json", () => {
    expect(loadPlugin().version).toBe(pkg.version);
  });

  it("wires Stop -> hook-stop and UserPromptSubmit -> hook-prompt", () => {
    const p = loadPlugin();
    const stopCmd = p.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? "";
    const promptCmd = p.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command ?? "";
    expect(stopCmd).toContain("hook-stop");
    expect(promptCmd).toContain("hook-prompt");
  });

  it("referenced hook commands (hook-stop, hook-prompt) exist as real CLI cases in src/cli.ts", () => {
    const cliSrc = readFileSync(resolve(ROOT, "src", "cli.ts"), "utf8");
    const p = loadPlugin();
    for (const event of ["Stop", "UserPromptSubmit"] as const) {
      const cmd = p.hooks?.[event]?.[0]?.hooks?.[0]?.command ?? "";
      const m = cmd.match(/\bhook-(stop|prompt)\b/);
      expect(m).not.toBeNull();
      expect(cliSrc).toContain(`case "hook-${m![1]}"`);
    }
  });

  it("hook commands invoke dist/cli.js via the plugin-relative CLAUDE_PLUGIN_ROOT", () => {
    const p = loadPlugin();
    const stopCmd = p.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? "";
    expect(stopCmd).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(stopCmd).toContain("dist/cli.js");
  });
});


