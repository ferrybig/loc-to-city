/**
 * Decoding a chunk is CPU work on the calling thread, a few milliseconds
 * for a large one. Reads run concurrently, but if every read that's done
 * went straight on to decode, many lookups started at once would decode
 * back to back -- Node.js delivers all finished reads in one go -- and
 * hold the event loop for the whole batch (330 ms for 300 lookups across
 * Europe, measured). `TurnQueue` runs decodes one at a time instead, each
 * in a macrotask of its own, so other work gets a turn between any two.
 */
export class TurnQueue {
	private tail: Promise<unknown> = Promise.resolve();

	/** Runs `work` after everything queued before it, in a fresh
	 * macrotask. */
	run<T>(work: () => T | Promise<T>): Promise<T> {
		const result = this.tail.then(yieldToEventLoop).then(work);
		this.tail = result.catch(() => {});
		return result;
	}
}

type Schedule = (callback: () => void) => unknown;

/** Resolves in a new macrotask: Node's `setImmediate` (after pending I/O,
 * before timers come round again), else a `MessageChannel` message (not
 * clamped like a nested `setTimeout(0)` in browsers), else `setTimeout`. */
export const yieldToEventLoop: () => Promise<void> = (() => {
	const setImmediate = (globalThis as { setImmediate?: Schedule }).setImmediate;
	if (setImmediate) return () => new Promise<void>((r) => setImmediate(r));
	if (typeof MessageChannel !== "undefined") {
		const channel = new MessageChannel();
		const waiting: Array<() => void> = [];
		// A browser's MessagePort; Node's typings (which never reach here)
		// lack `onmessage`.
		(channel.port1 as unknown as { onmessage: () => void }).onmessage = () =>
			waiting.shift()?.();
		return () =>
			new Promise<void>((resolve) => {
				waiting.push(resolve);
				channel.port2.postMessage(null);
			});
	}
	return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
})();
