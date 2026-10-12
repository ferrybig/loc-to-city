import { defineConfig, devices } from "@playwright/test";

// The e2e tests run against the format spec's own worked example
// (reader/binary-format.md Appendix A): a committed 157-byte file of seven
// places on a 2 x 2 chunk grid, so they need no build. Its one non-empty
// chunk spans latitudes [0, 90) and longitudes [0, 180), nowhere near
// where its places really are.
const DATASET = "../data/03-final/appendix-a-example.bin";
// Hand-written spot-checks for that file, for the page to draw as markers.
const CHECKS = "e2e/fixtures/appendix-a-example.checks.json";
const BASE_URL = "http://127.0.0.1:8767";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	reporter: "list",
	use: {
		baseURL: BASE_URL,
		// The page remembers whether its OpenStreetMap base map is on; start
		// with it off, so a browser with an empty cache doesn't fetch OSM's
		// tiles on every test. The example's places aren't on that map anyway.
		storageState: {
			cookies: [],
			origins: [
				{
					origin: BASE_URL,
					localStorage: [{ name: "basemap", value: "off" }],
				},
			],
		},
	},
	webServer: {
		command: `node src/server.ts 8767 ${DATASET} ${CHECKS}`,
		url: BASE_URL,
		reuseExistingServer: !process.env.CI,
		timeout: 30_000,
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
