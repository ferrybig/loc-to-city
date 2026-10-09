#!/usr/bin/env node
import { buildLocateIndexCmd } from "./cli/buildLocateIndex.ts";
import { buildSearchIndexCmd } from "./cli/buildSearchIndex.ts";
import { chunk } from "./cli/chunk.ts";
import { info } from "./cli/info.ts";
import { list } from "./cli/list.ts";
import { locate } from "./cli/locate.ts";
import { lookup } from "./cli/lookup.ts";
import { search } from "./cli/search.ts";
import { type Command, EXIT_ERROR, UsageError } from "./cli/shared.ts";
import { show } from "./cli/show.ts";

const COMMANDS: readonly Command[] = [
	info,
	lookup,
	list,
	search,
	buildSearchIndexCmd,
	show,
	chunk,
	locate,
	buildLocateIndexCmd,
];

// Wide enough for the longest name there actually is: a fixed 8 left
// `build-search-index` and `build-locate-index` hanging ten characters
// into their own summaries.
const NAME_WIDTH = Math.max(...COMMANDS.map((c) => c.name.length));

const USAGE = `usage: cgeodata <command> <file.bin> [...]
       cgeodata help [<command>]

Reads a CGEODATA file. <file.bin> may be "-" to read the file from stdin.

commands:
${COMMANDS.map((c) => `  ${c.name.padEnd(NAME_WIDTH)}  ${c.summary}`).join("\n")}

Exit status is 0 on success, 1 when a search matched nothing, 2 on a
usage or runtime error.`;

function findCommand(name: string): Command | undefined {
	return COMMANDS.find((c) => c.name === name);
}

async function main(argv: string[]): Promise<number> {
	const [name, ...rest] = argv;
	if (
		name === undefined ||
		name === "help" ||
		name === "--help" ||
		name === "-h"
	) {
		const topic = rest[0] === undefined ? undefined : findCommand(rest[0]);
		if (rest[0] !== undefined && !topic) {
			process.stderr.write(
				`unknown command ${JSON.stringify(rest[0])}\n${USAGE}\n`,
			);
			return EXIT_ERROR;
		}
		const text = topic ? topic.usage : USAGE;
		if (name === undefined) {
			process.stderr.write(`${text}\n`);
			return EXIT_ERROR;
		}
		process.stdout.write(`${text}\n`);
		return 0;
	}
	const command = findCommand(name);
	if (!command) {
		process.stderr.write(`unknown command ${JSON.stringify(name)}\n${USAGE}\n`);
		return EXIT_ERROR;
	}
	try {
		return await command.run(rest);
	} catch (err) {
		if (err instanceof UsageError) {
			process.stderr.write(`${err.message}\n${command.usage}\n`);
			return EXIT_ERROR;
		}
		throw err;
	}
}

// `cgeodata list world.bin | head` closes our stdout early; that's the
// reader's business, not an error worth a stack trace.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") process.exit(0);
	// Throwing from an 'error' listener raises an uncaughtException, so a
	// plain write failure (`cgeodata list world.bin > /dev/full`, ENOSPC)
	// would print a stack trace -- the very thing this handler exists to
	// avoid. Report it the way main()'s own failure path does.
	process.stderr.write(`${err.message}\n`);
	process.exit(EXIT_ERROR);
});

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(err: unknown) => {
		process.stderr.write(
			`${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exitCode = EXIT_ERROR;
	},
);
