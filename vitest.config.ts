import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // The packed-tarball suite builds, npm-packs, and npm-installs the real
    // package — it needs pnpm/npm on PATH and registry access, so it is not
    // part of the hermetic default run. `pnpm test:package` (its own CI step)
    // opts in via VS_PACKAGE_TESTS.
    exclude: ["**/node_modules/**", "**/dist/**", ...(process.env.VS_PACKAGE_TESTS ? [] : ["test/production-package.test.ts"])],
    // P0 gates shell out to git in temp dirs; give each test room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
