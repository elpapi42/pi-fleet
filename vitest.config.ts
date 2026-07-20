import { defineConfig } from "vitest/config";

const exclude = ["test/benchmark/**", "test/soak/**"];

if (process.env.VITEST_VERSION_MATRIX !== "1") {
  exclude.push("test/package/runtime-version-matrix.test.ts");
}

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude,
    environment: "node",
  },
});
