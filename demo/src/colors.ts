/**
 * Deterministic place -> color mapping for the tile overlay, ported from
 * the deleted Python prototype's tile overlay (see history.md). A place's global id is hashed to a hue (0-360); lightness is
 * fixed and chroma depends only on the level, so a city stands out more
 * than a region-only or country-only area. The same place always renders
 * the same color across tiles, zoom levels, and requests of one dataset;
 * a rebuilt dataset numbers places differently and so reshuffles colors.
 */
import type { PlaceLevel } from "@ferrybig/cgeodata-reader";

/** Chroma per level: cities saturated, regions and countries muted. */
const CHROMA: Record<PlaceLevel, number> = {
	city: 0.1213,
	region: 0.07,
	country: 0.04,
};

/** The hue (0-359) for the place with global id `id`: murmur3's 32-bit
 * finalizer, so consecutive ids (neighboring cities of one region) still
 * get unrelated hues. Only a handful of hues are told apart by eye anyway,
 * and borders mark where places meet, so a cheap hash is plenty. */
export function placeHue(id: number): number {
	let h = id >>> 0;
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return ((h ^ (h >>> 16)) >>> 0) % 360;
}

function clamp01(x: number): number {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

// OKLCH -> sRGB, following Bjorn Ottosson's reference formulas
// (https://bottosson.github.io/posts/oklab/). Fixed L=0.7463; hue and
// chroma are the only variables.
function oklabToLinearSrgb(
	L: number,
	a: number,
	b: number,
): [number, number, number] {
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;

	const l = l_ ** 3;
	const m = m_ ** 3;
	const s = s_ ** 3;

	const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
	return [r, g, bl];
}

function linearToSrgb(c: number): number {
	const clamped = clamp01(c);
	const v =
		clamped <= 0.0031308
			? 12.92 * clamped
			: 1.055 * clamped ** (1 / 2.4) - 0.055;
	return clamp01(v);
}

/** oklch(0.7463 chroma hue) -> [r, g, b] in 0..255. */
export function oklchToRgb(
	hue: number,
	chroma = CHROMA.city,
): [number, number, number] {
	const L = 0.7463;
	const hRad = (hue * Math.PI) / 180;
	const a = chroma * Math.cos(hRad);
	const b = chroma * Math.sin(hRad);
	const [lr, lg, lb] = oklabToLinearSrgb(L, a, b);
	return [
		Math.round(linearToSrgb(lr) * 255),
		Math.round(linearToSrgb(lg) * 255),
		Math.round(linearToSrgb(lb) * 255),
	];
}

/** The overlay color for the place at `level` with global id `id`. */
export function placeColor(
	level: PlaceLevel,
	id: number,
): [number, number, number] {
	return oklchToRgb(placeHue(id), CHROMA[level]);
}
