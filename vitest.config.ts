import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts so tests don't run through the addon's
// library build (tailwind, externals). Tests needing a DOM opt in per file with
// a `// @vitest-environment jsdom` pragma.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/index.ts", "src/web.ts"],
      reporter: ["text", "text-summary"],
    },
  },
});
