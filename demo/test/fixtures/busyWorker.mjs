/** Echoes `label`, first blocking its thread until the test opens `gate`
 * (a shared Int32Array's first element set non-zero), when given one: so
 * tasks submitted meanwhile wait in the pool's queue for as long as the
 * test needs, not for a guessed amount of time. */
export default function busy({ label, gate }) {
	if (gate) Atomics.wait(new Int32Array(gate), 0, 0);
	return label;
}
