import { writeFileSync } from "node:fs";
import {
	buildSearchIndex,
	DEFAULT_SEARCH_INDEX_OPTIONS,
	type SearchIndexOptions,
} from "../searchIndex.ts";
import {
	type Command,
	EXIT_OK,
	openReader,
	parse,
	UsageError,
} from "./shared.ts";

const { hashExp, topCount, topBlockExp } = DEFAULT_SEARCH_INDEX_OPTIONS;

export const buildSearchIndexCmd: Command = {
	name: "build-search-index",
	summary: "build a trigram search index for a .bin file",
	usage: `usage: cgeodata build-search-index <file.bin> [--output <index.bin>] [--hash-exp N] [--top-count N] [--top-block-exp N]

Builds a trigram search index (binary-format.md Appendix B) over every
place in <file.bin> and writes it to <index.bin> (or stdout when
--output is omitted). Written next to <file.bin> as
<file>.search-index.bin, \`cgeodata search\` (and any CGeoDataReader
opened from that path) uses it automatically; elsewhere, pass it with
\`search --index\`. Queries of 3+ characters then only compare the
places whose names contain all of their trigrams, and sorted searches of
1-2 characters with --limit up to the top count are answered from a
precomputed table.

  --output F          write to F instead of stdout
  --hash-exp N        2^N shared lists for non-Latin trigrams (default ${hashExp})
  --top-count N       places per 1-2 character query; 0 leaves the
                      table out (default ${topCount})
  --top-block-exp N   2^N table entries per block (default ${topBlockExp})`,
	run(argv) {
		const { values, positionals } = parse(argv, {
			output: { type: "string" },
			"hash-exp": { type: "string" },
			"top-count": { type: "string" },
			"top-block-exp": { type: "string" },
		});
		const [file, ...extra] = positionals;
		if (extra.length > 0)
			throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
		const options: SearchIndexOptions = {};
		for (const [flag, key] of [
			["hash-exp", "hashExp"],
			["top-count", "topCount"],
			["top-block-exp", "topBlockExp"],
		] as const) {
			const text = values[flag];
			if (text === undefined) continue;
			const value = Number(text);
			if (!(Number.isInteger(value) && value >= 0)) {
				throw new UsageError(
					`--${flag} must be a non-negative integer, not ${JSON.stringify(text)}`,
				);
			}
			options[key] = value;
		}

		const reader = openReader(file);
		const { countries, regions, cities } = reader.placeCounts;
		process.stderr.write(
			`building search index over ${countries + regions + cities} places...\n`,
		);
		const t0 = performance.now();
		let bytes: Uint8Array;
		try {
			bytes = buildSearchIndex(reader, options);
		} catch (error) {
			throw error instanceof RangeError ? new UsageError(error.message) : error;
		} finally {
			reader.close();
		}
		process.stderr.write(
			`done in ${((performance.now() - t0) / 1000).toFixed(1)} s, ${(bytes.length / 1024 / 1024).toFixed(1)} MiB\n`,
		);

		if (values.output !== undefined) {
			writeFileSync(values.output, bytes);
		} else {
			process.stdout.write(bytes);
		}
		return EXIT_OK;
	},
};
