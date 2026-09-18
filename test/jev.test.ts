import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JEV_CONFIDENCE_FLOOR,
  JEV_CRITERIA,
  JEV_ENDPOINT,
  JEV_FINDING_IDS,
  JEV_INSTRUCTIONS,
  JEV_MODEL,
  buildJevRequest,
  choiceToAuditReply,
  isConfidentConfabulation,
  invokeJev,
  parseJevResponse,
  type JevChoice,
} from "../src/jev.js";

const SECRET = "sk-test-never-log-this-value";

function choice(overrides: Partial<JevChoice> = {}): JevChoice {
  return {
    choice: "not_confabulation",
    confidence: 0.9,
    probabilities: { confabulation_state: 0.05, confabulation_diagnosis: 0.05, not_confabulation: 0.9 },
    ...overrides,
  };
}

describe("Jev Choice mapping — low sensitivity", () => {
  it("the question names the two target classes, the rely-on-it bar, and the non-flags", () => {
    expect(JEV_INSTRUCTIONS).toContain("person would RELY");
    expect(JEV_INSTRUCTIONS).toContain("Honest uncertainty");
    expect(JEV_INSTRUCTIONS).toContain("judgment");
    expect(JEV_INSTRUCTIONS).toContain("fiction");
    expect(JEV_INSTRUCTIONS).toContain("reasoned inference");
    expect(JEV_CRITERIA.confabulation_state).toContain("PRE-EXISTING");
    expect(JEV_CRITERIA.confabulation_diagnosis).toContain("IP allow-list");
    expect(JEV_CRITERIA.not_confabulation).toContain("Honest uncertainty");
  });

  it("the anchor-shaped state claim at high confidence is a catch", () => {
    const answer = choice({
      choice: "confabulation_state",
      confidence: 0.88,
      probabilities: { confabulation_state: 0.8, confabulation_diagnosis: 0.1, not_confabulation: 0.1 },
    });
    expect(isConfidentConfabulation(answer)).toBe(true);
    const parsed = JSON.parse(choiceToAuditReply(answer, "PRE-EXISTING - fails on clean tree too")) as {
      claims: Array<{ verdict: string; claim: string; reliance: string }>;
    };
    expect(parsed.claims[0]!.verdict).toBe("contradicted");
    expect(parsed.claims[0]!.claim).toContain("PRE-EXISTING");
    expect(parsed.claims[0]!.reliance.length).toBeGreaterThan(20);
    expect(parsed.claims[0]!.reliance.length).toBeGreaterThan(20);
  });

  it("a confident diagnosis with no evidence chain is unsupported", () => {
    const answer = choice({
      choice: "confabulation_diagnosis",
      confidence: 0.81,
      probabilities: { confabulation_state: 0.05, confabulation_diagnosis: 0.85, not_confabulation: 0.1 },
    });
    expect(isConfidentConfabulation(answer)).toBe(true);
    const parsed = JSON.parse(choiceToAuditReply(answer, "the timeouts are an IP allow-list")) as {
      claims: Array<{ verdict: string }>;
    };
    expect(parsed.claims[0]!.verdict).toBe("unsupported");
  });

  it("honest uncertainty / not_confabulation is never a catch, even at high confidence", () => {
    const answer = choice({ choice: "not_confabulation", confidence: 0.99 });
    expect(isConfidentConfabulation(answer)).toBe(false);
    const parsed = JSON.parse(choiceToAuditReply(answer, "I'd need to benchmark this")) as { claims: unknown[] };
    expect(parsed.claims).toEqual([]);
  });

  it("a confabulation Choice below the confidence floor fail-opens (low sensitivity)", () => {
    const answer = choice({
      choice: "confabulation_state",
      confidence: JEV_CONFIDENCE_FLOOR - 0.2,
      probabilities: { confabulation_state: 0.7, confabulation_diagnosis: 0.1, not_confabulation: 0.2 },
    });
    expect(isConfidentConfabulation(answer)).toBe(false);
  });

  it("judgment, fiction, and reasoned inference are in the not_confabulation criterion", () => {
    expect(JEV_CRITERIA.not_confabulation.toLowerCase()).toContain("judgment");
    expect(JEV_CRITERIA.not_confabulation.toLowerCase()).toContain("fiction");
    expect(JEV_CRITERIA.not_confabulation.toLowerCase()).toContain("reasoned inference");
  });
});

