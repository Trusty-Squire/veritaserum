/**
 * `veritaserum install <claude-code|goose|codex>` — the one-command Stop-hook
 * installer, npx-friendly. Wires `veritaserum hook-stop` (the confabulation
 * sentinel) into a harness so it fires on every turn-end, and (claude-code)
 * registers the MCP server via `claude mcp add`. Idempotent, backs up before
 * editing; direct file writes stay inside .claude/, ~/.claude/, or this
 * package's adapters/ — MCP registration is delegated to the claude CLI.
 */
import { execa } from "execa";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as s from "./style.js";

export const TARGETS = ["claude-code", "goose", "codex"] as const;
export type Target = (typeof TARGETS)[number];
const VENDOR: Record<Target, string> = { "claude-code": "claude", goose: "unknown", codex: "codex" };

export function isTarget(x: string): x is Target {
  return (TARGETS as readonly string[]).includes(x);
}

/** Package root (…/ser), from this compiled file at …/ser/dist/install.js. */
function pkgRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * The stable command a hook should run to invoke ser. An absolute
 * `node <dist/cli.js>` survives across sessions for local/global installs; an
 * npx-cache path is ephemeral, so reference the package name to re-resolve.
 */
function cliInvocation(): string {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  if (/[\\/]_npx[\\/]/.test(entry)) return "npx -y veritaserum";
  const cliJs = join(pkgRoot(), "dist", "cli.js");
  if (existsSync(cliJs)) return `node ${cliJs}`;
  return "veritaserum";
}

function hookCommand(target: Target, sub: "hook-stop" | "hook-prompt" = "hook-stop"): string {
  return `VS_EXECUTOR=${VENDOR[target]} VS_HARNESS=${target} ${cliInvocation()} ${sub}`;
}

/**
 * How a registered MCP server should launch dist/mcp.js (same resolution logic
 * as cliInvocation; the bin `veritaserum-mcp` lives in the `veritaserum` package).
 */
function mcpInvocation(): string[] {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  if (/[\\/]_npx[\\/]/.test(entry)) return ["npx", "-y", "-p", "veritaserum", "veritaserum-mcp"];
  const mcpJs = join(pkgRoot(), "dist", "mcp.js");
  if (existsSync(mcpJs)) return ["node", mcpJs];
  return ["veritaserum-mcp"];
}

/**
 * Register the MCP server with Claude Code. The hook alone never exposes the
 * contract tools — without this step `veritaserum` is absent from `claude mcp list`
 * and users conclude the install silently failed.
 */
async function registerMcpClaudeCode(global: boolean, steps: string[], manual: string[]): Promise<void> {
  const server = mcpInvocation();
  const scope = global ? "user" : "project";
  const res = await execa("claude", ["mcp", "add", "--scope", scope, "veritaserum", "--", ...server], { reject: false });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.exitCode === 0) {
    steps.push(s.ok(`registered MCP server veritaserum (claude mcp add --scope ${scope})`));
  } else if (/already exists/i.test(out)) {
    steps.push(s.ok("MCP server already registered — no change"));
  } else {
    manual.push(`register the MCP server yourself: claude mcp add veritaserum -- ${server.join(" ")}`);
  }
}

/** Harnesses whose config dir exists on this machine (for a no-arg suggestion). */
export function detectHarnesses(): Target[] {
  const found: Target[] = [];
  if (existsSync(join(homedir(), ".claude"))) found.push("claude-code");
  if (existsSync(join(homedir(), ".config", "goose"))) found.push("goose");
  if (existsSync(join(homedir(), ".codex"))) found.push("codex");
  return found;
}

export interface InstallResult {
  target: Target;
  hookCmd: string;
  steps: string[]; // formatted status lines
  manual: string[]; // manual-completion instructions (empty when fully automated)
  primaryFile: string;
}

export async function installTarget(target: Target, opts: { global?: boolean; project?: boolean }): Promise<InstallResult> {
  const hookCmd = hookCommand(target);
  if (target === "claude-code") return installClaudeCode(hookCmd, opts.global === true);
  if (target === "goose") return installGoose(opts.project === true);
  return installResolvedAdapter("codex", hookCmd);
}

// --- claude-code: merge a Stop hook into settings.json ----------------------

interface HookEntry {
  type: string;
  command: string;
}
interface HookGroup {
  hooks?: HookEntry[];
}
interface Settings {
  hooks?: { Stop?: HookGroup[]; UserPromptSubmit?: HookGroup[] } & Record<string, unknown>;
  [k: string]: unknown;
}

/** Merge one command hook into settings.hooks[event], idempotently. Returns true when added. */
function mergeHook(settings: Settings, event: "Stop" | "UserPromptSubmit", cmd: string): boolean {
  const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as {
    Stop?: HookGroup[];
    UserPromptSubmit?: HookGroup[];
  };
  const groups = Array.isArray(hooks[event]) ? hooks[event]! : [];
  if (groups.some((g) => Array.isArray(g.hooks) && g.hooks.some((h) => h.command === cmd))) return false;
  groups.push({ hooks: [{ type: "command", command: cmd }] });
  hooks[event] = groups;
  settings.hooks = hooks;
  return true;
}

