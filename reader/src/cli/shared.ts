import { parseArgs, type ParseArgsConfig } from "node:util";
import { readFileSync } from "node:fs";
import { CGeoDataReader, type Place, type PlaceLevel } from "../reader.js";

/** grep's convention: 0 = success/matched, 1 = ran fine but found nothing
 * (search only), 2 = usage or runtime error. */
export const EXIT_OK = 0;
export const EXIT_NO_MATCH = 1;
export const EXIT_ERROR = 2;

/** A usage problem: reported with the command's usage text, exit 2. */
export class UsageError extends Error {}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  run(argv: string[]): Promise<number> | number;
}

type Options = NonNullable<ParseArgsConfig["options"]>;

/**
 * parseArgs with every option unknown to the command rejected, and
 * negative numbers ("-10,10", a perfectly good latitude) allowed as
 * positionals -- parseArgs would otherwise read that as short options
 * `-1 -0 ...`. Such tokens are hidden behind a NUL prefix for the parse
 * and restored afterwards; nothing else can legitimately start with NUL.
 */
export function parse<O extends Options>(argv: string[], options: O) {
  const shielded = argv.map((arg) => (/^-\d/.test(arg) ? `\0${arg}` : arg));
  try {
    const { values, positionals } = parseArgs({ args: shielded, options, allowPositionals: true, strict: true });
    return { values, positionals: positionals.map((p) => (p.startsWith("\0") ? p.slice(1) : p)) };
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message.replace(/\. To specify.*$/s, "") : String(err));
  }
}

/** "-" reads the whole file from stdin; the reader needs random access,
 * so that means buffering it, which is fine at the sizes these files come
 * in (the worldwide build is under 10MB). */
export function openReader(file: string | undefined): CGeoDataReader {
  if (file === undefined) throw new UsageError("missing <file.bin>");
  return CGeoDataReader.open(file === "-" ? readFileSync(0) : file);
}

export function parseLevel(text: string | undefined): PlaceLevel | undefined {
  if (text === undefined) return undefined;
  if (text === "country" || text === "region" || text === "city") return text;
  throw new UsageError(`--level must be country, region or city, not ${JSON.stringify(text)}`);
}

export function parseId(text: string, what: string): number {
  const id = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(id)) throw new UsageError(`${what} ${JSON.stringify(text)} is not a place id`);
  return id;
}

/** `--country` takes an id or a name; a name must match exactly one
 * country, case-insensitively, on any of its names. */
export function resolveCountry(reader: CGeoDataReader, text: string): number {
  if (/^\d+$/.test(text)) return parseId(text, "--country");
  const wanted = text.toLowerCase();
  const matches = [...reader.places({ level: "country" })].filter((c) => c.names.some((n) => n.toLowerCase() === wanted));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) throw new UsageError(`no country is named ${JSON.stringify(text)}`);
  throw new UsageError(`${JSON.stringify(text)} names ${matches.length} countries: ${matches.map((m) => `${m.id} (${m.names.join(" | ")})`).join(", ")}`);
}

export function names(list: string[] | null | undefined): string {
  return list ? list.join(" | ") : "-";
}

/** One place per line: id, level, its own names, region, country -- `-`
 * where a level doesn't apply. Fixed columns so `cut`/`awk` work
 * regardless of level. */
export function formatPlaceLine(place: Place): string {
  const region = place.level === "city" ? place.region?.names : null;
  const country = place.level === "country" ? null : place.country.names;
  return [place.id, place.level, names(place.names), names(region), names(country)].join("\t");
}

/** The block form used by `show` and `lookup`. */
export function formatPlaceBlock(place: Place): string[] {
  return [
    `  country  ${names(place.country.names)}  [${place.country.id}]`,
    `  region   ${place.region ? `${names(place.region.names)}  [${place.region.id}]` : "-"}`,
    `  city     ${place.city ? `${names(place.city.names)}  [${place.city.id}]` : "-"}`,
  ];
}

export function writeLine(line: string): void {
  process.stdout.write(line + "\n");
}
