/**
 * Deterministic place -> color mapping for the tile overlay, ported from
 * the Python prototype's webapp/colors.py. A place's color key is hashed to
 * an integer, which becomes a hue (0-360); lightness/chroma are fixed so
 * only the hue varies. The same place always renders the same color across
 * tiles, zoom levels, and requests (MD5, not a per-process random seed).
 */
import { createHash } from "node:crypto";

export type ColorSpace = "hsl" | "oklch";

export function colorKeyHue(colorKey: string): number {
  const digest = createHash("md5").update(colorKey, "utf8").digest();
  const value = digest.readUInt32BE(0);
  return value % 360;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** hsl(hue 70.2% 46.52%) -> [r, g, b] in 0..255. */
export function hslToRgb(hue: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = 0.702;
  const l = 0.4652;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  let r: number, g: number, b: number;
  if (h < 1 / 6) [r, g, b] = [c, x, 0];
  else if (h < 2 / 6) [r, g, b] = [x, c, 0];
  else if (h < 3 / 6) [r, g, b] = [0, c, x];
  else if (h < 4 / 6) [r, g, b] = [0, x, c];
  else if (h < 5 / 6) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// OKLCH -> sRGB, following Bjorn Ottosson's reference formulas
// (https://bottosson.github.io/posts/oklab/). Fixed L=0.7463, C=0.1213;
// hue is the only variable.
function oklabToLinearSrgb(L: number, a: number, b: number): [number, number, number] {
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
  const v = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return clamp01(v);
}

/** oklch(0.7463 0.1213 hue) -> [r, g, b] in 0..255. */
export function oklchToRgb(hue: number, chroma: number = 0.1213): [number, number, number] {
  const L = 0.7463;
  const C = chroma;
  const hRad = (hue * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  const [lr, lg, lb] = oklabToLinearSrgb(L, a, b);
  return [
    Math.round(linearToSrgb(lr) * 255),
    Math.round(linearToSrgb(lg) * 255),
    Math.round(linearToSrgb(lb) * 255),
  ];
}

export function colorKeyToRgb(colorKey: string, colorSpace: ColorSpace = "oklch"): [number, number, number] {
  const hue = colorKeyHue(colorKey);
  const chroma = colorKey[0] === '2' ? 0.1213 : colorKey[1] === '1' ? 0.07 : 0.04;
  return colorSpace === "hsl" ? hslToRgb(hue) : oklchToRgb(hue, chroma);
}
