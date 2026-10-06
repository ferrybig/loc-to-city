import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// The e2e tests click real places in Zuid-Holland, so they need the
// Netherlands build (`make netherlands`, see README), which isn't
// committed.
const DATASET = "../data/03-final/zuid-holland.bin";
if (!existsSync(new URL(DATASET, import.meta.url))) {
	throw new Error(
		`${DATASET} not found: build it with \`make netherlands\` from the repo root first`,
	);
}

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:8767",
	},
	webServer: {
		command: `node src/server.ts 8767 ${DATASET}`,
		url: "http://127.0.0.1:8767",
		reuseExistingServer: !process.env.CI,
		timeout: 30_000,
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
