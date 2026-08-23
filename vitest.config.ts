import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{mjs,ts}"],
    mockReset: true,
    restoreMocks: true,
  },
});
