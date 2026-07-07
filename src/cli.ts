#!/usr/bin/env node
/**
 * `ser` CLI (DESIGN §4) — the enforcement door a hook shells out to.
 *   ser seed <goal>                       seed a fresh contract (Knight)
 *   ser ratchet <complaint>               append a gate (monotonic)
 *   ser amend --retire --match <s> --as <s> [--confirm]   the only weakening path
 *   ser verify [--full]                   run gates from pristine graders; block on contradiction
 *
 * Exit codes: verify blocked -> 1, verify green -> 0, errors -> 2.
 */
import { loadContract, activeGates } from "./contract.js";
import { commitPaths } from "./git.js";
import { mockTranscriber } from "./judge.js";
import { ratchetComplaint, retireByProvenance } from "./ratchet.js";
import { seed, SeedError } from "./seed.js";
import { CONTRACT_FILENAME } from "./schema.js";
import { verify, NotSealedError } from "./verify.js";
import { hookStop, hookPrompt } from "./hook.js";
import { readLastAssistantMessage } from "./transcript.js";

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
      const out = await seed(dir, goal);
      console.log(`sealed contract: ${out.gates} gate(s), ${out.files.length} grader file(s)`);
      console.log(`contractCommit ${out.contractCommit.slice(0, 10)}`);
      return 0;
    }

    case "ratchet": {
      const complaint = positional(rest).join(" ").trim();
      if (!complaint) return usage("ratchet <complaint>");
      const r = await ratchetComplaint(dir, complaint, mockTranscriber);
      console.log(`${r.action}${r.gateId ? ` (${r.gateId})` : ""}: ${r.describeBack}`);
      if (r.action === "conflict-surfaced" && r.conflictWith) {
        console.log(`  conflicts with ${r.conflictWith.id} — resolve with \`ser amend --retire\``);
      }
      // Persist the contract change (grader set unchanged for checklist gates, so
      // contractCommit stays valid; grader-bearing ratchets reseal at P1).
      await commitPaths(dir, [CONTRACT_FILENAME], `ser: ratchet — ${complaint.slice(0, 60)}`);
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
      const r = await verify(dir, level);
      for (const t of r.tamper) {
        console.log(`⚠ TAMPER (${t.kind}): ${t.path} — ${t.detail} [ran pristine grader anyway]`);
      }
      for (const f of r.failures) {
        console.log(`✗ ${f.gateId} (${f.provenance})`);
        if (f.symptom) console.log(`    ${f.symptom.replace(/\n/g, "\n    ")}`);
      }
      for (const item of r.checklist) console.log(`○ checklist ${item.gateId}: ${item.text}`);
      if (r.blocked) {
        console.log(`BLOCKED — ${r.failures.length}/${r.ran} gate(s) failed. A "done" claim would be false.`);
        return 1;
      }
      console.log(`OK — ${r.passed}/${r.ran} gate(s) pass${r.tamper.length ? ` (${r.tamper.length} tamper flag(s))` : ""}.`);
      return 0;
    }

    // --- harness hook entrypoints (Archetype A). Read JSON HookContext on stdin. ---
    case "hook-stop": {
      const p = parsePayload(await readStdin());
      const wd = payloadDir(p, dir);
      try {
        const d = await hookStop(wd, claimMessage(p), { level: flag(rest, "full") ? "full" : "fast" });
        if (d.block) {
          // goose blocks on a stdout {"decision":"block"} payload; exit 0.
          process.stdout.write(JSON.stringify({ decision: "block", reason: d.reason }) + "\n");
        }
        return 0;
      } catch (err) {
        // Fail OPEN on our own error: ser blocks on contradiction, never on a ser
        // bug (blocking the agent because our hook crashed would get ser disabled;
        // goose treats an erroring hook as allow anyway).
        console.error(`ser hook-stop (allowed, internal error): ${err instanceof Error ? err.message : String(err)}`);
        return 0;
      }
    }

    case "hook-prompt": {
      const p = parsePayload(await readStdin());
      const wd = payloadDir(p, dir);
      const msg = promptMessage(p);
      try {
        const r = await hookPrompt(wd, msg);
        if (r.ratcheted && r.outcome) {
          await commitPaths(wd, [CONTRACT_FILENAME], `ser: ratchet (correction) — ${msg.slice(0, 50)}`);
          console.error(`ser: ${r.outcome.action}${r.outcome.gateId ? ` (${r.outcome.gateId})` : ""}`);
        }
      } catch (err) {
        console.error(`ser hook-prompt (skipped, internal error): ${err instanceof Error ? err.message : String(err)}`);
      }
      return 0; // never blocks the human's prompt
    }

    default:
      return usage("<seed|ratchet|amend|verify|hook-stop|hook-prompt>");
  }
}

function usage(spec: string): number {
  console.error(`usage: ser ${spec}`);
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
