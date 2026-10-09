import type { CGeoDataReader, Place, PlaceLevel } from "../reader.ts";
import {
	type Command,
	formatPlaceLine,
	names,
	openReader,
	parse,
	parseLevel,
	resolveCountry,
	writeLine,
} from "./shared.ts";

const DEPTH: Record<PlaceLevel, number> = { country: 0, region: 1, city: 2 };

async function printTree(
	reader: CGeoDataReader,
	place: Place,
	deepest: PlaceLevel,
	json: boolean,
): Promise<void> {
	const depth = DEPTH[place.level];
	writeLine(
		json
			? JSON.stringify(place)
			: `${"  ".repeat(depth)}${place.id}\t${names(place.names)}`,
	);
	if (depth >= DEPTH[deepest]) return;
	const children =
		place.level === "country"
			? reader.places({ level: "region", country: place.id })
			: reader.places({ level: "city", region: place.id });
	for await (const child of children)
		await printTree(reader, child, deepest, json);
}

export const list: Command = {
	name: "list",
	summary: "list places: countries by default, or a level, scoped to a country",
	usage: `usage: cgeodata list <file.bin> [--level country|region|city] [--country <id|name>] [--tree] [--json]

Lists places one per line as tab-separated columns: id, level, names,
region, country. Alternative names within a column are joined by " | ";
a column that doesn't apply is "-".

  --level L    which level to list (default: country)
  --country C  only places inside this country, given as an id or as one
               of its names (case-insensitive, must be unambiguous)
  --tree       print the hierarchy indented instead of flat, down to
               --level (default with --tree: city); lines are "id<TAB>names"
  --json       one JSON object per place instead of the text form`,
	async run(argv) {
		const { values, positionals } = parse(argv, {
			level: { type: "string" },
			country: { type: "string" },
			tree: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
		});
		const level =
			parseLevel(values.level) ?? (values.tree ? "city" : "country");

		const reader = await openReader(positionals[0]);
		try {
			const country =
				values.country === undefined
					? undefined
					: await resolveCountry(reader, values.country);
			if (values.tree) {
				const roots =
					country === undefined
						? reader.places({ level: "country" })
						: [await reader.place(country)];
				for await (const root of roots)
					await printTree(reader, root, level, values.json);
				return 0;
			}
			const filter = country === undefined ? { level } : { level, country };
			for await (const place of reader.places(filter)) {
				writeLine(values.json ? JSON.stringify(place) : formatPlaceLine(place));
			}
			return 0;
		} finally {
			await reader.close();
		}
	},
};
