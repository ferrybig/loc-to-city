import { expect, test } from "@playwright/test";

// The server is started with the Dutch spot-checks (playwright.config.ts).

test("the spot-check markers are drawn, with a legend and a popup", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.locator("#checks-panel")).toBeVisible();
	await page.waitForFunction(() => "map" in window);
	await page.evaluate(() => {
		const { map } = window as unknown as {
			map: { setView(center: [number, number], zoom: number): void };
		};
		map.setView([52.3, 5], 8);
	});

	const pins = page.locator(".check-pin");
	await expect(pins.first()).toBeVisible();
	await expect(page.locator("#check-legend li").first()).toBeVisible();

	await pins.first().click();
	const popup = page.locator(".check-popup");
	await expect(popup).toContainText("Expected");
	await expect(popup).toContainText("Country notes: Netherlands");

	// The popup's button runs the ordinary lookup at the marker.
	await popup.getByRole("button", { name: "Query this point" }).click();
	await expect(page.locator(".result-table").last()).toContainText("Country");
});

test("the markers can be switched off; a group the dataset has none of is not offered", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.locator("#checks-panel")).toBeVisible();
	await page.evaluate(() => {
		const { map } = window as unknown as {
			map: { setView(center: [number, number], zoom: number): void };
		};
		map.setView([52.3, 5], 8);
	});
	await expect(page.locator(".check-pin").first()).toBeVisible();
	// The Dutch checks include no capitals.
	await expect(page.locator("#checks-capital-toggle")).toBeHidden();

	await page.locator("#checks-spot-toggle").uncheck();
	await expect(page.locator(".check-pin")).toHaveCount(0);
	await expect(page.locator("#check-legend li")).toHaveCount(0);

	await page.locator("#checks-spot-toggle").check();
	await expect(page.locator(".check-pin").first()).toBeVisible();
});
