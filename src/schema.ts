/**
 * zod schemas are the single source of truth for contract.yaml.
 * Parse the outside world here; typed values flow everywhere downstream.
 *
 * Ported faithfully from proj-cs `src/contract/contract-file.ts` + `gate-registry.ts`,
 * with two P0 additions from DESIGN.md §14:
 *  - `gatePaths` on each gate (R2): the grader files that MUST be run from their
 *    committed version, not the working tree.
 *  - `contractCommit` on the file (R2): the git sha at which the gates were sealed;
 *    verify reads pristine grader blobs from this commit.
 */
import { z } from "zod";

/** Where a binding gate came from. Determines authority class (DESIGN §3). */
export const GateLineageSchema = z
  .object({
    pattern: z.string().min(1),
    params: z.record(z.unknown()).default({}),
    /** The human sentence (user-word), floor rationale, or escape justification. */
    provenance: z.string().min(1),
    source: z.enum(["user-word", "floor", "escape", "evaluator-demand"]),
    retired: z.boolean().default(false),
  })
  .strict();
export type GateLineage = z.infer<typeof GateLineageSchema>;

/**
 * A semantic gate: reality is captured deterministically (the `capture` command
 * produces evidence on stdout), then a CROSS-VENDOR judge decides whether `claim`
 * holds over that evidence (DESIGN §5). The judge never drives — the recipe does.
 */
export const SemanticSpecSchema = z
  .object({
    /** Primary shell command whose stdout/stderr is evidence (deterministic). */
    capture: z.string().min(1),
    /**
     * Extra labeled capture steps, assembled into a structured evidence bundle
     * (label + output) so the judge reasons over named sections rather than one
     * blob. Richer evidence is the #1 judge-accuracy lever (visual filmstrips are
     * the same shape — a `visual` modality + a multimodal judge — deferred while
     * that judge is metered; text bundles are free).
     */
    evidence: z.array(z.object({ label: z.string().min(1), run: z.string().min(1) })).default([]),
    /** Evidence modality. "visual" gates abstain to human until a VLM judge is configured. */
    modality: z.enum(["text", "visual"]).default("text"),
    /** What must be true of the evidence (the thing the judge rules on). */
    claim: z.string().min(1),
  })
  .strict();
export type SemanticSpec = z.infer<typeof SemanticSpecSchema>;

export const ContractGateSchema = z
  .object({
    id: z.string().min(1),
    /** Command gate: shell, exit 0 = pass. null for semantic/checklist gates. */
    run: z.string().min(1).nullable(),
    /** Semantic gate: capture + claim, judged cross-vendor. */
    semantic: SemanticSpecSchema.optional(),
    /** Human checklist text (audit-only items — never run in the loop). */
    checklist: z.string().min(1).optional(),
    /**
     * R2: the grader files this gate depends on (test files, configs, the check
     * or capture script). At verify these are restored to their committed version
     * so the executor cannot tamper the thing that grades it.
     */
    gatePaths: z.array(z.string().min(1)).default([]),
    lineage: GateLineageSchema,
    /** Set when the clutch (amend --retire) retires this gate. */
    retiredBy: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((g, ctx) => {
    const kinds = [g.run !== null, Boolean(g.semantic), Boolean(g.checklist)].filter(Boolean).length;
    if (kinds !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `gate "${g.id}" must be exactly one of command(run) | semantic | checklist`,
      });
    }
  });
export type ContractGate = z.infer<typeof ContractGateSchema>;

export const RepeatSchema = z.object({
  gateId: z.string(),
  complaint: z.string(),
  at: z.string(),
});

export const ContractFileSchema = z
  .object({
    version: z.literal(1).default(1),
    /** The seed goal / north-star sentence. */
    thesis: z.string().default(""),
    /**
     * R2: the git sha at which the current gates + grader files were sealed.
     * verify reads pristine grader blobs from here. null until first commit.
     */
    contractCommit: z.string().nullable().default(null),
    gates: z.array(ContractGateSchema).default([]),
    /** Measured repeats: complaints that recurred while their gate was active. Target 0. */
    repeats: z.array(RepeatSchema).default([]),
  })
  .strict();
export type ContractFile = z.infer<typeof ContractFileSchema>;

export const CONTRACT_FILENAME = "contract.yaml";
