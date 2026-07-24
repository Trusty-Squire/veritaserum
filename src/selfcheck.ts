/**
 * Prove the installed hook WORKS. Not that it was written — that it runs.
 *
 * Five separate defects in one day were all the same shape: veritaserum was installed,
 * reported installed, and did nothing. A goose-DB lookup that enqueued no job for Claude
 * Code. An auditor that died on any real prompt. A codex transcript read as an empty string.
 * A hook codex loaded but never trusted. A bare `node` that resolved to nothing (exit 127).
 * Every surface said green. The audit pipeline was healthy; it just wasn't running.
 *
 * The missing property is embarrassingly simple: NOTHING EVER EXECUTED THE THING IT
 * INSTALLED. So this module does exactly that, against the harness's OWN config file (never
 * our assumption of it), in a deliberately hostile environment:
 *
 *   - PATH scrubbed to /usr/bin:/bin, so an interpreter resolved through PATH — an fnm
 *     per-shell shim, say — fails HERE instead of silently at 3am (defect 5);
 *   - a throwaway git repo and a throwaway queue, so we can assert the hook's EFFECT
 *     (a Stop hook that enqueues nothing is inert, however cleanly it exits — defect 1);
 *   - a planted verdict, so we can assert the prompt hook emits the shape THIS harness
 *     actually reads (bare text for Claude Code, a hookSpecificOutput envelope for codex —
 *     a hook that prints into the void is inert too).
 *
 * An installer that cannot demonstrate its hook running has not installed anything.
 */
import { execa } from "execa";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { queueRoot } from "./audit-runner.js";
import type { Target } from "./install.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The events veritaserum depends on, per target. EVERY hook on these matters — not only
 * ours. Stop + UserPromptSubmit everywhere; SessionStart is claude-code's Door 2 (stray
 * delivery on a fresh session), which ONLY installClaudeCode wires — codex deliberately
 * gets no SessionStart hook, so requiring one there would cry wolf.
 */
function ownedEvents(target: Target): string[] {
  return target === "claude-code" ? ["Stop", "UserPromptSubmit", "SessionStart"] : ["Stop", "UserPromptSubmit"];
}

/**
 * Every hook the harness will run on the events we depend on — ours AND anyone else's.
 *
 * Checking only our own hooks is how a debug wrapper someone left in the UserPromptSubmit
 * slot survived a "green" verification and then failed with exit 127 in a live session: a
 * hook we did not recognise was, as far as the check was concerned, not there. But the
 * harness runs it, it shares the event, it can consume the channel, and when it breaks the
 * user sees "UserPromptSubmit hook (failed)" and blames us. If it runs on our event, it is
 * in scope.
 */
export function installedHooks(target: Target): Array<{ event: string; command: string; ours: boolean }> {
  const out: Array<{ event: string; command: string; ours: boolean }> = [];
  const file =
    target === "codex"
      ? join(homedir(), ".codex", "hooks.json")
      : target === "claude-code"
        ? join(homedir(), ".claude", "settings.json")
        : "";
  if (!file || !existsSync(file)) return out;
  let config: { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
  try {
    config = JSON.parse(readFileSync(file, "utf8")) as typeof config;
  } catch {
    return out;
  }
  const events = ownedEvents(target);
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    if (!events.includes(event)) continue;
    for (const group of groups ?? []) {
      for (const hook of group.hooks ?? []) {
        const command = hook.command ?? "";
        if (!command) continue;
        out.push({ event, command, ours: command.includes("VS_HARNESS") || command.includes("veritaserum") });
      }
    }
  }
  return out;
}

