import { test, expect, type Page } from "@playwright/test";

/**
 * Drives the map to center exactly on (lat, lon) via Leaflet's own
 * setView, then clicks the container's center -- which Leaflet guarantees
 * corresponds to that same point -- rather than guessing a pixel offset.
 */
async function clickLatLng(page: Page, lat: number, lon: number): Promise<void> {
  await page.evaluate(
    ([lat, lon]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).map.setView([lat, lon], 13);
    },
    [lat, lon] as const,
  );
  const box = await page.locator("#map").boundingBox();
  if (!box) throw new Error("#map has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("clicking Den Haag's coordinate shows Den Haag, not Nootdorp", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => "map" in window);

  await clickLatLng(page, 52.034656, 4.388124);

  const popup = page.locator(".leaflet-popup-content");
  await expect(popup).toContainText("Den Haag");
  await expect(popup).not.toContainText("Nootdorp");
});

test("clicking Europoort's coordinate shows Europoort, not Hoek van Holland", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => "map" in window);

  await clickLatLng(page, 51.970738, 4.123725);

  const popup = page.locator(".leaflet-popup-content");
  await expect(popup).toContainText("Europoort");
  await expect(popup).not.toContainText("Hoek van Holland");
});
