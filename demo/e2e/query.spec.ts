import { expect, type Page, test } from "@playwright/test";

/**
 * Drives the map to center exactly on (lat, lon) via Leaflet's own
 * setView, then clicks the container's center -- which Leaflet guarantees
 * corresponds to that same point -- rather than guessing a pixel offset.
 */
async function clickLatLng(
	page: Page,
	lat: number,
	lon: number,
): Promise<void> {
	await page.evaluate(
		([lat, lon]) => {
			const { map } = window as unknown as {
				map: { setView(center: [number, number], zoom: number): void };
			};
			map.setView([lat, lon], 13);
		},
		[lat, lon] as const,
	);
	const box = await page.locator("#map").boundingBox();
	if (!box) throw new Error("#map has no bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("clicking Den Haag's coordinate shows Den Haag, not Nootdorp", async ({
	page,
}) => {
	await page.goto("/");
	await page.waitForFunction(() => "map" in window);

	await clickLatLng(page, 52.034656, 4.388124);

	const popup = page.locator(".leaflet-popup-content");
	await expect(popup).toContainText("Den Haag");
	await expect(popup).not.toContainText("Nootdorp");
});

test("clicking Europoort's coordinate shows Europoort, not Hoek van Holland", async ({
	page,
}) => {
	await page.goto("/");
	await page.waitForFunction(() => "map" in window);

	await clickLatLng(page, 51.970738, 4.123725);

	const popup = page.locator(".leaflet-popup-content");
	await expect(popup).toContainText("Europoort");
	await expect(popup).not.toContainText("Hoek van Holland");
});

test("search results come back when the search box is focused again", async ({
	page,
}) => {
	await page.goto("/");
	const input = page.getByRole("combobox", { name: "Search places" });
	const options = page.getByRole("option");

	await input.fill("Delft");
	await expect(options.first()).toContainText("Delft");

	// Closing the list, by leaving the box, keeps the query...
	await input.blur();
	await expect(options).toHaveCount(0);
	await expect(input).toHaveValue("Delft");

	// ...and coming back to it shows its results again.
	await input.focus();
	await expect(options.first()).toContainText("Delft");

	// Picking one with the keyboard goes there and closes the list.
	await input.press("ArrowDown");
	await expect(options.first()).toHaveAttribute("aria-selected", "true");
	await input.press("Enter");
	await expect(options).toHaveCount(0);
	await expect(page.locator(".leaflet-popup-content")).toContainText("Delft");
});
