import { readFileSync } from "node:fs";
import { loadSearchIndex, searchWithIndex } from "../searchIndex.js";
import {
	type Command,
	EXIT_NO_MATCH,
	EXIT_OK,
	formatPlaceLine,
	openReader,
	parse,
	parseLevel,
	resolveCountry,
	UsageError,
	writeLine,
} from "./shared.js";

export const search: Command = {
	name: "search",
	summary: "find places whose name contains a text",
	usage: `usage: cgeodata search <file.bin> <text> [--level country|region|city] [--country <id|name>] [--limit N] [--sort] [--locate] [--index <index.bin>] [--json]

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
  --locate       append a lat,lon coordinate to each result (sequential
                 chunk scan per match -- use --limit to keep it fast)
  --index F      use a pre-built bitmap search index (built with
                 build-search-index) to skip most of the city table;
                 falls back to a linear scan for queries shorter than 2
                 characters.
  --json         one JSON object per match instead of the text form`,
	run(argv) {
		const { values, positionals } = parse(argv, {
			level: { type: "string" },
			country: { type: "string" },
			limit: { type: "string" },
			sort: { type: "boolean", default: false },
			locate: { type: "boolean", default: false },
			index: { type: "string" },
			json: { type: "boolean", default: false },
		});
		const [file, text, ...extra] = positionals;
		if (text === undefined)
			throw new UsageError("missing <text> to search for");
		if (extra.length > 0)
			throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
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

			const results =
				values.index !== undefined
					? (() => {
							const index = loadSearchIndex(readFileSync(values.index));
							if (index.sourceChecksum !== reader.placeTableChecksum()) {
								throw new Error(
									`--index ${values.index} was built from a different .bin file (checksum mismatch); rebuild with build-search-index`,
								);
							}
							return searchWithIndex(reader, index, text, searchOptions);
						})()
					: reader.search(text, searchOptions);

			let matched = 0;
			for (const place of results) {
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
						const cellSize = Math.min(
							pos.boundingBox.maxLat - pos.boundingBox.minLat,
							pos.boundingBox.maxLon - pos.boundingBox.minLon,
						);
						const p = Math.max(0, Math.round(-Math.log10(cellSize) + 1));
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
