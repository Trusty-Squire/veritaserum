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
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, chmodSync, cpSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
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

/**
 * The interpreter, pinned by absolute path — NEVER a bare `node`.
 *
 * A hook runs in whatever environment the harness happens to hand it, and `node` on an
 * interactive PATH is frequently not a stable binary: under fnm it is
 * /run/user/<uid>/fnm_multishells/<pid>_<ts>/bin/node — a directory scoped to ONE shell,
 * which evaporates when that shell (or the boot) goes away. A hook that resolves `node`
 * through PATH therefore dies with exit 127 (command not found) in exactly the situations
 * the user cannot see, and if some OTHER node is found instead it may be too old for the
 * builtins we require (node:sqlite → node 22+), which crashes differently.
 *
 * process.execPath is the node that is running this installer: it exists, it is version-
 * correct by construction, and it is a real path rather than a per-shell shim.
 */
function nodeBin(): string {
  return shellQuote(process.execPath);
}

function readPackageDependencies(packageDir: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})];
  } catch {
    return [];
  }
}

/** Find `name`'s package directory the way Node would from `fromDir`: walk up
 * through node_modules levels — starting from the REAL path, so a pnpm layout
 * (where a package's deps live beside its resolved dir under .pnpm/, not
 * hoisted) resolves too. */
function resolvePackageDir(fromDir: string, name: string): string | undefined {
  let current: string;
  try {
    current = realpathSync(fromDir);
  } catch {
    current = fromDir;
  }
  for (;;) {
    const base = basename(current) === "node_modules" ? current : join(current, "node_modules");
    const candidate = join(base, name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function copyPackageTree(source: string, dest: string, only?: ReadonlySet<string>): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    if (only && !only.has(entry.name)) continue;
    cpSync(join(source, entry.name), join(dest, entry.name), { recursive: true, force: true, dereference: true });
  }
}

/** The top-level entries the package actually publishes (its package.json
 * `files` field, plus package.json itself). From an npm install this matches
 * the whole directory; from a dev checkout it excludes .git, src/, test/ and
 * the rest of the repo the hook never loads. */
function publishedRootEntries(packageDir: string): Set<string> | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { files?: unknown };
    if (!Array.isArray(pkg.files) || pkg.files.length === 0) return undefined;
    const entries = new Set<string>(["package.json"]);
    for (const pattern of pkg.files) {
      if (typeof pattern !== "string" || pattern.startsWith("!")) continue;
      const top = pattern.replace(/^\.\//, "").split("/")[0];
      if (top) entries.add(top);
    }
    return entries;
  } catch {
    return undefined;
  }
}

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** Copy the installed package plus the production-dependency closure into a
 * hook-owned runtime, laid out the same way Node resolves it from the package
 * itself (nested `node_modules/<pkg>` entries, not a flat first-wins hoist).
 * Only the closure: a dev checkout's node_modules also holds devDependencies
 * (typescript, vitest — hundreds of MB) that the hook never loads. A dep whose
 * resolved source already appears in its branch's ancestry is skipped — Node's
 * upward node_modules walk resolves it to the ancestor copy — so dependency
 * cycles terminate instead of nesting forever. */
