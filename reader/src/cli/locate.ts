import type { BoundingBox } from "../cellBounds.js";
import {
	type Command,
	openReader,
	parse,
	parseId,
	UsageError,
	writeLine,
} from "./shared.js";

/** Decimal places that meaningfully represent a coordinate given a cell size. */
function coordPrecision(box: BoundingBox): number {
	const cellSize = Math.min(box.maxLat - box.minLat, box.maxLon - box.minLon);
	return Math.max(0, Math.round(-Math.log10(cellSize) + 1));
}

export const locate: Command = {
	name: "locate",
	summary: "find a representative lat/lon for a place id",
	usage: `usage: cgeodata locate <file.bin> <id> [<id> ...]

Scans all chunks to find the largest area assigned to each place id and
prints the centre of that area as lat, lon.  Each chunk's palette is
checked first so only chunks that actually reference the id are
decompressed.`,
	run(argv) {
		const { positionals } = parse(argv, {});
		const [file, ...idArgs] = positionals;
		if (idArgs.length === 0) throw new UsageError("missing <id>");
		const ids = idArgs.map((arg) => parseId(arg, "id"));

		const reader = openReader(file);
		try {
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
