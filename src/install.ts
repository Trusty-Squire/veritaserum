/**
 * `veritaserum install <claude-code|goose|codex>` — the one-command Stop-hook
 * installer, npx-friendly. Wires `veritaserum hook-stop` (the confabulation
 * sentinel) into a harness so it fires on every turn-end. Registration is
 * a direct config write (no vendor binary dependency), idempotent, backed up
 * to <file>.vs-bak before the first edit.
 *
 * There is no MCP server and no cursor target any more: the MCP surface existed
 * solely to expose the contract tools (knight/judge/transcriber), and cursor was
 * an MCP-only target with no turn-end hook — so it installed nothing that could
 * catch a false "done". The hook IS the product.
 */
import { execa } from "execa";
import { parseDocument, Document } from "yaml";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, chmodSync, cpSync } from "node:fs";
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

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Copy the installed package plus its working dependency layout into a hook-owned
 * runtime. npm uses nested dependencies for a global install and hoists them beside
 * the package for `npm exec`/npx; preserve whichever layout is actually present. */
function copyPackageRuntime(runtimeModules: string): void {
  mkdirSync(runtimeModules, { recursive: true });
  const nestedModules = join(pkgRoot(), "node_modules");
  if (existsSync(nestedModules)) {
    const runtimePackage = join(runtimeModules, "veritaserum");
    mkdirSync(runtimePackage, { recursive: true });
    cpSync(join(pkgRoot(), "dist"), join(runtimePackage, "dist"), { recursive: true, force: true });
    copyFileSync(join(pkgRoot(), "package.json"), join(runtimePackage, "package.json"));
    cpSync(nestedModules, join(runtimePackage, "node_modules"), { recursive: true, force: true, dereference: true });
    return;
  }
  cpSync(dirname(pkgRoot()), runtimeModules, { recursive: true, force: true, dereference: true });
}

let durableNpxRuntime: { cli: string; hook: string } | undefined;

/** npx's cache is disposable. Installing a persistent hook from it must first leave
 * behind an offline-capable runtime under veritaserum's own state directory. */
function npxRuntimeInvocations(): { cli: string; hook: string } {
  if (durableNpxRuntime) return durableNpxRuntime;
  const runtimeModules = join(homedir(), ".veritaserum", "runtime", "node_modules");
  copyPackageRuntime(runtimeModules);
  const runtimePackage = join(runtimeModules, "veritaserum", "dist");
  durableNpxRuntime = {
    cli: `node ${shellQuote(join(runtimePackage, "cli.js"))}`,
    hook: `node ${shellQuote(join(runtimePackage, "hook-cli.cjs"))}`,
  };
  return durableNpxRuntime;
}

/**
 * The stable command a hook should run to invoke ser. An absolute
 * `node <dist/cli.js>` survives across sessions for local/global installs. An
 * npx-cache path does not, so npx installs use the durable private runtime.
 */
function cliInvocation(): string {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  if (/[\\/]_npx[\\/]/.test(entry)) return npxRuntimeInvocations().cli;
  const cliJs = join(pkgRoot(), "dist", "cli.js");
  if (existsSync(cliJs)) return `node ${shellQuote(cliJs)}`;
  return "veritaserum";
}

function hookInvocation(): string {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  if (/[\\/]_npx[\\/]/.test(entry)) return npxRuntimeInvocations().hook;
  const hookJs = join(pkgRoot(), "dist", "hook-cli.cjs");
  if (existsSync(hookJs)) return `node ${shellQuote(hookJs)}`;
  return "veritaserum-hook";
}

/** The command the executor should run to check a demand — resolved the same way the
 *  installed hook is, so it is copy-pasteable in whatever shape veritaserum was invoked
 *  (npx, a linked bin, or this checkout). The feedback line is the only place the
 *  executor ever learns this exists (run-audit.ts's buildFeedbackLine). */
export function demandsCommand(): string {
  return `${cliInvocation()} demands`;
}

function hookCommand(target: Target, sub: "hook-stop" | "hook-prompt" = "hook-stop"): string {
  // No VS_ADVISORY prefix: nothing in the audit path blocks (R5 warn-primary), so an
  // "advisory mode" env var gated nothing and the install ceremony's "unset it to enable
  // blocking" was simply false. Blocking is per-law-entry and human-promoted, never a flag.
  const invocation = sub === "hook-stop" ? hookInvocation() : `${cliInvocation()} ${sub}`;
  return `VS_EXECUTOR=${VENDOR[target]} VS_HARNESS=${target} ${invocation}${sub === "hook-stop" ? "" : ""}`;
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
  // Goose has its own self-contained plugin runtime. Avoid also materializing the
  // shared Claude/Codex runtime merely to populate InstallResult.hookCmd.
  if (target === "goose") return installGoose(opts.project === true);
  const hookCmd = hookCommand(target);
  if (target === "claude-code") return installClaudeCode(hookCmd, opts.global === true);
  return installResolvedAdapter("codex", hookCmd);
}

