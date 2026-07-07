/**
 * The real Knight (DESIGN §3): a capable LLM turns a goal into a contract — command
 * gates with committed grader scripts, semantic gates (capture + claim, judged
 * cross-vendor at verify), and honest checklist gates for claims no test can settle.
 *
 * Authoring, unlike judging, does not require a cross-vendor model (the Knight is
 * not grading the executor's output), so any available capable client works.
 *
 * The LLM's output is zod-validated. A malformed contract is a hard error, never a
 * silently-bad contract — a wrong gate set is worse than a clear failure.
 */
import { z } from "zod";
import type { LlmClient } from "./llm.js";
import type { Knight, SeedResult, GateInstance, EmittedFile } from "./judge.js";

const KnightGateSchema = z
  .object({
    type: z.enum(["command", "semantic", "checklist"]),
    run: z.string().min(1).optional(),
    capture: z.string().min(1).optional(),
    claim: z.string().min(1).optional(),
    checklist: z.string().min(1).optional(),
    gatePaths: z.array(z.string().min(1)).default([]),
    provenance: z.string().min(1),
    graderFiles: z.array(z.object({ path: z.string().min(1), content: z.string() })).default([]),
  })
  .strict();

const KnightOutputSchema = z
  .object({
    thesis: z.string().min(1),
    gates: z.array(KnightGateSchema).min(1),
  })
  .strict();

export class KnightError extends Error {}

const SYSTEM =
  "You are the Knight: you design a verification contract for a coding goal. Emit gates " +
  "that are OBJECTIVELY checkable. Prefer `command` gates (a shell command, exit 0 = pass) " +
  "with a committed grader script under .ser/gates/. Use a `semantic` gate (a `capture` " +
  "command whose output is evidence + a `claim` to judge) only when no exit-code check fits. " +
  "Use a `checklist` gate ONLY for claims no automated check can settle (honest abstain). " +
  "Never write gates that grade themselves trivially (e.g. `exit 0`). Keep it small and load-bearing.";

function prompt(goal: string): string {
  return (
    `GOAL:\n${goal}\n\n` +
    `Reply with ONLY compact JSON, no prose:\n` +
    `{"thesis":"<goal restated>","gates":[` +
    `{"type":"command","run":"sh .ser/gates/<name>.sh","gatePaths":[".ser/gates/<name>.sh"],` +
    `"provenance":"<why this gate, floor rationale>","graderFiles":[{"path":".ser/gates/<name>.sh","content":"<shell>"}]}` +
    `]}\n` +
    `Rules: command gates MUST list their grader script in gatePaths AND graderFiles. ` +
    `semantic gates use {"type":"semantic","capture":"<shell>","claim":"<what must hold>",...}. ` +
    `checklist gates use {"type":"checklist","checklist":"<human item>","provenance":"..."}.`
  );
}

function toInstance(g: z.infer<typeof KnightGateSchema>): GateInstance {
  const lineage = {
    pattern: g.type,
    params: {},
    provenance: g.provenance,
    source: "floor" as const,
    retired: false,
  };
  if (g.type === "command") {
    if (!g.run) throw new KnightError("command gate missing run");
    return { run: g.run, gatePaths: g.gatePaths, lineage };
  }
  if (g.type === "semantic") {
    if (!g.capture || !g.claim) throw new KnightError("semantic gate missing capture/claim");
    return { run: null, semantic: { capture: g.capture, claim: g.claim }, gatePaths: g.gatePaths, lineage };
  }
  if (!g.checklist) throw new KnightError("checklist gate missing checklist");
  return { run: null, checklist: g.checklist, gatePaths: g.gatePaths, lineage };
}

export class LlmKnight implements Knight {
  constructor(private readonly client: LlmClient) {}

  async seed(goal: string): Promise<SeedResult> {
    const raw = await this.client.complete({ system: SYSTEM, prompt: prompt(goal), timeoutMs: 180_000 });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new KnightError(`Knight returned no JSON:\n${raw.slice(0, 400)}`);
    let parsed;
    try {
      parsed = KnightOutputSchema.parse(JSON.parse(m[0]));
    } catch (e) {
      throw new KnightError(`Knight output invalid: ${e instanceof Error ? e.message : String(e)}`);
    }
    const gates = parsed.gates.map(toInstance);
    const files: EmittedFile[] = [];
    for (const g of parsed.gates) for (const f of g.graderFiles) files.push({ path: f.path, content: f.content });
    return { thesis: parsed.thesis, gates, files };
  }
}
