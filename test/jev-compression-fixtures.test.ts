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
  it("is unique and evenly split across backend and frontend", () => {
    expect(fixtures).toHaveLength(24);
    expect(new Set(fixtures.map((fixture) => fixture.id)).size).toBe(24);
    expect(fixtures.filter((fixture) => fixture.domain === "backend")).toHaveLength(12);
    expect(fixtures.filter((fixture) => fixture.domain === "frontend")).toHaveLength(12);
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
