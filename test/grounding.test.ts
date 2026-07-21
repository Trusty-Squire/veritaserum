/**
 * Hermetic unit tests for the no-LLM grounding detector (src/grounding.ts).
 * No ollama, no network: a fake Embedder returns deterministic vectors so
 * classification is fully controlled. Each class maps to an orthonormal basis
 * direction (BLOCKER/CAUSAL/SETTLED/NEUTRAL/HEDGED); the fake classes the
 * detector's internal seed phrases by keyword into those same directions, so
 * the runtime centroids come out exactly on-basis and a test sentence lands in
 * whatever class we want — either by keyword or by an explicit per-text
 * override.
 *
 * Covers: the hedge guard (a lexical cue drops even a BLOCKER-classed
 * sentence), blocked-no-attempt (fires with no attempt, silent when a real
 * attempt unit exists), causal-no-referent (fires when the blamed cause was
 * never observed, silent when a glossed 429 observation is present — which
 * also exercises the HTTP gloss, since the raw line would not class as the
 * cause), number normalization (253k == 253000, $2.31 == 2.31), doc-read-only
 * grounding (still warns), per-rule dedupe (R5), and fail-open (a throwing
 * embedder → { flags: [], error }).
 */
import { describe, it, expect } from "vitest";
import { groundingCheck } from "../src/grounding.js";
import type { Embedder } from "../src/embed.js";

// Orthonormal class directions (dim 5).
const DIR = {
  BLOCKER: [1, 0, 0, 0, 0],
  CAUSAL: [0, 1, 0, 0, 0],
  SETTLED: [0, 0, 1, 0, 0],
  NEUTRAL: [0, 0, 0, 1, 0],
  HEDGED: [0, 0, 0, 0, 1],
} as const;

/** Keyword classifier — order matters (HEDGED before BLOCKER so "can't
 *  determine" reads as a hedge, not a blocker). Covers every internal seed
 *  phrase and the test sentences below. */
function classVec(text: string): number[] {
  const t = text.toLowerCase();
  if (/\b(might|maybe|possibly|probably|appears?|seems?|roughly|not sure|need to|without profiling|benchmark|measure|depends on|verify|verified|can't determine|cannot determine)\b/.test(t))
    return [...DIR.HEDGED];
  if (/\b(can't be done|cannot be automated|impossible|locked|out of (funds|money)|rejects all|no way|app-only|blocked|frozen|no endpoint|denied)\b/.test(t))
    return [...DIR.BLOCKER];
  if (/\b(caused by|because of|bottleneck|root cause|due to|stems from|responsible for|reason it fails|reason)\b|rate limit/.test(t))
    return [...DIR.CAUSAL];
  if (
    /\d/.test(t) ||
    /tests?\s+pass/.test(t) ||
    /\b(commit|committed|push|pushed|build is green|ci is passing|deployed)\b/.test(t) ||
    // "changes made" seeds/claims (StateKind "change") — past-tense work reports.
    // Suffix-required verbs so "next I'll refactor" / "the refactor" stay NEUTRAL,
    // consistent with the detector's own stateKindsOf change cue.
    /\b(implemented|fixed|corrected|added|refactored|updated|renamed|patched|resolved|edited|wrote)\b/.test(t) ||
    /\b(made|applied)\s+(?:the\s+)?(change|changes|edit|edits|patch)\b/.test(t)
  )
    return [...DIR.SETTLED];
  return [...DIR.NEUTRAL];
}

/** Fake Embedder: explicit overrides first (to pin a specific sentence or
 *  receipt line onto a chosen direction), else keyword-classified. */
function fakeEmbedder(overrides: Record<string, keyof typeof DIR> = {}): Embedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => (t in overrides ? [...DIR[overrides[t]!]] : classVec(t)));
    },
  };
}

/** An Embedder that always throws — to exercise the fail-open path. */
function throwingEmbedder(): Embedder {
  return {
    async embed(): Promise<number[][]> {
      throw new Error("ollama unreachable");
    },
  };
}

