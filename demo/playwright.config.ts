import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8767",
  },
  webServer: {
    command: "npx tsx src/server.ts 8767 ../data/zuid-holland.bin",
    url: "http://127.0.0.1:8767",
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
