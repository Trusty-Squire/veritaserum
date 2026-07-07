#!/usr/bin/env node
/**
 * `veritaserum` CLI (DESIGN §4) — the enforcement door a hook shells out to.
 *   veritaserum install <harness>              wire the sentinel into a harness
 *   veritaserum seed <goal>                    seed a fresh contract (Knight)
 *   veritaserum ratchet <complaint>            append a gate (monotonic)
 *   veritaserum amend --retire --match <s> --as <s> [--confirm]   the only weakening path
 *   veritaserum verify [--full]                run gates from pristine graders; block on contradiction
 *
 * Exit codes: verify blocked -> 1, verify green -> 0, errors -> 2.
 */
import { loadContract, activeGates } from "./contract.js";
import { commitPaths } from "./git.js";
import { ratchetComplaint, retireByProvenance, commitRatchet } from "./ratchet.js";
import { seed, SeedError } from "./seed.js";
import { CONTRACT_FILENAME } from "./schema.js";
import { verify, NotSealedError } from "./verify.js";
import { hookStop, hookPrompt } from "./hook.js";
import { readLastAssistantMessage } from "./transcript.js";
import { resolveKnight, resolveJudge, resolveTranscriber } from "./resolve.js";
import { runSentinel } from "./sentinel.js";
import { logFiring, readFirings, summarize } from "./telemetry.js";
import type { Vendor } from "./llm.js";
import { installTarget, detectHarnesses, isTarget, TARGETS } from "./install.js";
import * as style from "./style.js";

/** The executor vendor this hook is guarding (installer sets VS_EXECUTOR per harness). */
function executorVendor(): Vendor | "unknown" {
  const e = (process.env.VS_EXECUTOR || "").toLowerCase();
  return e === "codex" || e === "claude" || e === "openrouter" ? e : "unknown";
}
/** Which harness fired us (installer sets VS_HARNESS). */
function harnessName(): string {
  return process.env.VS_HARNESS || "unknown";
}

/** Read the harness hook payload (JSON HookContext) from stdin. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface HookPayload {
  // goose / codex: assistant claim inline; goose UserPromptSubmit: `message`.
  last_assistant_message?: string;
  message?: string;
  // Claude Code: Stop hands a transcript path; UserPromptSubmit hands `prompt`.
  transcript_path?: string;
  prompt?: string;
  // repo dir: goose(post-PR) `working_dir`; Claude Code `cwd`.
  working_dir?: string;
  cwd?: string;
}
function parsePayload(raw: string): HookPayload {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as HookPayload) : {};
  } catch {
    return {};
  }
}
/** The repo dir to verify against, across harnesses. */
function payloadDir(p: HookPayload, fallback: string): string {
  return p.working_dir || p.cwd || fallback;
}
/** The agent's completion-claim text, across harnesses (inline or via transcript). */
function claimMessage(p: HookPayload): string {
  if (p.last_assistant_message) return p.last_assistant_message;
  if (p.message) return p.message;
  if (p.transcript_path) return readLastAssistantMessage(p.transcript_path);
  return "";
}
/** The human's message, across harnesses. */
function promptMessage(p: HookPayload): string {
  return p.prompt || p.message || "";
}

