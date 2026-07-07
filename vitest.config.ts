import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // P0 gates shell out to git in temp dirs; give each test room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
