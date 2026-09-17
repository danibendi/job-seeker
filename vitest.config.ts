import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/fixtures/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    maxWorkers: 2,
  },
});
