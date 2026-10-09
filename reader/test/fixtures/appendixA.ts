/**
 * The exact 157-byte worked example from binary-format.md Appendix A,
 * transcribed byte-for-byte from the spec's hex listings (Sections A.1-A.4).
 * This is NOT produced by the compressor -- the point of this fixture is to
 * check the reader against the spec text itself, independently of whether
 * the compressor happens to agree with it.
 */

function hexBytes(hex: string): number[] {
	return hex
		.split(/\s+/)
		.filter((s) => s.length > 0)
		.map((s) => parseInt(s, 16));
}

// A.1. Header (17 bytes)
const HEADER = hexBytes(`
  43 47 45 4f 44 41 54 41
  00
  03  4f 53 4d
  01
  01
  02
  02
`);

// A.2. Directory (5 bytes)
const DIRECTORY = hexBytes(`
  6d
  00 00 00 1a
`);

// A.3. Place table (109 bytes): 6-byte uncompressed prefix + block 0 (67
// bytes) + block 1 (36 bytes).
const PLACE_TABLE_PREFIX = hexBytes(`
  02
  01 01
  02 01
  43
`);

const NAME_BLOCK_0 = hexBytes(`
  78 da f3 4b 4d 49 2d ca 49 cc 4b a9 09 c9 48 55 f0 4b 2d c9 80 70 8b 19
  9c 52 73 d2 33 0f af ae 01 d3 a5 b9 0c 7e f9 f9 45 29 ba 1e f9 39 20 69
  06 c7 bc 92 f2 d4 a2 82 d4 bc 1a 28 8b 01 00 2e 70 1c 57
`);

const NAME_BLOCK_1 = hexBytes(`
  78 da 73 cc 2d 2e 49 2d 4a 49 cc 65 88 4a 4c cc 03 d1 8e 79 25 e5 a9 45
  05 a9 79 35 50 16 03 00 f7 a7 0d 6c
`);

// A.4. Chunk 3 (26 bytes compressed)
const CHUNK_3 = hexBytes(`
  78 da 63 62 62 66 65 65 60 61 64 66 61 64 62 62 04 42 06 46 26 00 02 22
  00 2c
`);

export const APPENDIX_A_BYTES: Uint8Array = Uint8Array.from([
	...HEADER,
	...DIRECTORY,
	...PLACE_TABLE_PREFIX,
	...NAME_BLOCK_0,
	...NAME_BLOCK_1,
	...CHUNK_3,
]);
