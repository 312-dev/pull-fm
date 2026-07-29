// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.turbo/**",
      "infra/**/.terraform/**",
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused args are usually a signal, but a leading underscore is the
      // conventional opt-out for interface-mandated parameters.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Floating promises in a request handler silently swallow errors and
      // produce responses that look fine while the work never happened.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",

      // `any` erases the type safety that the BOLA and vault code depends on.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // Enforce explicit boundaries on exported API: the BFF's exported
      // surface is a contract shared with the future client.
      "@typescript-eslint/explicit-module-boundary-types": "error",

      // Errors thrown must be Errors, so the error handler can rely on shape.
      "@typescript-eslint/only-throw-error": "error",

      // console is not a log sink in production; the structured logger is.
      // This also keeps the custom semgrep token-in-logs rule tractable.
      "no-console": ["error", { allow: ["warn", "error"] }],

      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-coercion": "error",
    },
  },

  // Build and tool config files live outside every package tsconfig's
  // `include`, so type-aware rules cannot resolve them. Lint them syntactically
  // instead of widening the tsconfigs, which would slow every other file down.
  {
    files: [
      "*.js",
      "*.ts",
      "**/*.config.js",
      "**/*.config.ts",
      // k6 scripts run in the k6 runtime, not Node, and tooling scripts sit
      // outside the TypeScript project graph on purpose.
      "load/**/*.js",
      "security/**/*.{js,mjs}",
      "packages/db/scripts/**/*.mjs",
      "infra/scripts/**/*.mjs",
    ],
    ...tseslint.configs.disableTypeChecked,
  },

  // Plain JavaScript tooling (k6 scenarios, mock upstreams, security scripts).
  // TypeScript-specific rules cannot apply to untyped JS, and these files run in
  // Node or the k6 runtime rather than the browser.
  {
    files: [
      "load/**/*.js",
      "security/**/*.{js,mjs}",
      "packages/db/scripts/**/*.mjs",
      "infra/scripts/**/*.mjs",
      "*.config.js",
    ],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        __ENV: "readonly", // k6 injects this
      },
    },
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "no-undef": "off",
      "no-console": "off",
    },
  },

  // Tests need more latitude: fixtures are intentionally loosely typed and
  // console output is useful when a gate fails in CI.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/test/**/*.ts", "load/**/*.js"],
    rules: {
      // Indexing a fixture array is safe in a test; the assertion documents an
      // invariant the test itself establishes.
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "no-console": "off",
    },
  },
);
