import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/frontend/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "frontend/index.ts",
        "frontend/player.ts",
        "frontend/protocol.ts",
        "frontend/scheduler.ts",
      ],
      reportsDirectory: "test-results/coverage/frontend",
      reporter: ["text", "json"],
      thresholds: {
        branches: 90,
        perFile: true,
      },
    },
  },
});
