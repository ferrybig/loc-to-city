import { writeFileSync } from "node:fs";
import { buildLocateIndex } from "../locateIndex.js";
import {
	type Command,
	EXIT_OK,
	openReader,
	parse,
	UsageError,
} from "./shared.js";

export const buildLocateIndexCmd: Command = {
	name: "build-locate-index",
	summary: "build a place location index for a .bin file",
	usage: `usage: cgeodata build-locate-index <file.bin> [--output <index.bin>]

Computes a representative cell for every place in <file.bin> and writes
the result as a locate index to <index.bin> (or stdout when --output is
omitted). Written next to <file.bin> as <file>.locate-index.bin,
\`cgeodata locate\` and \`search --locate\` (and any CGeoDataReader opened
from that path) use it automatically; elsewhere, pass it with
\`locate --index\`. Turns a locate from a scan of every chunk into a
read of one entry.

  --output F  write to F instead of stdout`,
	run(argv) {
		const { values, positionals } = parse(argv, {
			output: { type: "string" },
		});
		const [file, ...extra] = positionals;
		if (extra.length > 0)
			throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);

		const reader = openReader(file);
		const { countries, regions, cities } = reader.placeCounts;
		process.stderr.write(
			`building locate index over ${countries + regions + cities} places...\n`,
		);
		const t0 = performance.now();
		let bytes: Uint8Array;
		try {
			bytes = buildLocateIndex(reader);
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
