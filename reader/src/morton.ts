/**
 * Morton (Z-order) code helpers, per binary-format.md Section 8.1.
 *
 * Codes can be up to 2 x max_depth bits wide, i.e. up to 52 bits (max_depth
 * <= 26, Section 5). JavaScript's `<<`, `>>`, `&`, `|` operators truncate to
 * 32-bit signed integers, which silently corrupts anything wider -- so every
 * operation on a *code* here uses multiplication/division instead of native
 * bitwise ops. Native bitwise ops are only used on `x`/`y` individually,
 * which are always at most 26 bits and so fit safely in 32 bits.
 */

/** Right-shift by `bits`, safe for values up to 2^53. */
export function shiftRight(value: number, bits: number): number {
	return Math.floor(value / 2 ** bits);
}

/** The low `bits` bits of `value`, safe for values up to 2^53. */
export function lowBits(value: number, bits: number): number {
	const modulus = 2 ** bits;
	return value - Math.floor(value / modulus) * modulus;
}

/**
 * Full-precision Morton code of cell (x, y) at the given depth: interleave
 * the bits of y and x, most significant first, with the y bit placed above
 * the x bit in every pair.
 */
export function mortonEncode(x: number, y: number, depth: number): number {
	let code = 0;
	for (let i = depth - 1; i >= 0; i--) {
		const yBit = (y >>> i) & 1;
		const xBit = (x >>> i) & 1;
		code = code * 2 + yBit;
		code = code * 2 + xBit;
	}
	return code;
}

/** Inverse of mortonEncode. Not needed by the read-only lookup path (which
 * only ever encodes a query point), but used by the compressor and tests. */
export function mortonDecode(
	code: number,
	depth: number,
): {
	/** Column, 0 to 2^depth - 1, west to east. */
	x: number;
	/** Row, 0 to 2^depth - 1, south to north. */
	y: number;
} {
	let x = 0;
	let y = 0;
	let remaining = code;
	for (let i = 0; i < depth; i++) {
		const xBit = lowBits(remaining, 1);
		remaining = shiftRight(remaining, 1);
		const yBit = lowBits(remaining, 1);
		remaining = shiftRight(remaining, 1);
		x |= xBit << i;
		y |= yBit << i;
	}
	return { x, y };
}
