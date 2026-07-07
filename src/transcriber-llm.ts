/**
 * The real ratchet transcriber (DESIGN §4): an LLM turns a human complaint into a
 * gate, routed against the existing contract. Behind the ComplaintTranscriber seam;
 * MockLlmClient in tests. Fails SAFE — any parse error falls back to a checklist gate
 * carrying the user's exact words (never drops the correction, never invents a
 * command gate it can't justify).
 */
import { z } from "zod";
import type { ComplaintTranscriber, ComplaintTranscription, GateInstance, EmittedFile } from "./judge.js";
import { mockTranscriber } from "./judge.js";
import type { LlmClient } from "./llm.js";
import { activeGates } from "./contract.js";

const OutSchema = z
  .object({
    kind: z.enum(["new", "duplicate", "contradicts", "feature"]),
    gate: z
      .object({
        type: z.enum(["command", "semantic", "checklist"]),
        run: z.string().min(1).optional(),
        capture: z.string().min(1).optional(),
        claim: z.string().min(1).optional(),
        checklist: z.string().min(1).optional(),
        gatePaths: z.array(z.string().min(1)).default([]),
        graderFiles: z.array(z.object({ path: z.string().min(1), content: z.string() })).default([]),
      })
      .optional(),
    contradictsGateId: z.string().optional(),
    duplicateOfGateId: z.string().optional(),
    describeBack: z.string().min(1),
  })
  .strict();

const SYSTEM =
  "You convert a user's complaint about a shipped project into ONE verification gate, or " +
  "route it. Return kind: 'new' (a genuinely new regression check), 'duplicate' (an active " +
  "gate already covers it), 'contradicts' (conflicts with an active gate — name it), or " +
  "'feature' (new scope, not a regression → route to intake, no gate). Prefer a 'command' " +
  "gate (shell, exit 0 = pass) with a committed grader script under .ser/gates/; use " +
  "'semantic' (capture + claim, judged) when no exit-code fits; 'checklist' only when no " +
  "automated check is possible. Never author a trivially-passing gate.";

export function makeLlmTranscriber(client: LlmClient): ComplaintTranscriber {
  return async (complaint, contract) => {
    const active = activeGates(contract)
      .map((g) => `${g.id}: ${g.lineage.provenance}`)
      .join("\n");
    const prompt =
      `Active gates:\n${active || "(none)"}\n\nComplaint:\n${complaint}\n\n` +
      `Reply with ONLY compact JSON:\n` +
      `{"kind":"new","gate":{"type":"command","run":"sh .ser/gates/<name>.sh","gatePaths":[".ser/gates/<name>.sh"],` +
      `"graderFiles":[{"path":".ser/gates/<name>.sh","content":"<shell>"}]},"describeBack":"<one line for the user>"}`;
    try {
      const raw = await client.complete({ system: SYSTEM, prompt, timeoutMs: 120_000 });
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return mockTranscriber(complaint, contract);
      const out = OutSchema.parse(JSON.parse(m[0]));

      if (out.kind === "feature") return { kind: "feature", describeBack: out.describeBack };
      if (out.kind === "contradicts") {
        return { kind: "contradicts", contradictsGateId: out.contradictsGateId, describeBack: out.describeBack };
      }
      if (out.kind === "duplicate" && !out.gate) {
        return { kind: "duplicate", duplicateOfGateId: out.duplicateOfGateId, describeBack: out.describeBack };
      }
      if (!out.gate) return mockTranscriber(complaint, contract);

      const g = out.gate;
      const lineage = { pattern: g.type, params: {}, provenance: complaint, source: "user-word" as const, retired: false };
      let instance: GateInstance;
      if (g.type === "command" && g.run) instance = { run: g.run, gatePaths: g.gatePaths, lineage };
      else if (g.type === "semantic" && g.capture && g.claim)
        instance = { run: null, semantic: { capture: g.capture, claim: g.claim, evidence: [], modality: "text" }, gatePaths: g.gatePaths, lineage };
      else if (g.type === "checklist" && g.checklist) instance = { run: null, checklist: g.checklist, gatePaths: [], lineage };
      else return mockTranscriber(complaint, contract);

      const files: EmittedFile[] = g.graderFiles.map((f) => ({ path: f.path, content: f.content }));
      const res: ComplaintTranscription = { kind: out.kind, instance, describeBack: out.describeBack };
      if (files.length) res.files = files;
      return res;
    } catch {
      return mockTranscriber(complaint, contract);
    }
  };
}
