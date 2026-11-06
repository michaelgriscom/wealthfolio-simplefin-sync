import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so tests skip the library build. DOM tests opt
// in with a `// @vitest-environment jsdom` pragma.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    // Snapshot dates use the clock, so pin the zone. Tests can stub another.
    env: { TZ: "UTC" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/index.ts", "src/web.ts"],
      reporter: ["text", "text-summary"],
    },
  },
});