export function copyPackageRuntimeFrom(packageDir: string, runtimeModules: string): void {
  mkdirSync(runtimeModules, { recursive: true });
  const runtimePackage = join(runtimeModules, "veritaserum");
  copyPackageTree(packageDir, runtimePackage, publishedRootEntries(packageDir));

  const queue: Array<{ from: string; name: string; dest: string; ancestry: readonly string[] }> = readPackageDependencies(packageDir).map((name) => ({
    from: packageDir,
    name,
    dest: join(runtimePackage, "node_modules", name),
    ancestry: [realDir(packageDir)],
  }));
  const seen = new Set<string>();
  while (queue.length) {
    const { from, name, dest, ancestry } = queue.shift()!;
    const source = resolvePackageDir(from, name);
    if (!source) continue;
    const sourceReal = realDir(source);
    if (ancestry.includes(sourceReal)) continue;
    const key = `${source}\0${dest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    copyPackageTree(source, dest);
    const childAncestry = [...ancestry, sourceReal];
    queue.push(...readPackageDependencies(source).map((dep) => ({ from: source, name: dep, dest: join(dest, "node_modules", dep), ancestry: childAncestry })));
  }
}

let durableNpxRuntime: { cli: string; hook: string } | undefined;

/** npx's cache is disposable. Installing a persistent hook from it must first leave
 * behind an offline-capable runtime under veritaserum's own state directory. */
function npxRuntimeInvocations(): { cli: string; hook: string } {
  if (durableNpxRuntime) return durableNpxRuntime;
  const runtimeModules = join(homedir(), ".veritaserum", "runtime", "node_modules");
  copyPackageRuntimeFrom(pkgRoot(), runtimeModules);
  const runtimePackage = join(runtimeModules, "veritaserum", "dist");
  durableNpxRuntime = {
    cli: `${nodeBin()} ${shellQuote(join(runtimePackage, "cli.js"))}`,
    hook: `${nodeBin()} ${shellQuote(join(runtimePackage, "hook-cli.cjs"))}`,
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
  if (existsSync(cliJs)) return `${nodeBin()} ${shellQuote(cliJs)}`;
  return "veritaserum";
}

function hookInvocation(): string {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  if (/[\\/]_npx[\\/]/.test(entry)) return npxRuntimeInvocations().hook;
  const hookJs = join(pkgRoot(), "dist", "hook-cli.cjs");
  if (existsSync(hookJs)) return `${nodeBin()} ${shellQuote(hookJs)}`;
  return "veritaserum-hook";
}

/**
 * A STABLE launcher path, so the hook command string never changes again.
 *
 * codex hashes the hook COMMAND to decide trust. Any edit to that string — a new binary
 * path, a pinned interpreter, an upgrade that moves dist — silently returns the hook to
 * "needs review", where codex loads it and runs nothing. No error. No warning. Veritaserum
 * has now switched ITSELF off on codex three times this way, each time by fixing something
 * else. An installer whose every improvement disables the product is not viable.
 *
 * So the harness never sees a path that can change. It sees ~/.veritaserum/bin/vs-hook-*,
 * forever. The volatile parts — which node, which dist — live INSIDE that script, which we
 * rewrite freely on every install. Trust is granted once and survives every upgrade.
 */
function launcher(sub: "hook-stop" | "hook-prompt"): string {
  const dir = join(homedir(), ".veritaserum", "bin");
  const path = join(dir, sub === "hook-stop" ? "vs-hook-stop" : "vs-hook-prompt");
  const entry = sub === "hook-stop" ? hookInvocation() : `${cliInvocation()} ${sub}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    `#!/bin/sh
` +
      `# veritaserum ${sub} launcher. The harness records THIS path; it must never change.
` +
      `# Everything volatile (interpreter, dist location) lives here and is rewritten on install.
` +
      `exec ${entry} "$@"
`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return shellQuote(path);
}

function hookCommand(target: Target, sub: "hook-stop" | "hook-prompt" = "hook-stop"): string {
  // No VS_ADVISORY prefix: nothing in the audit path blocks (R5 warn-primary), so an
  // "advisory mode" env var gated nothing and the install ceremony's "unset it to enable
  // blocking" was simply false. Blocking is per-law-entry and human-promoted, never a flag.
  return `VS_EXECUTOR=${VENDOR[target]} VS_HARNESS=${target} ${launcher(sub)}`;
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

/** A command this installer (any version of it) wrote for this harness: the env
 *  marker plus any of the invocation shapes ever installed — `… npx -y veritaserum
 *  hook-stop`, `… node <path>/cli.js hook-stop`, `… node '<path>/hook-cli.cjs'`,
 *  `veritaserum-hook`. Keying on the last whitespace token misses the quoted-path
 *  shapes, which left stale Stop hooks behind on upgrade (double audits per turn). */
function isVeritaserumHookCommand(command: string, harness: string): boolean {
  return (
    command.includes(`VS_HARNESS=${harness}`) &&
    /\bveritaserum\b|veritaserum-hook|hook-cli\.cjs|\bhook-(?:stop|prompt|seal-reminder)\b/.test(command)
  );
}

/** Merge one command hook into settings.hooks[event], idempotently: any prior
 *  veritaserum hook for the same harness (whatever invocation shape wrote it) is
 *  replaced, duplicates are dropped. Returns true when the settings changed.
 *  `matcher` scopes SessionStart hooks (e.g. "compact"). */
function mergeHook(settings: Settings, event: HookEvent, cmd: string, matcher?: string): boolean {
  const hooks = (settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}) as Partial<Record<HookEvent, HookGroup[]>>;
  const groups = Array.isArray(hooks[event]) ? hooks[event]! : [];
  const harness = cmd.match(/\bVS_HARNESS=([^\s]+)/)?.[1];
  if (harness) {
    let kept = false;
    let changed = false;
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) continue;
      group.hooks = group.hooks.filter((hook) => {
        if (!isVeritaserumHookCommand(hook.command, harness)) return true;
        if (kept) {
          changed = true;
          return false;
        }
        kept = true;
        if (hook.command !== cmd) {
          hook.command = cmd;
          changed = true;
        }
        return true;
      });
    }
    if (kept) {
      hooks[event] = groups.filter((g) => !(Array.isArray(g.hooks) && g.hooks.length === 0));
      settings.hooks = hooks;
      return changed;
    }
  }
  if (groups.some((g) => Array.isArray(g.hooks) && g.hooks.some((h) => h.command === cmd))) return false;
  groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmd }] });
  hooks[event] = groups;
  settings.hooks = hooks;
  return true;
}

