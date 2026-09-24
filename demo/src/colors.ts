/**
 * Deterministic place -> color mapping for the tile overlay, ported from
 * the Python prototype's webapp/colors.py. A place's color key is hashed to
 * an integer, which becomes a hue (0-360); lightness/chroma are fixed so
 * only the hue varies. The same place always renders the same color across
 * tiles, zoom levels, and requests (MD5, not a per-process random seed).
 */
import { createHash } from "node:crypto";

export function colorKeyHue(colorKey: string): number {
  const digest = createHash("md5").update(colorKey, "utf8").digest();
  const value = digest.readUInt32BE(0);
  return value % 360;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
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

export function colorKeyToRgb(colorKey: string): [number, number, number] {
  const hue = colorKeyHue(colorKey);
  const chroma = colorKey[0] === '2' ? 0.1213 : colorKey[0] === '1' ? 0.07 : 0.04;
  return oklchToRgb(hue, chroma);
}
