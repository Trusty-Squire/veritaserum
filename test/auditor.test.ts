import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempRepo } from "./helpers.js";
import {
  audit,
  addressee,
  claimWarning,
  unaccountableWarning,
  parseReply,
  demoteFullSessionFigures,
  deliveryMode,
  claimDeliverableUnderQuiet,
  verifyAnchor,
  normalizeAnchor,
  type AuditJob,
  type ClaimVerdict,
} from "../src/auditor.js";
import type { Auditor, AuditorTier } from "../src/resolve.js";
import { readFirings, type Firing } from "../src/telemetry.js";

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

async function repo(): Promise<string> {
  const { dir, cleanup } = await tempRepo();
  cleanups.push(cleanup);
  return dir;
}

interface Recording {
  calls: { prompt: string; dir: string }[];
}

function fakeAuditor(
  reply: string | ((prompt: string) => string),
  opts: Partial<Pick<Auditor, "vendor" | "sameFamily" | "model" | "tier">> = {},
): Auditor & Recording {
  const calls: { prompt: string; dir: string }[] = [];
  const tier: AuditorTier = opts.tier ?? "pre-gathered";
  return {
    tier,
    vendor: opts.vendor ?? "jev",
    sameFamily: opts.sameFamily ?? false,
    ...(opts.model ? { model: opts.model } : {}),
    calls,
    async invoke(prompt: string, dir: string) {
      calls.push({ prompt, dir });
      return typeof reply === "function" ? reply(prompt) : reply;
    },
  };
}

const OK_REPLY = '{"claims":[],"unaccountable":false,"note":""}';
const LOAD_BEARING = "I updated src/cache.ts; all 128 tests passed in 4.2 seconds.";

function job(dir: string, overrides: Partial<AuditJob> = {}): AuditJob {
  return {
    dir,
    sessionId: "s1",
    finalMessage: LOAD_BEARING,
    userRequest: "implement the thing",
    ...overrides,
  };
}

describe("warning templates — addressee resolution", () => {
  it("maps the executor vendor to the spoken name; anything else → Agent", () => {
    expect(addressee("claude")).toBe("Claude");
    expect(addressee("claude:sonnet")).toBe("Claude");
    expect(addressee("codex")).toBe("Codex");
    expect(addressee("codex:gpt-5.6")).toBe("Codex");
    expect(addressee("goose")).toBe("Agent");
    expect(addressee("unknown")).toBe("Agent");
    expect(addressee(undefined)).toBe("Agent");
  });
});

describe("warning templates — one humane line per verdict", () => {
  const c = (verdict: "unsupported" | "contradicted", claim = "tests pass", basis = "no test run on record") => ({ claim, verdict, basis, evidence: "" });

  it("unsupported claim — direct address, basis as second clause", () => {
    expect(claimWarning("Claude", c("unsupported"))).toBe('Claude, you have no basis to claim "tests pass" — no test run on record.');
    expect(claimWarning("Codex", c("unsupported"))).toBe('Codex, you have no basis to claim "tests pass" — no test run on record.');
  });

  it("contradicted claim — the stronger 'evidence contradicts' phrasing", () => {
    expect(claimWarning("Claude", c("contradicted"))).toBe('Claude, the evidence contradicts your claim "tests pass" — no test run on record.');
    expect(claimWarning("Agent", c("contradicted"))).toContain("the evidence contradicts your claim");
  });

  it("truncates a long claim to ~120 chars with …", () => {
    const long = "x".repeat(200);
    const line = claimWarning("Claude", c("unsupported", long));
    expect(line).toContain("…");
    expect(line).not.toContain("x".repeat(200));
  });

  it("R9 unaccountable — fixed phrasing", () => {
    expect(unaccountableWarning("Claude")).toBe("Claude, you did substantial work but reported nothing checkable — state what you did and how you know it works.");
  });

  it("appends the reliance clause when present", () => {
    const claim: ClaimVerdict = {
      claim: "all tests pass",
      verdict: "contradicted",
      basis: "the run shows 1 failing",
      evidence: "",
      reliance: "the user is about to merge on this all-pass",
    };
    expect(claimWarning("Codex", claim)).toBe(
      'Codex, the evidence contradicts your claim "all tests pass" — the run shows 1 failing: if false — the user is about to merge on this all-pass',
    );
  });
});

