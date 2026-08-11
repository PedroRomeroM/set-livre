import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
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
