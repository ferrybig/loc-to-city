import {
	type Command,
	coordPrecision,
	openReader,
	parse,
	parseId,
	UsageError,
	writeLine,
} from "./shared.ts";

export const locate: Command = {
	name: "locate",
	summary: "find a representative lat/lon for a place id",
	usage: `usage: cgeodata locate <file.bin> <id> [<id> ...] [--index <index.bin> | --no-index]

Prints a representative lat, lon for each place id: the centre of a cell
near the middle of the place's area (its own cells plus those of every
place under it), and always inside that area, so looking the point up
gives the place back. Printed with as many decimals as that cell's size
warrants.

With a locate index (build-locate-index) this reads one entry per id;
without one it scans every chunk, which takes seconds on a worldwide
file. Same result either way.

  --index F   use this locate index instead of <file>'s default
              <file>.locate-index.bin (used automatically when it exists)
  --no-index  scan the chunks even if a locate index exists -- the
              baseline an index is measured against`,
	run(argv) {
		const { values, positionals } = parse(argv, {
			index: { type: "string" },
			"no-index": { type: "boolean", default: false },
		});
		const [file, ...idArgs] = positionals;
		if (idArgs.length === 0) throw new UsageError("missing <id>");
		if (values.index !== undefined && values["no-index"])
			throw new UsageError("--index and --no-index can't be combined");
		const ids = idArgs.map((arg) => parseId(arg, "id"));

		const reader = openReader(file);
		try {
			if (values["no-index"]) reader.useLocateIndex(undefined);
			if (values.index !== undefined) {
				try {
					reader.useLocateIndex(values.index);
				} catch (error) {
					throw new Error(`--index ${values.index}: ${(error as Error).message}`);
				}
			}
			let anyMissing = false;
			for (const id of ids) {
				const pos = reader.locate(id);
				if (!pos) {
					process.stderr.write(`${id}: no geometry found\n`);
					anyMissing = true;
					continue;
				}
				const p = coordPrecision(pos.boundingBox);
				writeLine(`${pos.lat.toFixed(p)}, ${pos.lon.toFixed(p)}`);
			}
			return anyMissing ? 1 : 0;
		} finally {
			reader.close();
		}
	},
};
