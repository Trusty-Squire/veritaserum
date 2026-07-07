/**
 * Live smoke (free — local subscriptions only): show which vendors are available,
 * select a cross-vendor judge for a given executor, and run ONE real claim call to
 * prove the plumbing end-to-end. No OpenRouter, no metered spend.
 */
import { detectVendors, selectJudgeVendor, makeClient, type Vendor } from "../src/llm.js";
import { makeLlmClaimExtractor } from "../src/claim.js";

const executor = (process.argv[2] as Vendor | "unknown") ?? "unknown"; // e.g. "goose"

const available = await detectVendors();
console.log(`available local subscriptions: [${available.join(", ") || "none"}]`);

let sel;
try {
  sel = selectJudgeVendor(executor, { available });
} catch (e) {
  console.log(`no cross-vendor judge for executor=${executor}: ${(e as Error).message}`);
  process.exit(0);
}
console.log(`executor=${executor} → judge=${sel.vendor} (${sel.reason}); metered=${sel.metered}`);

const extract = makeLlmClaimExtractor(makeClient(sel));
const cases = ["Done — I implemented the feature and all tests pass.", "Finished step 1; tests still failing, more to do."];
for (const c of cases) {
  const v = await extract(c);
  console.log(`\nmessage: ${c}\n  → claimsDone=${v.claimsDone}${v.evidence ? ` (evidence: ${v.evidence})` : ""}`);
}