describe("parseJevResponse — malformed replies throw (caller fail-opens)", () => {
  it("accepts a well-formed Choice", () => {
    const raw = {
      answers: {
        finding: {
          choice: "not_confabulation",
          confidence: 0.6,
          probabilities: { confabulation_state: 0.1, confabulation_diagnosis: 0.1, not_confabulation: 0.8 },
        },
      },
    };
    expect(parseJevResponse(raw).choice).toBe("not_confabulation");
  });

  it("rejects missing options, bad confidence, and probabilities that do not sum to 1", () => {
    expect(() => parseJevResponse({})).toThrow();
    expect(() =>
      parseJevResponse({
        answers: { finding: { choice: "nope", confidence: 0.5, probabilities: { a: 1 } } },
      }),
    ).toThrow();
    expect(() =>
      parseJevResponse({
        answers: {
          finding: {
            choice: "not_confabulation",
            confidence: 1.5,
            probabilities: { confabulation_state: 0.1, confabulation_diagnosis: 0.1, not_confabulation: 0.8 },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseJevResponse({
        answers: {
          finding: {
            choice: "not_confabulation",
            confidence: 0.5,
            probabilities: { confabulation_state: 0.9, confabulation_diagnosis: 0.9, not_confabulation: 0.9 },
          },
        },
      }),
    ).toThrow();
  });
});

describe("invokeJev — header-only secret, fixed endpoint, fail-open on outage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TYPESAFE_API_KEY;
  });

  it("POSTs to the fixed endpoint with Authorization and never puts the key on the body", async () => {
    process.env.TYPESAFE_API_KEY = SECRET;
    const seen: { url?: string; auth?: string; body?: string } = {};
    vi.stubGlobal(
      "fetch",
      async (url: string | URL, init?: RequestInit) => {
        seen.url = String(url);
        const headers = new Headers(init?.headers);
        seen.auth = headers.get("Authorization") ?? "";
        seen.body = typeof init?.body === "string" ? init.body : "";
        return new Response(
          JSON.stringify({
            model: JEV_MODEL,
            answers: {
              finding: {
                choice: "confabulation_state",
                confidence: 0.9,
                probabilities: { confabulation_state: 0.8, confabulation_diagnosis: 0.1, not_confabulation: 0.1 },
              },
            },
            usage: { input_tokens: 100, output_tokens: 60 },
          }),
          { status: 200 },
        );
      },
    );

    const reply = await invokeJev(
      JSON.stringify({
        userRequest: "is this pre-existing?",
        finalMessage: "PRE-EXISTING - fails on clean tree too",
        evidence: "git show HEAD: README.md only; no clean-tree test run",
      }),
    );
    expect(seen.url).toBe(JEV_ENDPOINT);
    expect(seen.auth).toBe(`Bearer ${SECRET}`);
    expect(seen.body).not.toContain(SECRET);
    const req = JSON.parse(seen.body!) as { model: string; questions: { finding: { criteria: Record<string, string> } } };
    expect(req.model).toBe(JEV_MODEL);
    expect(Object.keys(req.questions.finding.criteria).sort()).toEqual([...JEV_FINDING_IDS].sort());
    const parsed = JSON.parse(reply) as { claims: Array<{ verdict: string }> };
    expect(parsed.claims[0]!.verdict).toBe("contradicted");
  });

  it("an HTTP 500 does not block — invoke throws so the hook fail-opens", async () => {
    process.env.TYPESAFE_API_KEY = SECRET;
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    await expect(invokeJev("x")).rejects.toThrow(/jev http 500/);
  });

  it("a malformed 200 throws", async () => {
    process.env.TYPESAFE_API_KEY = SECRET;
    vi.stubGlobal("fetch", async () => new Response("not-json", { status: 200 }));
    await expect(invokeJev("x")).rejects.toThrow(/not JSON/);
  });

  it("missing key throws without calling fetch", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(invokeJev("x")).rejects.toThrow(/TYPESAFE_API_KEY not set/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("buildJevRequest never includes an authorization field", () => {
    const req = JSON.stringify(
      buildJevRequest({ userRequest: "u", finalMessage: "m", evidence: "e" }),
    );
    expect(req).not.toMatch(/Bearer|TYPESAFE|api[_-]?key/i);
  });
});
