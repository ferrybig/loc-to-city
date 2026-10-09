import {
	parse,
	openReader,
	parseId,
	formatPlaceBlock,
	writeLine,
	UsageError,
	type Command,
} from "./shared.ts";

export const show: Command = {
	name: "show",
	summary: "resolve place ids to names and parents",
	usage: `usage: cgeodata show <file.bin> <id> [<id> ...] [--json]

Resolves each place id (as printed by list, search, lookup or chunk) to
its level, names and ancestors.

  --json   one JSON object per id instead of the readable form`,
	run(argv) {
		const { values, positionals } = parse(argv, {
			json: { type: "boolean", default: false },
		});
		const [file, ...idArgs] = positionals;
		if (idArgs.length === 0) throw new UsageError("missing <id>");
		const ids = idArgs.map((arg) => parseId(arg, "id"));

		const reader = openReader(file);
		try {
			for (const id of ids) {
				const place = reader.place(id);
				if (values.json) {
					writeLine(JSON.stringify(place));
					continue;
				}
				writeLine(`${place.id}\t${place.level}`);
				for (const line of formatPlaceBlock(place)) writeLine(line);
			}
			return 0;
		} finally {
			reader.close();
		}
	},
};