describe("grounding — hedge guard", () => {
  it("drops a BLOCKER-classed sentence carrying a lexical hedge cue (never flags honest uncertainty)", async () => {
    const claim = "This might be impossible to automate from the API.";
    const res = await groundingCheck(
      { finalMessage: claim, receipts: "> Read {\"file_path\":\"README.md\"}\n< docs" },
      // Pin the sentence onto BLOCKER so only the lexical "might" can drop it.
      fakeEmbedder({ [claim]: "BLOCKER" }),
    );
    expect(res.flags).toEqual([]);
  });
});

describe("grounding — blocked-no-attempt", () => {
  const claim = "There is no way to arm the vault, so this cannot be automated.";

  it("fires (block) when no tool call attempted the thing", async () => {
    const res = await groundingCheck(
      {
        finalMessage: claim,
        receipts: "> Bash {\"command\":\"git status\"}\n< clean\n> Read {\"file_path\":\"README.md\"}\n< docs",
      },
      fakeEmbedder({ [claim]: "BLOCKER" }),
    );
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]!.rule).toBe("blocked-no-attempt");
    expect(res.flags[0]!.severity).toBe("block");
  });

  it("stays silent when a related attempt IS in the receipts", async () => {
    const attempt = "> Bash {\"command\":\"curl -X POST https://api/arm\"}";
    // The detector searches attempt UNITS (call + its results), so the
    // override must pin the whole unit onto the claim's direction.
    const attemptUnit = `${attempt}\n< 200 ok`;
    const res = await groundingCheck(
      { finalMessage: claim, receipts: `${attempt}\n< 200 ok` },
      fakeEmbedder({ [claim]: "BLOCKER", [attemptUnit]: "BLOCKER" }),
    );
    expect(res.flags).toEqual([]);
  });

  it("dedupes: one impossibility claim split across two sentences yields ONE flag (R5)", async () => {
    const res = await groundingCheck(
      {
        finalMessage: "The funds are locked. There is no way to automate this.",
        receipts: "> Bash {\"command\":\"git status\"}\n< clean",
      },
      fakeEmbedder(),
    );
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]!.rule).toBe("blocked-no-attempt");
  });
});

describe("grounding — causal-no-referent", () => {
  const claim = "The submit failures are caused by the rate limiter.";

  it("fires (warn, never block) when the blamed cause was never observed", async () => {
    const res = await groundingCheck(
      {
        finalMessage: claim,
        receipts: "> Bash {\"command\":\"git status\"}\n< clean\n> Read {\"file_path\":\"src/submit.ts\"}\n< export function submit(){}",
      },
      fakeEmbedder(),
    );
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]!.rule).toBe("causal-no-referent");
    expect(res.flags[0]!.severity).toBe("warn");
    expect(res.flags[0]!.basis).toMatch(/never observed/i);
  });

  it("stays silent when the cause was observed in a result (glossed 429)", async () => {
    // The raw line "< HTTP/1.1 429 Too Many Requests" classes SETTLED in this
    // fake (digits), so silence here proves the HTTP gloss ran: the ENRICHED
    // line contains "rate limited", which the fake maps onto CAUSAL — the
    // claim's own direction.
    const res = await groundingCheck(
      {
        finalMessage: claim,
        receipts: "> Bash {\"command\":\"curl -i https://api/orders\"}\n< HTTP/1.1 429 Too Many Requests - Retry-After: 30",
      },
      fakeEmbedder(),
    );
    expect(res.flags).toEqual([]);
  });
});

