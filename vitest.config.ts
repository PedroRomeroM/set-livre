import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      enforce: "pre",
      name: "set-livre-vitest-tsx",
      transform(source, id) {
        const queryStart = id.indexOf("?");
        const sourcePath = queryStart === -1 ? id : id.slice(0, queryStart);
        if (!sourcePath.endsWith(".tsx")) {
          return null;
        }
        return transformWithOxc(source, id, {
          jsx: { runtime: "automatic" },
          lang: "tsx",
          target: "es2022",
        });
      },
    },
  ],
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
