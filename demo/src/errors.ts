/**
 * How the demo answers a failed request: JSON `{ error }`, with a status
 * saying whose fault it was.
 */
import type { NextFunction, Request, Response } from "express";

/** The worker pool's queue already holds `maxQueue` tasks. */
export class QueueFullError extends Error {}

/** An error that carries its own HTTP status, like `res.download`'s (an
 * unsatisfiable range is a 416 with a `Content-Range` header). */
interface HttpError extends Error {
	status: number;
	headers?: Record<string, string>;
}

function isHttpError(err: unknown): err is HttpError {
	return (
		err instanceof Error &&
		typeof (err as Partial<HttpError>).status === "number"
	);
}

/** Express error middleware. A RangeError is the reader rejecting the
 * request's coordinate or place id; anything but that, a full queue or an
 * error with its own status is a bug, and logged. */
export function errorHandler(
	err: unknown,
	_req: Request,
	res: Response,
	_next: NextFunction,
): void {
	// The client went away; there's no one to answer.
	if (res.destroyed) return;
	// Too late for an error response: cut it short instead.
	if (res.headersSent) {
		res.destroy();
		return;
	}
	const status =
		err instanceof QueueFullError
			? 503
			: err instanceof RangeError
				? 400
				: isHttpError(err)
					? err.status
					: 500;
	if (status >= 500) console.error(err);
	if (isHttpError(err) && err.headers) res.set(err.headers);
	res.status(status).json({
		error: err instanceof Error ? err.message : String(err),
	});
}