describe("grounding — number-no-receipt (normalization + doc-read grounding)", () => {
  it("253k normalizes to 253000 and, grounded only in a doc read, still warns", async () => {
    const claim = "createPlay needs 253k gas, so the budget is fine.";
    const res = await groundingCheck(
      {
        finalMessage: claim,
        receipts:
          "> Read {\"file_path\":\"NOTES.md\"}\n< gas budget: createPlay ~253000 gas (measured back in April)",
      },
      fakeEmbedder({ [claim]: "SETTLED" }),
    );
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]!.rule).toBe("number-no-receipt");
    expect(res.flags[0]!.severity).toBe("warn");
    expect(res.flags[0]!.basis).toMatch(/stored doc/i);
  });

  it("$2.31 matches a measured 2.31 in an execution receipt → grounded, no flag", async () => {
    const claim = "The balance is $2.31.";
    const res = await groundingCheck(
      {
        finalMessage: claim,
        receipts: "> Bash {\"command\":\"cast balance 0xabc\"}\n< 2.31",
      },
      fakeEmbedder({ [claim]: "SETTLED" }),
    );
    expect(res.flags).toEqual([]);
  });

  it("$2.31 with no receipt at all → warns (no producing receipt)", async () => {
    const claim = "The balance is $2.31.";
    const res = await groundingCheck(
      { finalMessage: claim, receipts: "> Bash {\"command\":\"ls\"}\n< a b c" },
      fakeEmbedder({ [claim]: "SETTLED" }),
    );
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]!.rule).toBe("number-no-receipt");
    expect(res.flags[0]!.evidence).toMatch(/no receipt line/i);
  });
});

describe("grounding — state-no-receipt (git probe + receipt signatures)", () => {
  const committed = "Committed the fix.";
  const pushed = "Pushed to main.";

  it("probe CONTRADICTION fires block: committed while tree is dirty and HEAD is old", async () => {
    const res = await groundingCheck(
      {
        finalMessage: committed,
        receipts: "> Bash {\"command\":\"git diff\"}\n< diff --git a/src/fix.ts b/src/fix.ts",
        gitState: { headSha: "abc1234", headAgeSeconds: 86400, dirty: true, aheadOfUpstream: 0 },
      },
      fakeEmbedder({ [committed]: "SETTLED" }),
    );
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]!.rule).toBe("state-no-receipt");
    expect(res.flags[0]!.severity).toBe("block");
    expect(res.flags[0]!.basis).toMatch(/commit/i);
  });

  it("probe CONTRADICTION outranks a satisfying receipt: pushed while ahead of upstream, even with a git push call", async () => {
    const res = await groundingCheck(
      {
        finalMessage: pushed,
        // A real git push receipt is present — but the probe says the branch is
        // still 3 ahead, so the probe wins (receipts can be stale within a turn).
        receipts: "> Bash {\"command\":\"git push origin main\"}\n< To github.com:acme/x.git\n<    abc1234..def5678  main -> main",
        gitState: { headSha: "def5678", headAgeSeconds: 60, dirty: false, aheadOfUpstream: 3 },
      },
      fakeEmbedder({ [pushed]: "SETTLED" }),
    );
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]!.rule).toBe("state-no-receipt");
    expect(res.flags[0]!.severity).toBe("block");
    expect(res.flags[0]!.evidence).toMatch(/ahead of upstream/i);
  });

  it("probe SATISFACTION stays silent even with NO commit receipt (clean tree, fresh HEAD)", async () => {
    const res = await groundingCheck(
      {
        finalMessage: committed,
        receipts: "> Bash {\"command\":\"ls\"}\n< src package.json",
        gitState: { headSha: "abc1234", headAgeSeconds: 30, dirty: false, aheadOfUpstream: 0 },
      },
      fakeEmbedder({ [committed]: "SETTLED" }),
    );
    expect(res.flags).toEqual([]);
  });

  it("receipt-signature tier: a real test run with pass output grounds 'all tests pass' (no gitState)", async () => {
    const claim = "All tests pass.";
    const res = await groundingCheck(
      {
        finalMessage: claim,
        receipts: "> Bash {\"command\":\"pnpm test\"}\n< Tests  12 passed (12)",
      },
      fakeEmbedder({ [claim]: "SETTLED" }),
    );
    expect(res.flags).toEqual([]);
  });

  it("receipt-signature tier: 'all tests pass' with no test invocation → warn", async () => {
    const claim = "All tests pass.";
    const res = await groundingCheck(
      {
        finalMessage: claim,
        receipts: "> Read {\"file_path\":\"src/parser.ts\"}\n< export function parse(){}",
      },
      fakeEmbedder({ [claim]: "SETTLED" }),
    );
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]!.rule).toBe("state-no-receipt");
    expect(res.flags[0]!.severity).toBe("warn");
  });

  it("gitState ABSENT → probe rules inert: pushed with no push receipt warns (not block)", async () => {
    const res = await groundingCheck(
      {
        finalMessage: pushed,
        receipts: "> Bash {\"command\":\"git status\"}\n< clean",
      },
      fakeEmbedder({ [pushed]: "SETTLED" }),
    );
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]!.rule).toBe("state-no-receipt");
    expect(res.flags[0]!.severity).toBe("warn");
  });
});

