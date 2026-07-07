#!/usr/bin/env node
/**
 * ser MCP server (DESIGN §4, §9) — the pull-side surface over the SAME engine the
 * CLI/hook path uses. For hosts that prefer tool-calls. MCP is pull-only, so this is
 * NOT the enforcement path (that stays the Stop hook + `ser verify` CLI); it lets an
 * agent seed/ratchet/amend/verify a contract on demand.
 *
 * Tools mirror the split API: contract_seed / contract_ratchet / contract_amend /
 * contract_verify / contract_status. Every tool takes an optional `dir` (default cwd).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadContract, activeGates } from "./contract.js";
import { commitPaths } from "./git.js";
import { ratchetComplaint, retireByProvenance, commitRatchet } from "./ratchet.js";
import { seed } from "./seed.js";
import { CONTRACT_FILENAME } from "./schema.js";
import { verify } from "./verify.js";
import { resolveKnight, resolveJudge, resolveTranscriber } from "./resolve.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
const dirArg = { dir: z.string().optional().describe("repo dir (default: server cwd)") };
const cwd = (dir?: string) => dir || process.cwd();

export function buildServer(): McpServer {
  const server = new McpServer({ name: "ser", version: "0.1.0" });

  server.tool(
    "contract_seed",
    "Author and seal a fresh verification contract for a goal (Knight). Fails if a contract already exists — use contract_ratchet/contract_amend.",
    { goal: z.string().min(1), ...dirArg },
    async ({ goal, dir }) => {
      const out = await seed(cwd(dir), goal, await resolveKnight());
      return text(`sealed ${out.gates} gate(s), ${out.files.length} grader file(s); contractCommit ${out.contractCommit.slice(0, 10)}`);
    },
  );

  server.tool(
    "contract_ratchet",
    "Append a gate from a correction (monotonic; never weakens). Records a repeat if the complaint already has an active gate.",
    { complaint: z.string().min(1), ...dirArg },
    async ({ complaint, dir }) => {
      const d = cwd(dir);
      const r = await ratchetComplaint(d, complaint, await resolveTranscriber());
      if (r.action === "added" || r.action === "repeat-recorded") await commitRatchet(d, r);
      return text(`${r.action}${r.gateId ? ` (${r.gateId})` : ""}: ${r.describeBack}`);
    },
  );

  server.tool(
    "contract_amend",
    "Retire active gates whose provenance matches (the ONLY weakening path). Requires confirm:true. Recorded, not deleted.",
    { match: z.string().min(1), as: z.string().min(1), confirm: z.boolean().default(false), ...dirArg },
    async ({ match, as, confirm, dir }) => {
      const d = cwd(dir);
      const targets = activeGates(await loadContract(d)).filter((g) =>
        g.lineage.provenance.toLowerCase().includes(match.toLowerCase()),
      );
      if (targets.length === 0) return text(`no active gate matches "${match}"`);
      if (!confirm) return text(`would retire ${targets.length} gate(s): ${targets.map((g) => g.id).join(", ")}. Re-call with confirm:true.`);
      const retired = await retireByProvenance(d, match, as);
      await commitPaths(d, [CONTRACT_FILENAME], `ser: amend --retire (${as})`);
      return text(`retired ${retired.length} gate(s): ${retired.join(", ")} (recorded, not deleted)`);
    },
  );

  server.tool(
    "contract_verify",
    "Run the contract's gates from their COMMITTED graders (R2) against the working tree. Blocks (isError) on contradiction. Semantic gates judged cross-vendor; abstain routes to human.",
    { level: z.enum(["fast", "full"]).default("fast"), ...dirArg },
    async ({ dir }) => {
      const judge = await resolveJudge();
      const r = await verify(cwd(dir), judge ? { judge } : {});
      const lines = [
        ...r.tamper.map((t) => `TAMPER(${t.kind}): ${t.path} — ${t.detail}`),
        ...r.failures.map((f) => `FAIL ${f.gateId}: ${f.symptom ?? ""}`),
        ...r.abstentions.map((a) => `ABSTAIN→human ${a.gateId}: ${a.symptom ?? ""}`),
      ];
      const head = r.blocked
        ? `BLOCKED — ${r.failures.length}/${r.ran} gate(s) failed; a "done" claim would be false.`
        : `OK — ${r.passed}/${r.ran} pass${r.abstentions.length ? `, ${r.abstentions.length} abstention(s)` : ""}.`;
      return { content: [{ type: "text" as const, text: [head, ...lines].join("\n") }], isError: r.blocked };
    },
  );

  server.tool("contract_status", "Read-only contract summary: gates (active/retired), semantic/command/checklist, repeat count.", { ...dirArg }, async ({ dir }) => {
    const c = await loadContract(cwd(dir));
    const act = activeGates(c);
    const kinds = act.reduce(
      (m, g) => ((m[g.run ? "command" : g.semantic ? "semantic" : "checklist"] = (m[g.run ? "command" : g.semantic ? "semantic" : "checklist"] ?? 0) + 1), m),
      {} as Record<string, number>,
    );
    return text(`sealed=${Boolean(c.contractCommit)} active=${act.length} retired=${c.gates.length - act.length} kinds=${JSON.stringify(kinds)} repeats=${c.repeats.length}`);
  });

  return server;
}

// Entry point: stdio transport. (Guarded so tests can import buildServer without starting.)
if (process.argv[1] && /mcp\.(ts|js)$/.test(process.argv[1])) {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