describe("parseReply — top-1 budget + reliance enforcement", () => {
  const RELIANCE = "the user is about to merge this on the strength of the claim";
  const claim = (verdict: string, claimText: string, reliance?: string): Record<string, unknown> => ({
    claim: claimText,
    verdict,
    basis: "b",
    evidence: "e",
    ...(reliance !== undefined ? { reliance } : {}),
  });
  const wrap = (claims: Record<string, unknown>[]): string => JSON.stringify({ claims, unaccountable: false, note: "" });
  const flagged = (p: NonNullable<ReturnType<typeof parseReply>>): ClaimVerdict[] => p.claims.filter((c) => c.verdict !== "supported");

  it("top-1: three non-supported in → one out, the worst (contradicted) kept", () => {
    const p = parseReply(wrap([
      claim("unsupported", "a", RELIANCE),
      claim("contradicted", "b", RELIANCE),
      claim("unsupported", "c", RELIANCE),
    ]))!;
    expect(flagged(p)).toHaveLength(1);
    expect(flagged(p)[0]!.verdict).toBe("contradicted");
    expect(flagged(p)[0]!.claim).toBe("b");
  });

  it("reliance-missing demotion: a non-supported claim with no reliance is dropped", () => {
    const p = parseReply(wrap([claim("unsupported", "x")]))!;
    expect(p.claims).toHaveLength(0);
  });

  it("generic-reliance demotion: cop-outs are dropped", () => {
    const p = parseReply(wrap([claim("unsupported", "x", "the user might be misled")]))!;
    expect(p.claims).toHaveLength(0);
  });
});

describe("audit — verdict parsing never throws (R8)", () => {
  it("a non-JSON reply produces {error}, not a throw", async () => {
    const dir = await repo();
    const auditor = fakeAuditor("I refuse to answer in JSON, sorry.");
    const v = await audit(job(dir), auditor);
    expect(v.error).toMatch(/jev did not run/i);
    expect(v.claims).toEqual([]);
  });

  it("an auditor.invoke throw reports that Jev did not run", async () => {
    const dir = await repo();
    const auditor: Auditor = {
      tier: "pre-gathered",
      vendor: "jev",
      sameFamily: false,
      async invoke() {
        throw new Error("jev http 503");
      },
    };
    const v = await audit(job(dir), auditor);
    expect(v.error).toMatch(/jev did not run/i);
    expect(v.error).toContain("jev http 503");
  });

  it("tier absent: no invocation, error names Jev", async () => {
    const dir = await repo();
    const auditor: Auditor = {
      tier: "absent",
      vendor: "none",
      sameFamily: false,
      async invoke() {
        throw new Error("should never be called");
      },
    };
    const v = await audit(job(dir), auditor);
    expect(v.error).toMatch(/jev did not run/i);
    expect(v.claims).toEqual([]);
  });
});

describe("audit — R5 duplicate-warning suppression", () => {
  it("the same claim's warning is not repeated once it's in priorWarnings", async () => {
    const dir = await repo();
    const reply = '{"claims":[{"claim":"fixed the bug","verdict":"unsupported","basis":"no diff shows this change","evidence":"","reliance":"the user ships the bug believing it was fixed"}],"unaccountable":false,"note":""}';
    const auditor = fakeAuditor(reply);
    const first = await audit(job(dir), auditor);
    expect(first.warnings).toEqual(['Agent, you have no basis to claim "fixed the bug" — no diff shows this change: if false — the user ships the bug believing it was fixed']);
    const second = await audit(job(dir, { priorWarnings: first.warnings }), auditor);
    expect(second.warnings).toEqual([]);
  });
});

describe("audit — R9 unaccountable work", () => {
  it("unaccountable true produces the fixed warning", async () => {
    const dir = await repo();
    const auditor = fakeAuditor('{"claims":[],"unaccountable":true,"note":""}');
    const v = await audit(job(dir), auditor);
    expect(v.unaccountable).toBe(true);
    expect(v.warnings[0]).toContain("did substantial work but reported nothing checkable");
  });
});

describe("demoteFullSessionFigures — the false-flag mechanism fix", () => {
  const flag = (claim: string): ClaimVerdict => ({ claim, verdict: "unsupported", basis: "no receipt this turn", evidence: "", reliance: "the user carries this total into a decision" });

  it("DEMOTES a claim whose figure is verbatim in an earlier tool_result", () => {
    const claim = "cart: $60.00 subtotal, free shipping, $60.00 total";
    const fullSession = "some earlier turn's output\ncart: $60.00 subtotal, free shipping, $60.00 total\nmore unrelated tool output";
    const out = demoteFullSessionFigures([flag(claim)], fullSession);
    expect(out[0]!.verdict).toBe("supported");
    expect(out[0]!.basis).toContain("session receipts outside the audited window");
  });

  it("KEEPS a fabricated figure that matches NOTHING in the session", () => {
    const claim = "throughput is 253,000 requests per second";
    const fullSession = "git log: 3 commits\ntest run: 12 passed";
    expect(demoteFullSessionFigures([flag(claim)], fullSession)[0]!.verdict).toBe("unsupported");
  });
});

