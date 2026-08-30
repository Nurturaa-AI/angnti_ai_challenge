import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "baseline/test/**/*.test.ts", "evaluation/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "fixtures/**"],
    environment: "node",
    // Repository walking and git fixtures touch the filesystem; keep a generous ceiling.
    testTimeout: 20_000,
    reporters: ["default"],
  },
});
