import { parse, openReader, parseLevel, resolveCountry, formatPlaceLine, writeLine, UsageError, EXIT_OK, EXIT_NO_MATCH, type Command } from "./shared.js";

export const search: Command = {
  name: "search",
  summary: "find places whose name contains a text",
  usage: `usage: cgeodata search <file.bin> <text> [--level country|region|city] [--country <id|name>] [--limit N] [--json]

Prints every place (country, region or city) with a name containing
<text>, case-insensitively, in the same tab-separated form as \`list\`.
This is a plain scan over every name in the file -- the baseline any
search index gets measured against.

Exits 0 when something matched, 1 when nothing did, 2 on an error --
grep's convention.

  --level L    only places of this level
  --country C  only places inside this country (id or unambiguous name)
  --limit N    stop after N matches
  --json       one JSON object per match instead of the text form`,
  run(argv) {
    const { values, positionals } = parse(argv, {
      level: { type: "string" },
      country: { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
    });
    const [file, text, ...extra] = positionals;
    if (text === undefined) throw new UsageError("missing <text> to search for");
    if (extra.length > 0) throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
    const level = parseLevel(values.level);
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) {
      throw new UsageError(`--limit must be a non-negative integer, not ${JSON.stringify(values.limit)}`);
    }

    const reader = openReader(file);
    try {
      const country = values.country === undefined ? undefined : resolveCountry(reader, values.country);
      let matched = 0;
      for (const place of reader.search(text, {
        ...(level !== undefined ? { level } : {}),
        ...(country !== undefined ? { country } : {}),
        ...(limit !== undefined ? { limit } : {}),
      })) {
        matched++;
        writeLine(values.json ? JSON.stringify(place) : formatPlaceLine(place));
      }
      return matched > 0 ? EXIT_OK : EXIT_NO_MATCH;
    } finally {
      reader.close();
    }
  },
};