/** Older installers wired a SessionStart(compact) hook running the now-deleted
 *  `hook-seal-reminder` subcommand (it exits 2 as an unknown command on every
 *  compaction) and appended a seal-rule block to CLAUDE.md. Reinstalling must
 *  remove both, or an upgraded machine keeps a permanently failing hook. */
function removeSealReminderHook(settings: Settings): boolean {
  const hooks = settings.hooks;
  if (!hooks || !Array.isArray(hooks["SessionStart"])) return false;
  const groups = hooks["SessionStart"] as HookGroup[];
  let changed = false;
  for (const group of groups) {
    if (!Array.isArray(group.hooks)) continue;
    const before = group.hooks.length;
    group.hooks = group.hooks.filter((h) => !h.command.includes("hook-seal-reminder"));
    if (group.hooks.length !== before) changed = true;
  }
  if (!changed) return false;
  const pruned = groups.filter((g) => !(Array.isArray(g.hooks) && g.hooks.length === 0));
  if (pruned.length) hooks["SessionStart"] = pruned;
  else delete hooks["SessionStart"];
  return true;
}

function removeSealRuleBlock(claudeMd: string, steps: string[]): void {
  if (!existsSync(claudeMd)) return;
  const content = readFileSync(claudeMd, "utf8");
  if (!content.includes("veritaserum:seal-rule")) return;
  const cleaned = content.replace(/\n?<!-- veritaserum:seal-rule -->\n[^\n]*\n?/g, "\n");
  writeFileSync(claudeMd, cleaned);
  steps.push(s.ok(`removed stale seal rule from ${s.dim(claudeMd)}`));
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

  const removedSeal = removeSealReminderHook(settings);
  const addedStop = mergeHook(settings, "Stop", hookCmd);
  const addedPrompt = mergeHook(settings, "UserPromptSubmit", hookCommand("claude-code", "hook-prompt"));
  if (addedStop || addedPrompt || removedSeal) {
    writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
    const added = [addedStop && "Stop", addedPrompt && "UserPromptSubmit"].filter(Boolean).join(" + ");
    if (added) steps.push(s.ok(`added ${added} hook(s) to ${s.dim(file)}`));
    if (removedSeal) steps.push(s.ok(`removed stale seal-reminder hook from ${s.dim(file)}`));
  } else {
    steps.push(s.ok(`already installed — no change to ${s.dim(file)}`));
  }
  removeSealRuleBlock(global ? join(homedir(), ".claude", "CLAUDE.md") : join(process.cwd(), "CLAUDE.md"), steps);

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
  // shim. Whenever a built dist exists (global install, npx cache, or a built
  // checkout — `pnpm ser install goose` runs under tsx, so argv heuristics would
  // miss it), the plugin gets its own runtime; without one the hook scripts fail
  // open to PATH/checkout resolution.
  if (existsSync(join(pkgRoot(), "dist", "hook-cli.cjs"))) {
    copyPackageRuntimeFrom(pkgRoot(), join(dest, "runtime", "node_modules"));
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

  const before = previousCommands(settings);
  const addedStop = mergeHook(settings, "Stop", hookCmd);
  const addedPrompt = mergeHook(settings, "UserPromptSubmit", hookCommand("codex", "hook-prompt"));
  if (addedStop || addedPrompt) {
    writeFileSync(out, JSON.stringify(settings, null, 2) + "\n");
    const added = [addedStop && "Stop", addedPrompt && "UserPromptSubmit"].filter(Boolean).join(" + ");
    steps.push(s.ok(`added ${added} hook(s) to ${s.dim(out)}`));
  } else {
    steps.push(s.ok(`already installed — no change to ${s.dim(out)}`));
  }

  // VERIFY, don't assume. codex will not RUN a hook until a human trusts it, and it keys
  // that trust to a hash of the command string — so writing hooks.json installs a hook that
  // does nothing. Worse, CHANGING a command (an upgrade, a new binary path) silently returns
  // an already-trusted hook to "Review", where it is installed, reported nowhere, and inert.
  // That is how veritaserum ran on codex for a day auditing nothing while telemetry looked
  // green. An installer that cannot tell you its hook is switched off is not an installer.
  const untrusted = untrustedHooks(out, settings, before);
  const manual: string[] = [];
  if (untrusted.length) {
    steps.push(`  ${s.yellow(s.bold("!"))} ${s.yellow(`${untrusted.length} hook(s) installed but NOT ACTIVE — codex needs your trust`)}`);
    manual.push(`in codex, run ${s.bold("/hooks")} — the ${s.bold("Review")} column must read 0`);
    manual.push(`press ${s.bold("t")} to trust: ${untrusted.join(", ")}`);
    manual.push("until then codex loads these hooks and runs none of them (no error, no warning)");
  } else {
    // Careful with this claim: we check that a trust entry EXISTS for the slot and that we
    // did not change the command under it. We cannot recompute codex's trusted_hash, so a
    // record staled by something else (a manual edit, another tool) would still read as
    // trusted here. Say what we actually know, and point at the authority.
    steps.push(s.ok("codex has a trust record for these hooks"));
    steps.push(s.step(`confirm with ${s.bold("/hooks")} in codex — the ${s.bold("Review")} column must read 0`));
  }
  manual.push("already-running codex sessions read hooks.json at startup — restart them");

  return { target, hookCmd, steps, primaryFile: out, manual };
}

/** The command currently wired for each hook slot, before we touch it. */
function previousCommands(settings: Settings): Map<string, string> {
  const out = new Map<string, string>();
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, gi) => {
      (group as HookGroup).hooks?.forEach((hook, hi) => {
        out.set(`${slotEvent(event)}:${gi}:${hi}`, hook.command);
      });
    });
  }
  return out;
}

