import {
	type Command,
	coordPrecision,
	EXIT_NO_MATCH,
	EXIT_OK,
	formatPlaceLine,
	openReader,
	parse,
	parseLevel,
	resolveCountry,
	UsageError,
	writeLine,
} from "./shared.ts";

export const search: Command = {
	name: "search",
	summary: "find places whose name contains a text",
	usage: `usage: cgeodata search <file.bin> <text> [--level country|region|city] [--country <id|name>] [--limit N] [--sort] [--locate] [--index <index.bin> | --no-index] [--json]

Prints every place (country, region or city) with a name containing
<text>, case-insensitively, in the same tab-separated form as \`list\`.

Exits 0 when something matched, 1 when nothing did, 2 on an error --
grep's convention.

  --level L      only places of this level
  --country C    only places inside this country (id or unambiguous name)
  --limit N      stop after N matches
  --sort         rank matches by relevance instead of id order: an exact
                 name match beats a match on a whole word of the name,
                 which beats a plain substring match; ties go to a city
                 over a region over a country. Without --sort, --limit
                 stops the scan as soon as it has enough matches; with
                 --sort, the whole file has to be scored first, since the
                 best match isn't necessarily the first one found.
  --locate       append a lat,lon coordinate to each result, as
                 \`locate\` prints it (one read per match with a locate
                 index next to <file>, a scan of every chunk per match
                 without one -- then use --limit to keep it fast)
  --index F      use this bitmap search index (built with
                 build-search-index) to skip most of the city table,
                 instead of <file>'s default <file>.search-index.bin
                 (used automatically when it exists). Queries too short
                 to contain a bigram still scan every city.
  --no-index     scan every city even if a search index exists -- the
                 baseline an index is measured against
  --json         one JSON object per match instead of the text form`,
	run(argv) {
		const { values, positionals } = parse(argv, {
			level: { type: "string" },
			country: { type: "string" },
			limit: { type: "string" },
			sort: { type: "boolean", default: false },
			locate: { type: "boolean", default: false },
			index: { type: "string" },
			"no-index": { type: "boolean", default: false },
			json: { type: "boolean", default: false },
		});
		const [file, text, ...extra] = positionals;
		if (text === undefined)
			throw new UsageError("missing <text> to search for");
		if (extra.length > 0)
			throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
		if (values.index !== undefined && values["no-index"])
			throw new UsageError("--index and --no-index can't be combined");
		const level = parseLevel(values.level);
		const limit = values.limit === undefined ? undefined : Number(values.limit);
		if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) {
			throw new UsageError(
				`--limit must be a non-negative integer, not ${JSON.stringify(values.limit)}`,
			);
		}

		const reader = openReader(file);
		try {
			const country =
				values.country === undefined
					? undefined
					: resolveCountry(reader, values.country);
			const searchOptions = {
				...(level !== undefined ? { level } : {}),
				...(country !== undefined ? { country } : {}),
				...(limit !== undefined ? { limit } : {}),
				sort: values.sort,
			};

			if (values["no-index"]) reader.useSearchIndex(undefined);
			if (values.index !== undefined) {
				try {
					reader.useSearchIndex(values.index);
				} catch (error) {
					throw new Error(`--index ${values.index}: ${(error as Error).message}`);
				}
			}

			let matched = 0;
			for (const place of reader.search(text, searchOptions)) {
				matched++;
				if (values.json) {
					if (values.locate) {
						const pos = reader.locate(place.id);
						writeLine(JSON.stringify(pos ? { ...place, lat: pos.lat, lon: pos.lon } : place));
					} else {
						writeLine(JSON.stringify(place));
					}
				} else if (values.locate) {
					const pos = reader.locate(place.id);
					if (pos) {
						const p = coordPrecision(pos.boundingBox);
						writeLine(`${formatPlaceLine(place)}\t${pos.lat.toFixed(p)},${pos.lon.toFixed(p)}`);
					} else {
						writeLine(`${formatPlaceLine(place)}\t-`);
					}
				} else {
					writeLine(formatPlaceLine(place));
				}
			}
			return matched > 0 ? EXIT_OK : EXIT_NO_MATCH;
		} finally {
			reader.close();
		}
	},
};