function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}
function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
/** Positional args = everything before the first --flag. */
function positional(args: string[]): string[] {
  const cut = args.findIndex((a) => a.startsWith("--"));
  return (cut === -1 ? args : args.slice(0, cut)).filter((a) => a.length > 0);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const dir = process.cwd();

  switch (cmd) {
    case "seed": {
      const goal = positional(rest).join(" ").trim();
      if (!goal) return usage("seed <goal>");
      const out = await seed(dir, goal, await resolveKnight());
      console.log(`sealed contract: ${out.gates} gate(s), ${out.files.length} grader file(s)`);
      console.log(`contractCommit ${out.contractCommit.slice(0, 10)}`);
      return 0;
    }

    case "ratchet": {
      const complaint = positional(rest).join(" ").trim();
      if (!complaint) return usage("ratchet <complaint>");
      const r = await ratchetComplaint(dir, complaint, await resolveTranscriber());
      console.log(`${r.action}${r.gateId ? ` (${r.gateId})` : ""}: ${r.describeBack}`);
      if (r.action === "conflict-surfaced" && r.conflictWith) {
        console.log(`  conflicts with ${r.conflictWith.id} — resolve with \`ser amend --retire\``);
      }
      // Persist: commits contract.yaml (+ new grader files) and reseals contractCommit
      // when the new gate brought graders (R2). No-op for conflict/boundary outcomes.
      if (r.action === "added" || r.action === "repeat-recorded") await commitRatchet(dir, r);
      return 0;
    }

    case "amend": {
      if (!flag(rest, "retire")) return usage("amend --retire --match <provenance> --as <reason> [--confirm]");
      const match = opt(rest, "match");
      const as = opt(rest, "as");
      if (!match || !as) return usage("amend --retire --match <provenance> --as <reason> [--confirm]");
      const c = await loadContract(dir);
      const targets = activeGates(c).filter((g) => g.lineage.provenance.toLowerCase().includes(match.toLowerCase()));
      if (targets.length === 0) {
        console.log(`no active gate matches provenance "${match}"`);
        return 0;
      }
      if (!flag(rest, "confirm")) {
        console.log(`amend --retire would retire ${targets.length} gate(s) (weakens the contract):`);
        for (const g of targets) console.log(`  ${g.id}: ${g.lineage.provenance}`);
        console.log(`re-run with --confirm to proceed.`);
        return 0;
      }
      const retired = await retireByProvenance(dir, match, as);
      await commitPaths(dir, [CONTRACT_FILENAME], `ser: amend --retire (${as})`);
      console.log(`retired ${retired.length} gate(s): ${retired.join(", ")} (recorded, not deleted)`);
      return 0;
    }

    case "verify": {
      const level = flag(rest, "full") ? "full" : "fast";
      const judge = await resolveJudge();
      const r = await verify(dir, { level, ...(judge ? { judge } : {}) });
      for (const t of r.tamper) {
        console.log(`⚠ TAMPER (${t.kind}): ${t.path} — ${t.detail} [ran pristine grader anyway]`);
      }
      for (const f of r.failures) {
        console.log(`✗ ${f.gateId} (${f.provenance})`);
        if (f.symptom) console.log(`    ${f.symptom.replace(/\n/g, "\n    ")}`);
      }
      for (const a of r.abstentions) console.log(`? ${a.gateId} (${a.provenance}) — ABSTAIN → human: ${a.symptom ?? ""}`);
      for (const item of r.checklist) console.log(`○ checklist ${item.gateId}: ${item.text}`);
      if (r.blocked) {
        console.log(`BLOCKED — ${r.failures.length}/${r.ran} gate(s) failed. A "done" claim would be false.`);
        return 1;
      }
      const tail = [
        r.tamper.length ? `${r.tamper.length} tamper flag(s)` : "",
        r.abstentions.length ? `${r.abstentions.length} abstention(s) → human` : "",
      ].filter(Boolean).join(", ");
      console.log(`OK — ${r.passed}/${r.ran} gate(s) pass${tail ? ` (${tail})` : ""}.`);
      return 0;
    }

    case "install": {
      const target = positional(rest)[0];
      const global = flag(rest, "global");
      console.log(style.banner("veritaserum · install", "ground-truth sentinel for coding agents"));
      console.log();
      if (!target) {
        console.log(`  usage: ${style.bold(`veritaserum install <${TARGETS.join("|")}>`)} ${style.dim("[--global]")}`);
        const found = detectHarnesses();
        console.log();
        if (found.length) {
          console.log(`  detected here: ${found.map((t) => style.cyan(t)).join(", ")}`);
          console.log(style.step(`e.g. ${style.bold(`veritaserum install ${found[0]}`)}`));
        } else {
          console.log(style.dim("  no harness config found (~/.claude, ~/.config/goose, ~/.codex)"));
        }
        return 0;
      }
      if (!isTarget(target)) {
        console.error(`  ${style.cross} unknown target ${style.bold(target)} — expected one of ${TARGETS.join(", ")}`);
        return 2;
      }
      const res = await installTarget(target, { global });
      for (const line of res.steps) console.log(line);
      if (res.manual.length) {
        console.log();
        console.log(`  ${style.yellow("finish by hand:")}`);
        for (const m of res.manual) console.log(`  ${m}`);
      }
      console.log();
      console.log(style.divider());
      console.log(style.ok(`${style.bold(target)} wired — veritaserum now watches every turn-end.`));
      console.log(style.step(`week 1:  ${style.dim("export")} VS_ADVISORY=1   ${style.dim("# watch + log, never block")}`));
      console.log(style.step(`read catches:  ${style.bold("veritaserum telemetry")}`));
      console.log(style.step(`enable blocking later:  ${style.dim("unset")} VS_ADVISORY`));
      return 0;
    }

    case "telemetry": {
      console.log(summarize(readFirings()));
      return 0;
    }

    // --- harness hook entrypoints (Archetype A). Read JSON HookContext on stdin. ---
    case "hook-stop": {
      const p = parsePayload(await readStdin());
      const wd = payloadDir(p, dir);
      const claim = claimMessage(p);
      let block = false;
      let reason = "";
      let caught = "";
      let verdict = "grounded";

      // 1. Sentinel — judge-primary claim check. Works with NO contract (the
      //    install-and-go default). Fresh cross-vendor judge; never throws.
      try {
        const s = await runSentinel(wd, claim, executorVendor());
        verdict = s.verdict;
        if (s.block) {
          block = true;
          caught = s.caught;
          reason = `ser: your claim isn't supported by the repo state — ${s.caught}`;
        }
      } catch (err) {
        console.error(`ser sentinel (allowed, internal error): ${err instanceof Error ? err.message : String(err)}`);
      }

      // 2. Contract gates — only if a sealed contract exists (adds the
      //    deterministic layer under the judge). No contract => fail open.
      try {
        const d = await hookStop(wd, claim, { level: flag(rest, "full") ? "full" : "fast" });
        if (d.block) {
          block = true;
          verdict = "blocked";
          caught = caught || d.reason || "";
          reason = reason ? `${reason}; ${d.reason}` : (d.reason ?? "");
        }
      } catch {
        // NotSealedError (no contract) or a gate error: sentinel already ran; fail open.
      }

      // Advisory mode (VS_ADVISORY): record what ser WOULD have done, but never
      // actually stop the agent. The safe default for a measurement week — you see
      // the catch rate and false-block rate without the latency/disruption of blocking.
      const advisory = process.env.VS_ADVISORY === "1" || process.env.VS_ADVISORY === "true";
      logFiring({ harness: harnessName(), event: "stop", claim: claim.slice(0, 400), verdict, caught, blocked: block, advisory, dir: wd });

      if (block && !advisory) {
        // goose + Claude Code both block on a stdout {"decision":"block"} payload; exit 0.
        process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
      }
      return 0;
    }

    case "hook-prompt": {
      const p = parsePayload(await readStdin());
      const wd = payloadDir(p, dir);
      const msg = promptMessage(p);
      try {
        const r = await hookPrompt(wd, msg, { transcribe: await resolveTranscriber() });
        if (r.ratcheted && r.outcome && (r.outcome.action === "added" || r.outcome.action === "repeat-recorded")) {
          await commitRatchet(wd, r.outcome);
          console.error(`ser: ${r.outcome.action}${r.outcome.gateId ? ` (${r.outcome.gateId})` : ""}`);
        }
      } catch (err) {
        console.error(`ser hook-prompt (skipped, internal error): ${err instanceof Error ? err.message : String(err)}`);
      }
      return 0; // never blocks the human's prompt
    }

    default:
      return usage("<install|seed|ratchet|amend|verify|telemetry|hook-stop|hook-prompt>");
  }
}

function usage(spec: string): number {
  console.error(`usage: veritaserum ${spec}`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    const known = err instanceof SeedError || err instanceof NotSealedError;
    console.error(`ser: ${err instanceof Error ? err.message : String(err)}`);
    if (!known && err instanceof Error && err.stack) console.error(err.stack.split("\n").slice(1, 3).join("\n"));
    process.exit(2);
  });
