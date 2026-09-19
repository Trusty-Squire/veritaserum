import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Fixture {
  id: string;
  domain: "backend" | "frontend";
  shape: string;
  expect: "flag" | "clean";
  userRequest: string;
  finalMessage: string;
  receipts: string;
}

const fixtures = JSON.parse(
  readFileSync(new URL("../eval/jev-compression/fixtures.json", import.meta.url), "utf8"),
) as Fixture[];

describe("Jev compression fixture corpus", () => {
  it("keeps the original 24 and expands to a unique, balanced corpus", () => {
    expect(fixtures).toHaveLength(60);
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(60);
    expect(fixtures.filter((fixture) => fixture.domain === "backend")).toHaveLength(30);
    expect(fixtures.filter((fixture) => fixture.domain === "frontend")).toHaveLength(30);
    expect(fixtures.filter((fixture) => fixture.expect === "flag")).toHaveLength(30);
    expect(fixtures.filter((fixture) => fixture.expect === "clean")).toHaveLength(30);
    expect(fixtures.slice(0, 24).map((fixture) => fixture.id)).toEqual([
      "backend-test-contradicted",
      "backend-test-supported",
      "backend-commit-contradicted",
      "backend-commit-supported",
      "backend-scope-overclaim",
      "backend-honest-hedge",
      "backend-no-claim",
      "backend-cause-unsupported",
      "backend-cause-supported",
      "backend-named-suite-mismatch",
      "backend-uncommitted-supported",
      "backend-blocker-supported",
      "frontend-overflow-contradicted",
      "frontend-overflow-supported",
      "frontend-breakpoints-incomplete",
      "frontend-breakpoints-supported",
      "frontend-figma-exact-unsupported",
      "frontend-honest-visual-hedge",
      "frontend-design-judgment",
      "frontend-a11y-contradicted",
      "frontend-a11y-supported",
      "frontend-button-hidden",
      "frontend-animation-supported",
      "frontend-human-observation-supported",
    ]);
  });

  it("contains catches, supported claims, honest hedges, and no-claim turns in both domains", () => {
    for (const domain of ["backend", "frontend"] as const) {
      const rows = fixtures.filter((fixture) => fixture.domain === domain);
      expect(rows.some((fixture) => fixture.expect === "flag")).toBe(true);
      expect(rows.some((fixture) => fixture.shape === "supported")).toBe(true);
      expect(rows.some((fixture) => fixture.shape === "hedge")).toBe(true);
      expect(rows.some((fixture) => fixture.shape === "no-claim")).toBe(true);
    }
  });

  it("includes scope-only and non-receipt evidence cases", () => {
    expect(fixtures.some((fixture) => fixture.id === "backend-scope-overclaim")).toBe(true);
    expect(fixtures.some((fixture) => fixture.shape === "supported-non-receipt")).toBe(true);
    expect(fixtures.some((fixture) => fixture.receipts.startsWith("BROWSER_ASSERT"))).toBe(true);
  });
});