/** A disposable git repo — the hook must work on a real one, not a bare directory. */
async function scratchRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "vs-selfcheck-repo-"));
  await execa("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "x\n", "utf8");
  await execa("git", ["add", "-A"], { cwd: dir });
  await execa("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

/**
 * Run a hook command the way the harness will: through a shell (the command carries
 * `VAR=x` prefixes), with a payload on stdin — but with PATH scrubbed to the system
 * minimum. If the command depends on the installing shell's PATH, it dies here, loudly,
 * instead of in the user's session as "hook exited with code 127".
 */
async function runHook(
  command: string,
  payload: object,
  env: Record<string, string>,
  { scrub = true }: { scrub?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  // Scrub OUR hooks: we control that command and pin its interpreter, so it must survive an
  // environment we do not control. Do NOT scrub someone else's hook — it may legitimately
  // rely on a tool that lives on the user's real PATH, and failing it here would be a false
  // alarm. A check that cries wolf gets ignored, and then it is no better than no check.
  const base = scrub ? { PATH: "/usr/bin:/bin", HOME: homedir() } : { ...process.env };
  const r = await execa("/bin/sh", ["-c", command], {
    input: JSON.stringify(payload),
    reject: false,
    timeout: 30_000,
    extendEnv: false,
    env: { ...base, ...env } as Record<string, string>,
  });
  return { code: r.exitCode ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function jobsIn(queueDir: string): number {
  try {
    return readdirSync(queueDir).filter((f) => /__.*\.json$/.test(f)).length;
  } catch {
    return 0;
  }
}

/**
 * Execute every installed hook and assert its EFFECT. Returns one Check per property; the
 * caller decides how loud to be. Never throws — a self-check that can crash is one more
 * thing that can silently not run.
 */
export async function selfcheck(target: Target): Promise<Check[]> {
  const checks: Check[] = [];
  const hooks = installedHooks(target);
  for (const event of ownedEvents(target)) {
    if (!hooks.some((h) => h.event === event && h.ours)) {
      checks.push({ name: `${event} hook installed`, ok: false, detail: `no veritaserum hook on ${event} in ${target}'s config` });
    }
  }
  if (!hooks.length) return checks;

  let repo = "";
  let state = "";
  try {
    repo = await scratchRepo();
    state = mkdtempSync(join(tmpdir(), "vs-selfcheck-state-"));
    const queue = join(state, "queue");
    const env = { VS_QUEUE_ROOT: queue, VS_TELEMETRY_PATH: join(state, "telemetry.jsonl") };
    const qdir = () => queueRoot(repo).replace(join(homedir(), ".veritaserum", "queue"), queue);

    for (const { event, command, ours } of hooks) {
      if (!ours) {
        // Not ours, but it runs on an event we depend on. If IT breaks, the harness reports
        // the whole event as failed — which is what the user sees, and blames on veritaserum.
        const r = await runHook(command, { session_id: "selfcheck", cwd: repo, prompt: "hello" }, env, { scrub: false });
        checks.push({
          name: `${event}: another tool's hook runs`,
          ok: r.code === 0,
          detail:
            r.code === 0
              ? `${command.slice(0, 44)}… exits 0`
              : `${command.slice(0, 44)}… exits ${r.code} — it shares this event and breaks it`,
        });
        continue;
      }
      if (event === "Stop") {
        // A transcript with real tool activity: the Stop hook must ENQUEUE an audit. A Stop
        // hook that exits 0 having queued nothing is exactly defect 1 — clean, and inert.
        const transcript = join(state, "transcript.jsonl");
        writeFileSync(
          transcript,
          JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }] },
          }) +
            "\n" +
            JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }) +
            "\n",
          "utf8",
        );
        const r = await runHook(command, { session_id: "selfcheck", transcript_path: transcript, cwd: repo }, env);
        checks.push({
          name: `${event} hook runs`,
          ok: r.code === 0,
          detail: r.code === 0 ? "exit 0" : `exit ${r.code} — ${(r.stderr || r.stdout).split("\n")[0]?.slice(0, 90)}`,
        });
        const enqueued = jobsIn(qdir());
        checks.push({
          name: `${event} hook enqueues an audit`,
          ok: enqueued > 0,
          detail: enqueued > 0 ? `${enqueued} job queued` : "ran, but queued NOTHING — the audit would never happen",
        });
      }

      if (event === "UserPromptSubmit") {
        // Plant a verdict and assert the hook emits the shape THIS harness reads. Printing
        // into a channel the harness ignores is inert (defect: codex got bare text for a day).
        const feedback = join(qdir(), "feedback");
        mkdirSync(feedback, { recursive: true });
        const line = "veritaserum: selfcheck probe";
        writeFileSync(join(feedback, "pending.json"), JSON.stringify({ ts: Date.now(), line }), "utf8");

        const r = await runHook(command, { cwd: repo, prompt: "hello" }, env);
        checks.push({
          name: `${event} hook runs`,
          ok: r.code === 0,
          detail: r.code === 0 ? "exit 0" : `exit ${r.code} — ${(r.stderr || r.stdout).split("\n")[0]?.slice(0, 90)}`,
        });

        const out = r.stdout.trim();
        let delivered = false;
        let shape = "nothing on stdout";
        if (target === "codex") {
          try {
            const parsed = JSON.parse(out) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
            const h = parsed.hookSpecificOutput;
            delivered = h?.hookEventName === "UserPromptSubmit" && (h.additionalContext ?? "").includes(line);
            shape = delivered ? "hookSpecificOutput envelope (codex reads this)" : "JSON, but not codex's envelope shape";
          } catch {
            shape = out ? "bare text — codex does NOT read this as context" : "nothing on stdout";
          }
        } else {
          delivered = out.includes(line);
          shape = delivered ? "bare stdout (Claude Code reads this as additionalContext)" : shape;
        }
        checks.push({
          name: `${event} hook reaches the model`,
          ok: delivered,
          detail: delivered ? shape : `the verdict would NOT reach the executor — ${shape}`,
        });
      }

      if (event === "SessionStart") {
        // Door 2: plant a STRAY (another session's feedback, past the 10-min grace) and
        // assert the fresh session's SessionStart hook sweeps + delivers it with
        // attribution. A hook that emits nothing here strands the autonomous fleet's
        // catches — the exact rot this door exists to drain.
        const feedback = join(qdir(), "feedback");
        mkdirSync(feedback, { recursive: true });
        const line = "veritaserum: selfcheck stray probe";
        const attributed = "veritaserum (from an earlier session in this repo):";
        writeFileSync(
          join(feedback, "other-session.json"),
          JSON.stringify({ ts: Date.now() - 11 * 60 * 1000, line }),
          "utf8",
        );

        const r = await runHook(command, { session_id: "selfcheck-fresh", cwd: repo }, env);
        checks.push({
          name: `${event} hook runs`,
          ok: r.code === 0,
          detail: r.code === 0 ? "exit 0" : `exit ${r.code} — ${(r.stderr || r.stdout).split("\n")[0]?.slice(0, 90)}`,
        });

        const out = r.stdout.trim();
        let delivered = false;
        let shape = "nothing on stdout";
        if (target === "codex") {
          try {
            const parsed = JSON.parse(out) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
            const h = parsed.hookSpecificOutput;
            delivered = h?.hookEventName === "SessionStart" && (h.additionalContext ?? "").includes(attributed);
            shape = delivered ? "hookSpecificOutput envelope (codex reads this)" : "JSON, but not codex's SessionStart envelope";
          } catch {
            shape = out ? "bare text — codex does NOT read this as context" : "nothing on stdout";
          }
        } else {
          delivered = out.includes(attributed);
          shape = delivered ? "bare stdout (Claude Code reads SessionStart as context)" : shape;
        }
        checks.push({
          name: `${event} hook reaches the model`,
          ok: delivered,
          detail: delivered ? shape : `a stray would NOT reach the executor — ${shape}`,
        });
      }
    }
  } catch (err) {
    checks.push({ name: "selfcheck", ok: false, detail: err instanceof Error ? err.message : String(err) });
  } finally {
    for (const d of [repo, state]) if (d) rmSync(d, { recursive: true, force: true });
  }
  return checks;
}
