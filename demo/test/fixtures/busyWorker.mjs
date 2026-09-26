/** Blocks its thread for `ms`, then echoes `label`: long enough that
 * tasks submitted meanwhile have to wait in the pool's queue. */
export default function busy({ ms, label }) {
	const end = Date.now() + ms;
	while (Date.now() < end);
	return label;
}