/** codex's slot key casing: SessionStart -> session_start, UserPromptSubmit -> user_prompt_submit. */
function slotEvent(event: string): string {
  return event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Which of OUR hooks codex will refuse to run. Trust lives in ~/.codex/config.toml as a
 * `trusted_hash` per slot; the hash is over the command, and we cannot recompute it — but we
 * do not need to. A hook is inert iff it has no trust entry at all, or we just changed the
 * command under an existing entry (which staled the hash). Both are decidable from the
 * config plus the hooks.json we are replacing.
 */
function untrustedHooks(hooksPath: string, settings: Settings, before: Map<string, string>): string[] {
  let config = "";
  try {
    config = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
  } catch {
    // No config at all → nothing has ever been trusted.
  }
  const inert: string[] = [];
  for (const event of ["Stop", "UserPromptSubmit"] as const) {
    const groups = (settings.hooks?.[event] ?? []) as HookGroup[];
    groups.forEach((group, gi) => {
      group.hooks?.forEach((hook, hi) => {
        if (!hook.command.includes("veritaserum") && !hook.command.includes("VS_HARNESS")) return;
        const slot = `${slotEvent(event)}:${gi}:${hi}`;
        const trusted = config.includes(`[hooks.state."${hooksPath}:${slot}"]`);
        const changed = before.get(slot) !== undefined && before.get(slot) !== hook.command;
        if (!trusted || changed) inert.push(event);
      });
    });
  }
  return [...new Set(inert)];
}