describe("grounding — state-no-receipt (changes-made / StateKind 'change')", () => {
  // "timeout bug" makes this sentence lean CAUSAL for the real embedder; the
  // fake classes it SETTLED by its "implemented"/"fixed" cues, and the override
  // pins it there explicitly.
  const change = "Implemented the retry logic and fixed the timeout bug.";
  const readsOnly =
    "> Read {\"file_path\":\"src/retry.ts\"}\n< export function withRetry(){}\n> Grep {\"pattern\":\"timeout\",\"path\":\"src\"}\n< src/retry.ts: // TODO honor timeout";

  it("probe CONTRADICTION fires block: clean tree + stale HEAD + no mutation receipt", async () => {
    const res = await groundingCheck(
      {
        finalMessage: change,
        receipts: readsOnly,
        gitState: { headSha: "aa11bb22", headAgeSeconds: 86400, dirty: false, aheadOfUpstream: 0 },
      },
      fakeEmbedder({ [change]: "SETTLED" }),
    );
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]!.rule).toBe("state-no-receipt");
    expect(res.flags[0]!.severity).toBe("block");
    expect(res.flags[0]!.basis).toMatch(/no file was edited/i);
  });

  it("dirty tree acquits even with no mutation receipt", async () => {
    const res = await groundingCheck(
      {
        finalMessage: change,
        receipts: readsOnly,
        gitState: { headSha: "aa11bb22", headAgeSeconds: 86400, dirty: true, aheadOfUpstream: null },
      },
      fakeEmbedder({ [change]: "SETTLED" }),
    );
    expect(res.flags).toEqual([]);
  });

  it("fresh HEAD acquits with no mutation receipt (the just-committed path)", async () => {
    const res = await groundingCheck(
      {
        finalMessage: change,
        receipts: "> Bash {\"command\":\"git log --oneline -1\"}\n< cc33dd44 add retry",
        gitState: { headSha: "cc33dd44", headAgeSeconds: 120, dirty: false, aheadOfUpstream: 1 },
      },
      fakeEmbedder({ [change]: "SETTLED" }),
    );
    expect(res.flags).toEqual([]);
  });

  it("receipt tier: an Edit call grounds the claim with no gitState → silent", async () => {
    const res = await groundingCheck(
      {
        finalMessage: change,
        receipts: "> Edit {\"file_path\":\"src/retry.ts\",\"old_string\":\"return fn()\",\"new_string\":\"return withTimeout(fn)\"}\n< edited src/retry.ts",
      },
      fakeEmbedder({ [change]: "SETTLED" }),
    );
    expect(res.flags).toEqual([]);
  });

  it("receipt tier: no mutation call and no gitState → warn", async () => {
    const res = await groundingCheck(
      { finalMessage: change, receipts: readsOnly },
      fakeEmbedder({ [change]: "SETTLED" }),
    );
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]!.rule).toBe("state-no-receipt");
    expect(res.flags[0]!.severity).toBe("warn");
    expect(res.flags[0]!.basis).toMatch(/changes were made/i);
  });

  it("a future-tense narration sentence never flags (classes NEUTRAL, no change cue)", async () => {
    const res = await groundingCheck(
      {
        finalMessage: "next I'll refactor this module",
        receipts: "> Read {\"file_path\":\"src/mod.ts\"}\n< export const x = 1",
      },
      fakeEmbedder(),
    );
    expect(res.flags).toEqual([]);
  });
});

describe("grounding — fail-open (R8)", () => {
  it("returns { flags: [], error } when the embedder throws, never rejects", async () => {
    const res = await groundingCheck(
      { finalMessage: "The funds are locked.", receipts: "> ls\n< x" },
      throwingEmbedder(),
    );
    expect(res.flags).toEqual([]);
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/ollama unreachable/);
  });
});
