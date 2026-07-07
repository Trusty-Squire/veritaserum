/**
 * `veritaserum install <claude-code|goose|codex>` — the one-command Stop-hook
 * installer, npx-friendly. Wires `veritaserum hook-stop` (the confabulation
 * sentinel) into a harness so it fires on every turn-end. Idempotent, backs up
 * before editing, never touches a file outside .claude/, ~/.claude/, or this
 * package's adapters/.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
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

function hookCommand(target: Target): string {
  return `VS_EXECUTOR=${VENDOR[target]} VS_HARNESS=${target} ${cliInvocation()} hook-stop`;
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

export async function installTarget(target: Target, opts: { global?: boolean }): Promise<InstallResult> {
  const hookCmd = hookCommand(target);
  if (target === "claude-code") return installClaudeCode(hookCmd, opts.global === true);
  if (target === "goose") return installResolvedAdapter("goose", hookCmd);
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
  hooks?: { Stop?: HookGroup[] } & Record<string, unknown>;
  [k: string]: unknown;
}

function installClaudeCode(hookCmd: string, global: boolean): InstallResult {
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

  const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as { Stop?: HookGroup[] };
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const present = stop.some((g) => Array.isArray(g.hooks) && g.hooks.some((h) => h.command === hookCmd));

  if (present) {
    steps.push(s.ok(`already installed — no change to ${s.dim(file)}`));
  } else {
    stop.push({ hooks: [{ type: "command", command: hookCmd }] });
    hooks.Stop = stop;
    settings.hooks = hooks;
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    steps.push(s.ok(`added Stop hook to ${s.dim(file)}`));
  }
  return { target: "claude-code", hookCmd, steps, manual: [], primaryFile: file };
}

// --- goose / codex: config path is machine/version-specific; resolve locally
//     and print manual completion (mirrors the shared adapter templates). -----

function installResolvedAdapter(target: "goose" | "codex", hookCmd: string): InstallResult {
  const adapterDir = join(pkgRoot(), "adapters", target);
  const steps: string[] = [];

  if (target === "goose") {
    const src = join(adapterDir, "hooks", "hooks.json");
    const out = join(adapterDir, "hooks", "hooks.local.json");
    if (!existsSync(src)) throw new Error(`${src} not found — adapters/goose layout changed?`);
    const parsed = JSON.parse(readFileSync(src, "utf8")) as { hooks?: Record<string, unknown> };
    parsed.hooks = { ...(parsed.hooks ?? {}), Stop: [{ hooks: [{ type: "command", command: hookCmd }] }] };
    writeFileSync(out, JSON.stringify(parsed, null, 2) + "\n");
    steps.push(s.ok(`resolved hook → ${s.dim(out)}`));
    return {
      target,
      hookCmd,
      steps,
      primaryFile: out,
      manual: [
        "goose auto-discovers <plugin-root>/hooks/hooks.json for any enabled plugin,",
        "but there is no fixed global path to write. To finish:",
        `  1. copy ${s.dim(adapterDir)} into your goose plugin directory`,
        "  2. rename hooks.local.json → hooks.json in the copy",
        "  3. enable the plugin in goose",
      ],
    };
  }

  // codex
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
