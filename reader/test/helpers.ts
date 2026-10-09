/** `Array.fromAsync`, which this project's ES2022 lib doesn't declare. */
export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) out.push(item);
	return out;
}
