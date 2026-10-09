/**
 * A least-recently-used cache bounded by the byte size of what it holds,
 * not by entry count: decoded chunks range from a few hundred bytes to
 * several megabytes (5.4 MB for the largest on a worldwide build), so
 * only a byte budget answers "how much memory does the reader need".
 *
 * A `Map` iterates in insertion order, so re-inserting an entry on every
 * hit keeps the least recently used one first, where eviction takes it.
 */
export class ByteBudgetCache<V> {
	private readonly entries = new Map<number, { value: V; bytes: number }>();
	private totalBytes = 0;
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		if (!(maxBytes >= 0)) {
			throw new RangeError(
				`cache size must be a non-negative number of bytes, not ${maxBytes}`,
			);
		}
		this.maxBytes = maxBytes;
	}

	/** Bytes currently held. */
	get size(): number {
		return this.totalBytes;
	}

	get(key: number): V | undefined {
		const entry = this.entries.get(key);
		if (entry === undefined) return undefined;
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}

	/** Caches `value` as `bytes` bytes, evicting least recently used entries
	 * to stay within budget. A value bigger than the whole budget isn't
	 * cached at all, rather than emptying the cache for it. */
	set(key: number, value: V, bytes: number): void {
		this.delete(key);
		if (bytes > this.maxBytes) return;
		this.entries.set(key, { value, bytes });
		this.totalBytes += bytes;
		for (const [oldest, { bytes: oldBytes }] of this.entries) {
			if (this.totalBytes <= this.maxBytes) break;
			this.entries.delete(oldest);
			this.totalBytes -= oldBytes;
		}
	}

	delete(key: number): void {
		const entry = this.entries.get(key);
		if (entry === undefined) return;
		this.entries.delete(key);
		this.totalBytes -= entry.bytes;
	}

	clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
	}
}
