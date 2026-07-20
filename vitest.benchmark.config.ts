import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/benchmark/**/*.test.ts"],
    environment: "node",
    maxWorkers: 1,
  },
});