describe("audit — telemetry (one event per audit)", () => {
  let tmpDir: string;
  let prevPath: string | undefined;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vs-audit-telemetry-"));
    prevPath = process.env.VS_TELEMETRY_PATH;
    process.env.VS_TELEMETRY_PATH = join(tmpDir, "telemetry.jsonl");
  });
  afterEach(async () => {
    if (prevPath === undefined) delete process.env.VS_TELEMETRY_PATH;
    else process.env.VS_TELEMETRY_PATH = prevPath;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("logs one 'audit' event with usage populated", async () => {
    const dir = await repo();
    const reply =
      '{"claims":[{"claim":"x","verdict":"unsupported","basis":"y","evidence":"z","reliance":"the user relies on x and is burned when it is false"}],"unaccountable":false,"note":""}';
    const auditor = fakeAuditor(reply, { vendor: "jev", model: "jev-latest" });
    const invoke = auditor.invoke.bind(auditor);
    auditor.invoke = async (prompt, callDir, timeoutMs) => {
      const out = await invoke(prompt, callDir, timeoutMs);
      auditor.lastUsage = { status: "reported", inputTokens: 123, outputTokens: 45, model: "jev-latest" };
      return out;
    };
    await audit(job(dir), auditor);

    const firings: Firing[] = readFirings();
    expect(firings).toHaveLength(1);
    const f = firings[0]!;
    expect(f.event).toBe("audit");
    expect(f.blocked).toBe(false);
    expect(f.auditor_vendor).toBe("jev");
    expect(f.auditor_model).toBe("jev-latest");
    expect(f.audit_usage).toEqual({ status: "reported", input_tokens: 123, output_tokens: 45 });
  });

  it("tags auditor_tier 'absent' when Jev did not run", async () => {
    const dir = await repo();
    const auditor: Auditor = { tier: "absent", vendor: "none", sameFamily: false, async invoke() { throw new Error("x"); } };
    await audit(job(dir), auditor);
    const firings = readFirings();
    expect(firings[0]!.auditor_tier).toBe("absent");
    expect(firings[0]!.audit_usage).toEqual({ status: "not-run", reason: "auditor-absent" });
    expect(firings[0]!.caught).toMatch(/jev did not run/i);
  });
});

describe("audit — Jev deterministic input filter", () => {
  it("does not invoke Jev when no deterministic load-bearing span survives", async () => {
    const dir = await repo();
    const auditor = fakeAuditor(OK_REPLY);
    const v = await audit(
      job(dir, { finalMessage: "Could this be the timeout? It might be, but I have not verified it." }),
      auditor,
    );
    expect(auditor.calls).toHaveLength(0);
    expect(v.auditUsage).toEqual({ status: "not-run", reason: "gated" });
  });

  it("sends Jev only the strongest surviving spans and structured receipt outcomes", async () => {
    const dir = await repo();
    const auditor = fakeAuditor(OK_REPLY);
    const receipts = [
      '> Bash {"command":"pnpm test"}',
      "< src/cache.ts: 128 tests passed in 4.2 seconds",
      '> Bash {"command":"curl https://example.test/noise"}',
      `< ${"unrelated output ".repeat(300)}`,
    ].join("\n");
    await audit(
      job(dir, {
        finalMessage: [
          "Maybe the earlier timeout was environmental.",
          "I updated src/cache.ts; all 128 tests passed in 4.2 seconds.",
          "Could there still be a race?",
        ].join("\n"),
        receipts,
      }),
      auditor,
    );

    expect(auditor.calls).toHaveLength(1);
    const state = JSON.parse(auditor.calls[0]!.prompt) as { finalMessage: string; evidence: string };
    expect(state.finalMessage).toBe("I updated src/cache.ts;\nall 128 tests passed in 4.2 seconds.");
    expect(state.evidence).toContain("pnpm test");
    expect(state.evidence).toContain("outcome=pass");
    expect(Buffer.byteLength(auditor.calls[0]!.prompt, "utf8")).toBeLessThan(10_000);
  });
});