// --- claude-code: merge a Stop hook into settings.json ----------------------

interface HookEntry {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}
type HookEvent = "Stop" | "UserPromptSubmit" | "SessionStart";
interface Settings {
  hooks?: Partial<Record<HookEvent, HookGroup[]>> & Record<string, unknown>;
  [k: string]: unknown;
}

/** Merge one command hook into settings.hooks[event], idempotently. Returns true when added.
 *  `matcher` scopes SessionStart hooks (e.g. "compact"). */
function mergeHook(settings: Settings, event: HookEvent, cmd: string, matcher?: string): boolean {
  const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Partial<Record<HookEvent, HookGroup[]>>;
  const groups = Array.isArray(hooks[event]) ? hooks[event]! : [];
  if (groups.some((g) => Array.isArray(g.hooks) && g.hooks.some((h) => h.command === cmd))) return false;
  const harness = cmd.match(/\bVS_HARNESS=([^\s]+)/)?.[1];
  const subcommand = cmd.trim().split(/\s+/).at(-1);
  if (harness && subcommand) {
    for (const group of groups) {
      const existing = group.hooks?.find(
        (hook) => hook.command.includes(`VS_HARNESS=${harness}`) && hook.command.trim().endsWith(` ${subcommand}`),
      );
      if (existing) {
        existing.command = cmd;
        hooks[event] = groups;
        settings.hooks = hooks;
        return true;
      }
    }
  }
  groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmd }] });
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

  // A Goose plugin outlives the `npx` process that installed it. Copy a private,
  // offline-capable runtime instead of pointing the hook at npm's ephemeral bin
  // shim or at a nonexistent ../../dist directory. Packed npm installs have one
  // of two dependency layouts: nested under the package (global install), or
  // hoisted beside it (`npx`). Preserve the working layout verbatim.
  const invokedEntry = process.argv[1] ? resolve(process.argv[1]) : "";
  if (invokedEntry === join(pkgRoot(), "dist", "cli.js") || /[\\/]_npx[\\/]/.test(invokedEntry)) {
    copyPackageRuntime(join(dest, "runtime", "node_modules"));
    steps.push(s.ok(`copied self-contained hook runtime → ${s.dim(join(dest, "runtime"))}`));
  }


  return {
    target: "goose",
    hookCmd: join(dest, "scripts", "vs-stop.sh"),
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
  const steps: string[] = [];
  const out = join(homedir(), ".codex", "hooks.json");
  mkdirSync(dirname(out), { recursive: true });

  let settings: Settings = {};
  if (existsSync(out)) {
    const raw = readFileSync(out, "utf8").trim();
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(`${out} is not valid JSON — refusing to touch it (${err instanceof Error ? err.message : String(err)})`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${out} does not contain a JSON object — refusing to touch it`);
      }
      settings = parsed as Settings;
    }
    copyFileSync(out, `${out}.vs-bak`);
    steps.push(s.ok(`backed up ${s.dim(out + ".vs-bak")}`));
  }

  const addedStop = mergeHook(settings, "Stop", hookCmd);
  const addedPrompt = mergeHook(settings, "UserPromptSubmit", hookCommand("codex", "hook-prompt"));
  if (addedStop || addedPrompt) {
    writeFileSync(out, JSON.stringify(settings, null, 2) + "\n");
    const added = [addedStop && "Stop", addedPrompt && "UserPromptSubmit"].filter(Boolean).join(" + ");
    steps.push(s.ok(`added ${added} hook(s) to ${s.dim(out)}`));
  } else {
    steps.push(s.ok(`already installed — no change to ${s.dim(out)}`));
  }
  return {
    target,
    hookCmd,
    steps,
    primaryFile: out,
    manual: [
      "approve the veritaserum hook when codex asks for hook trust on first run",
    ],
  };
}

// --- MCP registration for the non-claude targets. Same direct-write principle
//     as registerMcpClaudeCode: never depend on the vendor binary being
//     invocable from the installer's subprocess. ----------------------------

/** Replace-or-append one `[header]` table in TOML text. Line-based (the span
 *  runs from the header line to the line before the next `[` header) so every
 *  byte outside the veritaserum table survives verbatim — a TOML round-trip
 *  through a parser would drop the user's comments and formatting. */
function upsertTomlTable(content: string, header: string, block: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  if (start !== -1) {
    let end = start + 1;
    while (end < lines.length && !lines[end]!.trim().startsWith("[")) end++;
    lines.splice(start, end - start);
  }
  const rest = lines.join("\n").trimEnd();
  return rest ? `${rest}\n\n${block}` : block;
}
