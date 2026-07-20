import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.mjs", "bin/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/cli/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "../runtime/**",
            "../../runtime/**",
            "../store/**",
            "../../store/**",
            "../pi/**",
            "../../pi/**",
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
