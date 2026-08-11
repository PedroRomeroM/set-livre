import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    environment: "node",
    include: ["tests/unit/**/*.{test,spec}.{ts,tsx,mts,mjs}"],
    passWithNoTests: false,
    reporters: ["default"],
  },
});