describe("delivery policy — deliveryMode() fail-open", () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env.VS_DELIVERY; });
  afterEach(() => { if (prev === undefined) delete process.env.VS_DELIVERY; else process.env.VS_DELIVERY = prev; });

  it("defaults to quiet when unset, and for any non-'full' value", () => {
    delete process.env.VS_DELIVERY;
    expect(deliveryMode()).toBe("quiet");
    process.env.VS_DELIVERY = "banana";
    expect(deliveryMode()).toBe("quiet");
    process.env.VS_DELIVERY = "full";
    expect(deliveryMode()).toBe("full");
  });
});

describe("delivery policy — quiet suppression predicate", () => {
  const c = (verdict: ClaimVerdict["verdict"], claim: string): ClaimVerdict => ({ claim, verdict, basis: "b", evidence: "e", reliance: "r".repeat(30) });

  it("DELIVERED under quiet: contradicted / quantified / completion-shaped", () => {
    expect(claimDeliverableUnderQuiet(c("contradicted", "PR #39 is merged and CI is green."))).toBe(true);
    expect(claimDeliverableUnderQuiet(c("unsupported", "The revert rate holds steady at 2%."))).toBe(true);
    expect(claimDeliverableUnderQuiet(c("unsupported", "All tests pass."))).toBe(true);
  });

  it("SUPPRESSED under quiet: unquantified inference", () => {
    expect(claimDeliverableUnderQuiet(c("unsupported", "Discord fits this workflow better than Slack would."))).toBe(false);
  });
});

describe("audit() — delivery policy wired end-to-end", () => {
  let tmpDir: string;
  let prevPath: string | undefined;
  let prevDelivery: string | undefined;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vs-delivery-telemetry-"));
    prevPath = process.env.VS_TELEMETRY_PATH;
    prevDelivery = process.env.VS_DELIVERY;
    process.env.VS_TELEMETRY_PATH = join(tmpDir, "telemetry.jsonl");
  });
  afterEach(async () => {
    if (prevPath === undefined) delete process.env.VS_TELEMETRY_PATH; else process.env.VS_TELEMETRY_PATH = prevPath;
    if (prevDelivery === undefined) delete process.env.VS_DELIVERY; else process.env.VS_DELIVERY = prevDelivery;
    await rm(tmpDir, { recursive: true, force: true });
  });
  const lastFiring = (): Firing => { const fs = readFirings(); return fs[fs.length - 1]!; };
  const single = (verdict: string, claim: string): string =>
    JSON.stringify({ claims: [{ claim, verdict, basis: "b", evidence: "e", reliance: "the user acts on this claim before the next exchange" }], unaccountable: false, note: "" });

  it("quiet: an unquantified unsupported claim is telemetered but not delivered", async () => {
    delete process.env.VS_DELIVERY;
    const dir = await repo();
    const claim = "Discord fits this workflow better than Slack would.";
    const auditor = fakeAuditor(single("unsupported", claim));
    const v = await audit(job(dir), auditor);
    expect(v.warnings).toHaveLength(1);
    expect(v.deliverableWarnings).toEqual([]);
    expect(lastFiring().delivery).toBe("suppressed-quiet");
  });

  it("quiet: a contradicted claim is delivered", async () => {
    delete process.env.VS_DELIVERY;
    const dir = await repo();
    const auditor = fakeAuditor(single("contradicted", "PR #39 is merged and CI is green."));
    const v = await audit(job(dir), auditor);
    expect(v.deliverableWarnings).toEqual(v.warnings);
    expect(lastFiring().delivery).toBe("quiet");
  });
});

describe("verifyAnchor — verbatim string verification", () => {
  const FINAL = "The flakiness comes from the shared session cache. So I'm ripping the shared cache out now — this refactor lands tonight.";

  it("verbatim quote from the final message → verified", () => {
    expect(verifyAnchor("this refactor lands tonight", FINAL, undefined)).toBe("verified");
  });

  it("a paraphrase that is not verbatim → void", () => {
    expect(verifyAnchor("I am going to remove the cache tonight", FINAL, undefined)).toBe("void");
  });

  it("no depends_on → n/a", () => {
    expect(verifyAnchor(undefined, FINAL, undefined)).toBe("n/a");
  });

  it("normalizeAnchor strips emphasis + surrounding quotes", () => {
    expect(normalizeAnchor('  **"Applying   the Fix"**  ')).toBe("applying the fix");
  });
});
