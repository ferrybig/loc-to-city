import { parse, openReader, writeLine, type Command } from "./shared.ts";

export const info: Command = {
	name: "info",
	summary: "describe a file: header, place counts, chunk statistics",
	usage: `usage: cgeodata info <file.bin> [--top N] [--json]

Prints the header fields, how many countries/regions/cities the place
table holds, how the bytes split between place table and chunks, and the
N (default 10) largest chunks by compressed size -- as indices that paste
straight into the compressor's --only-chunks.

  --top N  how many of the largest chunks to list (0 for none)
  --json   one JSON object instead of the readable form`,
	run(argv) {
		const { values, positionals } = parse(argv, {
			top: { type: "string", default: "10" },
			json: { type: "boolean", default: false },
		});
		const top = Number(values.top);
		if (!Number.isInteger(top) || top < 0)
			throw new Error(
				`--top must be a non-negative integer, not ${JSON.stringify(values.top)}`,
			);

		const reader = openReader(positionals[0]);
		try {
			const { header, directory } = reader;
			const chunkLengths = directory.chunkLengths;
			const nonEmpty = chunkLengths.filter((len) => len > 0).length;
			const chunkBytes = chunkLengths.reduce((a, b) => a + b, 0);
			const fileSize =
				header.headerLength +
				directory.directoryLength +
				directory.placeTableLength +
				chunkBytes;
			const largest = chunkLengths
				.map((bytes, index) => ({ index, bytes }))
				.filter((c) => c.bytes > 0)
				.sort((a, b) => b.bytes - a.bytes || a.index - b.index)
				.slice(0, top);

			const report = {
				version: header.version,
				attribution: header.attribution,
				grid: {
					width: header.width,
					height: header.height,
					widthExp: header.widthExp,
					heightExp: header.heightExp,
				},
				maxDepth: header.maxDepth,
				keyframeExp: header.keyframeExp,
				places: reader.placeCounts,
				bytes: {
					total: fileSize,
					header: header.headerLength,
					directory: directory.directoryLength,
					placeTable: directory.placeTableLength,
					chunks: chunkBytes,
				},
				chunks: { total: chunkLengths.length, nonEmpty, largest },
			};
			if (values.json) {
				writeLine(JSON.stringify(report));
				return 0;
			}

			const { places, bytes, grid } = report;
			const pct = (n: number) => `${((100 * n) / bytes.total).toFixed(1)}%`;
			const lines = [
				`version      ${report.version}`,
				`attribution  ${report.attribution}`,
				`grid         ${grid.width}x${grid.height} chunks (width_exp ${grid.widthExp}, height_exp ${grid.heightExp})`,
				`max depth    ${report.maxDepth}  (${grid.width * 2 ** report.maxDepth}x${grid.height * 2 ** report.maxDepth} finest cells worldwide)`,
				`keyframe     ${report.keyframeExp}  (${2 ** report.keyframeExp} names per block)`,
				`places       ${places.countries} countries, ${places.regions} regions, ${places.cities} cities`,
				`bytes        ${bytes.total} total: header ${bytes.header}, directory ${bytes.directory}, place table ${bytes.placeTable} (${pct(bytes.placeTable)}), chunks ${bytes.chunks} (${pct(bytes.chunks)})`,
				`chunks       ${nonEmpty} of ${chunkLengths.length} non-empty`,
			];
			if (largest.length > 0) {
				lines.push(
					`largest      ${largest.map((c) => `${c.index} (${c.bytes})`).join(", ")}`,
				);
				lines.push(
					`             --only-chunks ${largest.map((c) => c.index).join(",")}`,
				);
			}
			for (const line of lines) writeLine(line);
			return 0;
		} finally {
			reader.close();
		}
	},
};