async function installClaudeCode(hookCmd: string, global: boolean): Promise<InstallResult> {
  const file = global ? join(homedir(), ".claude", "settings.json") : join(process.cwd(), ".claude", "settings.json");
  const steps: string[] = [];
  mkdirSync(dirname(file), { recursive: true });

  let settings: Settings = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(`${file} is not valid JSON — refusing to touch it (${err instanceof Error ? err.message : String(err)})`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${file} does not contain a JSON object — refusing to touch it`);
      }
      settings = parsed as Settings;
    }
    copyFileSync(file, `${file}.vs-bak`);
    steps.push(s.ok(`backed up ${s.dim(file + ".vs-bak")}`));
  }

  const addedStop = mergeHook(settings, "Stop", hookCmd);
  const addedPrompt = mergeHook(settings, "UserPromptSubmit", hookCommand("claude-code", "hook-prompt"));
  if (addedStop || addedPrompt) {
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    const added = [addedStop && "Stop", addedPrompt && "UserPromptSubmit"].filter(Boolean).join(" + ");
    steps.push(s.ok(`added ${added} hook(s) to ${s.dim(file)}`));
  } else {
    steps.push(s.ok(`already installed — no change to ${s.dim(file)}`));
  }

  const manual: string[] = [];
  await registerMcpClaudeCode(global, steps, manual);
  return { target: "claude-code", hookCmd, steps, manual, primaryFile: file };
}

// --- goose: install the real plugin (v3, SPEC.md §3 "goose first" / §4
//     "goose/codex adapters (v1 shapes) — goose: rebuild (first-class)"). goose
//     auto-discovers <plugin-root>/hooks/hooks.json for any enabled plugin
//     (adapters/goose/README.md), so — unlike the v1 branch this replaces,
//     which only ever resolved a hooks.local.json for the human to copy by
//     hand — this copies the whole rebuilt plugin (hooks/ + scripts/vs-stop.sh,
//     which self-resolves the CLI; no hookCmd templating needed) straight into
//     the real plugin directory: user scope by default, project scope with
//     --project. -----------------------------------------------------------

function gooseDest(project: boolean): string {
  return project ? join(process.cwd(), ".agents", "plugins", "veritaserum") : join(homedir(), ".agents", "plugins", "veritaserum");
}

function installGoose(project: boolean): InstallResult {
  const adapterDir = join(pkgRoot(), "adapters", "goose");
  const dest = gooseDest(project);
  const steps: string[] = [];

  const hooksSrc = join(adapterDir, "hooks", "hooks.json");
  if (!existsSync(hooksSrc)) throw new Error(`${hooksSrc} not found — adapters/goose layout changed?`);
  const hooksDestDir = join(dest, "hooks");
  mkdirSync(hooksDestDir, { recursive: true });
  const hooksDest = join(hooksDestDir, "hooks.json");
  copyFileSync(hooksSrc, hooksDest);
  steps.push(s.ok(`copied hooks.json → ${s.dim(hooksDest)}`));

  const scriptsSrc = join(adapterDir, "scripts");
  const scriptsDestDir = join(dest, "scripts");
  mkdirSync(scriptsDestDir, { recursive: true });
  for (const f of readdirSync(scriptsSrc)) {
    const from = join(scriptsSrc, f);
    const to = join(scriptsDestDir, f);
    copyFileSync(from, to);
    chmodSync(to, 0o755);
    steps.push(s.ok(`copied ${f} → ${s.dim(to)} (chmod +x)`));
  }

  return {
    target: "goose",
    hookCmd: hookCommand("goose"),
    steps,
    primaryFile: hooksDest,
    manual: [
      `plugin installed at ${s.dim(dest)} (${project ? "project" : "user"} scope).`,
      "restart goose (plugin discovery runs at startup) — no config.yaml edit, no",
      "enable step beyond the plugin existing on disk and not being disabled.",
    ],
  };
}

// --- codex: config path is version-specific; resolve locally and print
//     manual completion (mirrors the shared adapter templates). -------------

function installResolvedAdapter(target: "codex", hookCmd: string): InstallResult {
  const adapterDir = join(pkgRoot(), "adapters", target);
  const steps: string[] = [];

  const out = join(adapterDir, "config-snippet.local.toml");
  const snippet =
    `# veritaserum — resolved codex Stop hook (generated by \`veritaserum install codex\`).\n` +
    `# Append to ~/.codex/config.toml (or a project .codex/config.toml), then grant\n` +
    `# hook trust on first run (see adapters/codex/README.md).\n\n` +
    `[[hooks.Stop]]\n` +
    `type = "command"\n` +
    `command = "${hookCmd}"\n`;
  writeFileSync(out, snippet);
  steps.push(s.ok(`resolved snippet → ${s.dim(out)}`));
  return {
    target,
    hookCmd,
    steps,
    primaryFile: out,
    manual: [
      "codex config is version-specific and command hooks require interactive trust,",
      "so nothing outside this package was edited. To finish:",
      `  1. append ${s.dim(out)} to ~/.codex/config.toml`,
      "  2. approve the hook when codex asks for hook trust on first run",
    ],
  };
}
