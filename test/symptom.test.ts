import { describe, it, expect } from "vitest";
import { redactSymptom } from "../src/symptom.js";
import type { GateResult } from "../src/gate-run.js";

function res(over: Partial<GateResult>): GateResult {
  return {
    command: "x",
    passed: false,
    exitCode: 1,
    timedOut: false,
    stdoutTail: "",
    stderrTail: "",
    durationMs: 5,
    ...over,
  };
}

describe("R5 symptom redaction", () => {
  it("drops assertion/stack lines that leak grader internals", () => {
    const s = redactSymptom(
      res({
        stderrTail: [
          "the pot did not increase after raise",
          "AssertionError: expected 100 to equal 200",
          "    at /home/u/app/test/poker.test.ts:42:15",
        ].join("\n"),
      }),
    );
    expect(s).toContain("the pot did not increase");
    expect(s).not.toMatch(/AssertionError/);
    expect(s).not.toMatch(/poker\.test\.ts/);
    expect(s).not.toMatch(/\/home\/u\/app/);
  });

  it("reports a timeout plainly", () => {
    expect(redactSymptom(res({ timedOut: true, durationMs: 3000 }))).toMatch(/timed out/);
  });

  it("handles empty output", () => {
    expect(redactSymptom(res({ exitCode: 7 }))).toMatch(/exit 7/);
  });
});
