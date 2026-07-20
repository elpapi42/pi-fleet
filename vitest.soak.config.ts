import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/soak/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
