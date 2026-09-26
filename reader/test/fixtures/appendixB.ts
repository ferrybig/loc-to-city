/**
 * The search index of binary-format.md Appendix B.12: the Appendix A file
 * indexed with hash_exp 4, top_count 2, top_block_exp 4 (3207 bytes).
 * Transcribed from the spec, section by section; the 2746-byte presence
 * bitmap is given as its non-zero bytes (B.12.2's "Bit" column).
 */
function hex(text: string): number[] {
	return text.trim().split(/\s+/).map((b) => Number.parseInt(b, 16));
}

export const APPENDIX_B_OPTIONS = { hashExp: 4, topCount: 2, topBlockExp: 4 } as const;

const HEADER = hex("43 47 45 4f 44 41 54 41 11 9f e6 00 b9 37 18 dc 77 07 04 02 04 e9 15 2f 10");

const PRESENCE_LENGTH = 2746;
/** [byte, value] for every non-zero presence byte. */
const PRESENCE: [number, number][] = [
	[1, 0x20], [44, 0x04], [45, 0x80], [47, 0x80], [113, 0x08], [295, 0x10], [310, 0x02], [385, 0x80],
	[403, 0x01], [431, 0x04], [451, 0x80], [452, 0x80], [453, 0x08], [459, 0x08], [484, 0x20], [616, 0x10],
	[618, 0x10], [702, 0x02], [703, 0x04], [736, 0x08], [855, 0x10], [1079, 0x20], [1100, 0x01], [1116, 0x10],
	[1241, 0x08], [1284, 0x10], [1286, 0x40], [1288, 0x08], [1290, 0x08], [1324, 0x40], [1343, 0x04], [1411, 0x80],
	[1423, 0x02], [1431, 0x80], [1485, 0x20], [1676, 0x10], [1679, 0x40], [1704, 0x10], [1719, 0x01], [1831, 0x01],
	[1878, 0x02], [1887, 0x01], [1939, 0x10], [2172, 0x02], [2450, 0x01], [2574, 0x04], [2594, 0x01],
];

const ENTRIES = hex("02 02 03 03 02 03 02 02 02 02 02 02 03 02 02 02 02 02 02 02 02 03 02 02 02 02 02 02 02 02 03 02 02 02 03 02 02 02 03 02 02 02 03 03 02 02 02");
const LISTS = hex("05 04 25 48 01 30 00 02 00 01 04 00 48 00 00 01 01 00 00 02 01 05 01 02 04 05 00 00 00 02 48 02 02 02 48 04 02 00 48 04 04 00 48 48 05 02 00");
const TABLE_DIRECTORY = hex("40 20 00 50 65 20 00 52 6c 67 00 52 72 64 00 52");
const TABLE_BLOCKS = hex(`
20 00 01 00 20 6e 00 01 00 2d 00 01 02 2d 68 00 01 02 61 00 02 04 05 61
61 00 01 05 61 6d 00 02 04 05 61 6e 00 02 05 06 62 00 01 01 62 65 00 01
01 64 00 02 04 05 64 2d 00 01 02 64 61 00 02 04 05 64 65 00 01 00 64 73
00 01 00 65 00 02 04 06 65 20 00 01 00 65 64 00 01 00 65 6c 00 01 01 65
6e 00 02 06 03 65 72 00 02 04 06 65 74 00 01 00 67 00 01 01 67 69 00 01
01 68 00 02 02 00 68 65 00 01 00 68 6f 00 01 02 69 00 01 01 69 75 00 01
01 69 c3 ab 00 01 01 6c 00 02 02 00 6c 61 00 02 02 00 6c 67 00 01 01 6c
6c 00 01 02 6d 00 02 04 05 6d 73 00 01 04 6e 00 02 05 06 6e 64 00 02 05
02 6e 65 00 01 00 6e 6f 00 01 02 6e 74 00 02 06 03 6f 00 01 02 6f 6c 00
01 02 6f 6f 00 01 02 6f 72 00 01 02 70 00 02 06 03 70 65 00 02 06 03 72
00 02 04 06 72 64 00 02 04 02 72 6c 00 01 00 72 70 00 02 06 03 73 00 02
04 00 73 74 00 01 04 74 00 02 04 06 74 65 00 01 04 74 68 00 01 00 74 77
00 02 06 03 75 00 01 01 75 6d 00 01 01 77 00 02 06 03 77 65 00 02 06 03
7a 00 01 05 7a 61 00 01 05 c3 ab 00 01 01
`);

function assemble(): Uint8Array {
	const presence = new Array<number>(PRESENCE_LENGTH).fill(0);
	for (const [byte, value] of PRESENCE) presence[byte] = value;
	return Uint8Array.from([...HEADER, ...presence, ...ENTRIES, ...LISTS, ...TABLE_DIRECTORY, ...TABLE_BLOCKS]);
}

export const APPENDIX_B_BYTES = assemble();
