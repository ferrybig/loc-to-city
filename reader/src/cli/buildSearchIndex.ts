import { readFileSync, writeFileSync } from "node:fs";
import { buildSearchIndex } from "../searchIndex.js";
import {
	type Command,
	EXIT_OK,
	openReader,
	parse,
	UsageError,
} from "./shared.js";

export const buildSearchIndexCmd: Command = {
	name: "build-search-index",
	summary: "build a bitmap search index for a .bin file",
	usage: `usage: cgeodata build-search-index <file.bin> [--output <index.bin>]

Builds a bigram bitmap search index over the cities in <file.bin> and
writes it to <index.bin> (or stdout when --output is omitted). Pass the
result to \`cgeodata search\` via \`--index\` to speed up city searches by
50-200x for queries of 3+ characters.

  --output F  write to F instead of stdout`,
	run(argv) {
		const { values, positionals } = parse(argv, {
			output: { type: "string" },
		});
		const [file, ...extra] = positionals;
		if (extra.length > 0)
			throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);

		const reader = openReader(file);
		const { cities } = reader.placeCounts;
		process.stderr.write(`building search index over ${cities} cities...\n`);
		const t0 = performance.now();
		let bytes: Uint8Array;
		try {
			bytes = buildSearchIndex(reader);
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
