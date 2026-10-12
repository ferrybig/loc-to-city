import { expect, type Locator, type Page, test } from "@playwright/test";

// The dataset is reader/binary-format.md's Appendix A example (see
// playwright.config.ts). Of its seven places, only Noord-Holland (id 2),
// Zaandam (id 5) and their country Nederland have cells; Amsterdam,
// België and Antwerpen are names only. Section A.5 works out the
// lookups used here.

interface TestMap {
	setView(
		center: [number, number],
		zoom: number,
		options?: { animate: boolean },
	): void;
}

/** Moves the map without animating, so it is already there on return. */
async function setView(
	page: Page,
	lat: number,
	lon: number,
	zoom: number,
): Promise<void> {
	await page.waitForFunction(() => "map" in window);
	await page.evaluate(
		([lat, lon, zoom]) => {
			const { map } = window as unknown as { map: TestMap };
			map.setView([lat, lon], zoom, { animate: false });
		},
		[lat, lon, zoom] as const,
	);
}

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
	await setView(page, lat, lon, 6);
	const box = await page.locator("#map").boundingBox();
	if (!box) throw new Error("#map has no bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** The newest popup: a closing one can linger while it fades out. */
function popup(page: Page): Locator {
	return page.locator(".leaflet-popup-content").last();
}

/** One level's row of the lookup popup's table. */
function row(page: Page, level: "Country" | "Region" | "City"): Locator {
	return popup(page).getByRole("row", { name: level });
}

test("clicking a city shows it, its region, country and place id", async ({
	page,
}) => {
	await page.goto("/");
	await clickLatLng(page, 20, 100);

	await expect(row(page, "City")).toContainText("Zaandam");
	await expect(row(page, "Region")).toContainText("Noord-Holland");
	await expect(row(page, "Country")).toContainText("Nederland");
	await expect(popup(page)).toContainText("Place id: 5");
});

test("a point only a region covers shows no city", async ({ page }) => {
	await page.goto("/");
	await clickLatLng(page, 40, 30);

	await expect(row(page, "Region")).toContainText("Noord-Holland");
	await expect(row(page, "City")).toContainText("unknown");
	await expect(popup(page)).toContainText("Place id: 2");
});

test("a point in a gap resolves to nothing", async ({ page }) => {
	await page.goto("/");
	await clickLatLng(page, 30, 100);

	await expect(row(page, "Country")).toContainText("unknown");
	await expect(popup(page)).toContainText("Place id: none");
});

/** The map's zoom and centre, rounded to the hash's own precision. */
function mapView(page: Page): Promise<[number, number, number]> {
	return page.evaluate(() => {
		const { map } = window as unknown as {
			map: { getZoom(): number; getCenter(): { lat: number; lng: number } };
		};
		const { lat, lng } = map.getCenter();
		return [
			map.getZoom(),
			Math.round(lat * 100) / 100,
			Math.round(lng * 100) / 100,
		];
	});
}

test("a shared URL opens the map at the view in its hash", async ({ page }) => {
	await page.goto("/#map=6/20.000/100.000");
	await page.waitForFunction(() => "map" in window);
	expect(await mapView(page)).toEqual([6, 20, 100]);

	const box = await page.locator("#map").boundingBox();
	if (!box) throw new Error("#map has no bounding box");
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await expect(row(page, "City")).toContainText("Zaandam");
});

test("moving the map updates the hash without adding history entries", async ({
	page,
}) => {
	await page.goto("/");
	const entries = await page.evaluate(() => history.length);

	await setView(page, 20, 100, 4);
	await expect
		.poll(() => page.evaluate(() => location.hash))
		.toBe("#map=4/20.00/100.00");
	await setView(page, 40, 30, 5);
	await expect
		.poll(() => page.evaluate(() => location.hash))
		.toBe("#map=5/40.000/30.000");
	expect(await page.evaluate(() => history.length)).toBe(entries);
});

test("the hash is written once the map stops moving, not on every move", async ({
	page,
}) => {
	await page.addInitScript(() => {
		const counted = window as unknown as { replaceStates: number };
		counted.replaceStates = 0;
		const replaceState = history.replaceState.bind(history);
		history.replaceState = (...args) => {
			counted.replaceStates++;
			replaceState(...args);
		};
	});
	await page.goto("/");
	for (let zoom = 3; zoom <= 8; zoom++) await setView(page, 20, 100, zoom);

	await expect
		.poll(() => page.evaluate(() => location.hash))
		.toBe("#map=8/20.000/100.000");
	expect(
		await page.evaluate(
			() => (window as unknown as { replaceStates: number }).replaceStates,
		),
	).toBe(1);
});

test("editing the hash moves the map", async ({ page }) => {
	await page.goto("/");
	await page.waitForFunction(() => "map" in window);
	await page.evaluate(() => {
		location.hash = "#map=5/40.000/30.000";
	});
	await expect.poll(() => mapView(page)).toEqual([5, 40, 30]);
});

test("search results come back when the search box is focused again", async ({
	page,
}) => {
	await page.goto("/");
	const input = page.getByRole("combobox", { name: "Search places" });
	const options = page.getByRole("option");

	await input.fill("Zaandam");
	await expect(options.first()).toContainText("Zaandam");

	// Closing the list, by leaving the box, keeps the query...
	await input.blur();
	await expect(options).toHaveCount(0);
	await expect(input).toHaveValue("Zaandam");

	// ...and coming back to it shows its results again.
	await input.focus();
	await expect(options.first()).toContainText("Zaandam");

	// Picking one with the keyboard goes there and closes the list.
	await input.press("ArrowDown");
	await expect(options.first()).toHaveAttribute("aria-selected", "true");
	await input.press("Enter");
	await expect(options).toHaveCount(0);
	await expect(row(page, "City")).toContainText("Zaandam");
});

test("Enter pressed before the results come in goes to the first one", async ({
	page,
}) => {
	await page.goto("/");
	const input = page.getByRole("combobox", { name: "Search places" });

	await input.fill("Zaandam");
	await input.press("Enter");

	await expect(row(page, "City")).toContainText("Zaandam");
	await expect(page.getByRole("option")).toHaveCount(0);
});

test("Enter after a search that found nothing goes nowhere", async ({
	page,
}) => {
	await page.goto("/");
	const input = page.getByRole("combobox", { name: "Search places" });
	const status = page.locator("#search-status");

	await input.fill("Zaandam");
	await expect(page.getByRole("option").first()).toContainText("Zaandam");

	// Zaandam's results are still on screen until the new query's come in.
	await input.fill("wwwww");
	await expect(status).toHaveText("Searching…");
	await input.press("Enter");

	await expect(status).toHaveText("No places found");
	await expect(status).toBeVisible();
	await expect(page.getByRole("option")).toHaveCount(0);
	await expect(page.locator(".leaflet-popup-content")).toHaveCount(0);
});

test("a place found by name but without cells says so", async ({ page }) => {
	await page.goto("/");
	const input = page.getByRole("combobox", { name: "Search places" });

	await input.fill("Amsterdam");
	await expect(page.getByRole("option").first()).toContainText("Amsterdam");
	await input.press("Enter");

	await expect(page.locator("#search-status")).toHaveText(
		"Amsterdam has no location in this dataset",
	);
	await expect(page.locator(".leaflet-popup-content")).toHaveCount(0);
});

test("a lat, lon in the search box goes to that point", async ({ page }) => {
	await page.goto("/");
	const input = page.getByRole("combobox", { name: "Search places" });

	await input.fill("20, 100");
	await expect(page.getByRole("option")).toHaveCount(1);
	await expect(page.getByRole("option")).toContainText("Coordinates");
	await input.press("Enter");

	await expect(popup(page)).toContainText("20.000000, 100.000000");
	await expect(row(page, "City")).toContainText("Zaandam");
});

test("the chunk grid labels chunks with their compressed size", async ({
	page,
}) => {
	await page.goto("/");
	const toggle = page.getByRole("checkbox", { name: "Show chunk grid" });
	await expect(toggle).toBeEnabled();
	await expect(toggle).not.toBeChecked();

	await setView(page, 45, 90, 2);
	await toggle.check();
	// Section A.2: chunk 3 is the only one with data, 26 bytes of it.
	const labels = page.locator(".chunk-label");
	await expect(labels).toHaveCount(1);
	await expect(labels).toContainText("26 B");
	await expect(labels).toContainText("#3");

	await toggle.uncheck();
	await expect(labels).toHaveCount(0);
});

test("a chunk grid checked before the grid is known is labelled once it is", async ({
	page,
}) => {
	// A browser that keeps the box checked across a reload runs its handler
	// at load, before /api/about has said what the grid is. Headless
	// Chromium doesn't restore form state, so hold /api/about back and check
	// the box in that window instead.
	let releaseAbout = () => {};
	const aboutHeld = new Promise<void>((resolve) => {
		releaseAbout = resolve;
	});
	await page.route("**/api/about", async (route) => {
		await aboutHeld;
		await route.continue();
	});
	await page.goto("/");
	const sizes = page.waitForResponse("**/api/chunk-sizes");
	await page.locator("#chunk-grid-toggle").evaluate((el: HTMLInputElement) => {
		el.checked = true;
		el.dispatchEvent(new Event("change"));
	});
	await sizes;

	// The page's default view is inside chunk 3; nothing moves the map.
	releaseAbout();
	await expect(page.locator(".chunk-label")).toHaveCount(1);
});

test("the base map is off in tests, and fetches OSM's tiles once on", async ({
	page,
}) => {
	const osmTiles: string[] = [];
	// Never reach OSM from a test, even with the base map switched on.
	await page.route("https://tile.openstreetmap.org/**", (route) => {
		osmTiles.push(route.request().url());
		return route.abort();
	});
	await page.goto("/");
	const toggle = page.getByRole("checkbox", {
		name: "Show OpenStreetMap base map",
	});
	await expect(toggle).not.toBeChecked();
	const attribution = page.locator(".leaflet-control-attribution");
	await expect(attribution).toBeVisible();
	await expect(attribution).not.toContainText("Map data");

	await toggle.check();
	await expect.poll(() => osmTiles.length).toBeGreaterThan(0);
	await expect(attribution).toContainText("Map data");

	// The choice is remembered.
	await page.reload();
	await expect(toggle).toBeChecked();
});

/** The tile layers that have tiles, bottom to top as drawn: "osm" for
 * the base map, "grid" for the city grid overlay. */
function tileLayerStack(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>(".leaflet-tile-pane > *")]
			.map((el, order) => ({
				z: Number(getComputedStyle(el).zIndex) || 0,
				order,
				name: el.querySelector('img[src*="openstreetmap"]')
					? "osm"
					: el.querySelector('img[src*="/tiles/"]')
						? "grid"
						: null,
			}))
			.filter((layer) => layer.name)
			.sort((a, b) => a.z - b.z || a.order - b.order)
			.map((layer) => layer.name as string),
	);
}

test("the base map stays under the grid overlay, whichever is switched on last", async ({
	page,
}) => {
	await page.route("https://tile.openstreetmap.org/**", (route) =>
		route.abort(),
	);
	await page.goto("/");
	const baseMap = page.getByRole("checkbox", {
		name: "Show OpenStreetMap base map",
	});
	const grid = page.getByRole("checkbox", { name: "Show grid overlay" });

	// Tests start with the base map off, so this adds it after the grid.
	await baseMap.check();
	await expect.poll(() => tileLayerStack(page)).toEqual(["osm", "grid"]);

	await grid.uncheck();
	await grid.check();
	await expect.poll(() => tileLayerStack(page)).toEqual(["osm", "grid"]);
});

test("the dataset can be downloaded from the page", async ({ page }) => {
	await page.goto("/");
	await page.locator("#downloads summary").click();
	const link = page.getByRole("link", { name: "appendix-a-example.bin" });
	await expect(link).toBeVisible();
	const resp = await page.request.get((await link.getAttribute("href"))!);
	expect(resp.status()).toBe(200);
	expect(resp.headers()["content-disposition"]).toContain(
		"appendix-a-example.bin",
	);
	expect((await resp.body()).subarray(0, 4).toString("latin1")).toBe("CGEO");
});
