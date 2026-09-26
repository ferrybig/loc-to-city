import { FixedQueue, queueOptionsSymbol, type TaskQueue } from "piscina";

type Task = Parameters<TaskQueue["push"]>[0];

/** What a task carries under `queueOptionsSymbol` to pick its lane. */
export interface LaneOptions {
	background: boolean;
}

/**
 * A piscina task queue (`taskQueue` option) with two FIFO lanes: a task
 * whose queue options say `background` only runs once no other task is
 * waiting, so a click's query isn't stuck behind a screenful of tiles.
 *
 * Piscina only uses a custom queue for tasks run without a `signal`: an
 * abortable task that can't start right away goes to an internal FIFO
 * instead, skipping both this queue and `maxQueue`.
 */
export class LaneTaskQueue implements TaskQueue {
	readonly #foreground = new FixedQueue();
	readonly #background = new FixedQueue();

	get size(): number {
		return this.#foreground.size + this.#background.size;
	}

	push(task: Task): void {
		this.#lane(task).push(task);
	}

	/** Used with the pool's `stricterFIFO`: puts back a task piscina took
	 * out but found no free worker for. Without that, piscina pushes it
	 * back onto the end instead, reordering tasks within a lane. */
	unshift(task: Task): void {
		this.#lane(task).unshift(task);
	}

	shift(): Task | null {
		return this.#foreground.shift() ?? this.#background.shift();
	}

	remove(task: Task): void {
		this.#lane(task).remove(task);
	}

	#lane(task: Task): FixedQueue {
		const options = task[queueOptionsSymbol] as Partial<LaneOptions> | null;
		return options?.background ? this.#background : this.#foreground;
	}
}
