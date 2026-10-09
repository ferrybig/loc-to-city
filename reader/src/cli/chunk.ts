import {
	type Command,
	names,
	openReader,
	parse,
	parseId,
	UsageError,
	writeLine,
} from "./shared.ts";

export const chunk: Command = {
	name: "chunk",
	summary: "dump one chunk's records with their cells and places",
	usage: `usage: cgeodata chunk <file.bin> <index> [--json]

Dumps the records of chunk <index> (the number \`lookup\` prints): first
a header with the chunk's extent, compressed size, palette size and
record count, then one record per line as tab-separated columns: code,
depth, cell (lat min..max, lon min..max), place id, level, names,
region, country. A record that resolves to no place has "-" columns.
An empty chunk prints just the header.

  --json   the header as one JSON object, then one object per record`,
	run(argv) {
		const { values, positionals } = parse(argv, {
			json: { type: "boolean", default: false },
		});
		const [file, indexArg, ...extra] = positionals;
		if (indexArg === undefined) throw new UsageError("missing <index>");
		if (extra.length > 0)
			throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
		const index = parseId(indexArg, "index");

		const reader = openReader(file);
		try {
			const records = reader.chunk(index); // also range-checks the index
			const box = reader.chunkBoundingBox(index);
			const { width } = reader.header;
			const header = {
				index,
				col: index % width,
				row: Math.floor(index / width),
				boundingBox: box,
				compressedBytes: reader.directory.chunkLengths[index]!,
				paletteSize: records?.palette.length ?? 0,
				recordCount: records?.codes.length ?? 0,
			};
			if (values.json) {
				writeLine(JSON.stringify(header));
				for (const record of reader.chunkRecords(index))
					writeLine(JSON.stringify(record));
				return 0;
			}
			writeLine(
				`chunk ${index}  (col ${header.col}, row ${header.row})  lat ${box.minLat}..${box.maxLat}  lon ${box.minLon}..${box.maxLon}  ` +
					`${header.compressedBytes} bytes, ${header.paletteSize} palette entries, ${header.recordCount} records`,
			);
			for (const {
				code,
				depth,
				boundingBox: cell,
				place,
			} of reader.chunkRecords(index)) {
				const where = `lat ${cell.minLat}..${cell.maxLat}, lon ${cell.minLon}..${cell.maxLon}`;
				const who = place
					? [
							place.id,
							place.level,
							names(place.names),
							names(place.level === "city" ? place.region?.names : null),
							names(place.level === "country" ? null : place.country.names),
						]
					: ["-", "-", "-", "-", "-"];
				writeLine([code, depth, where, ...who].join("\t"));
			}
			return 0;
		} finally {
			reader.close();
		}
	},
};
