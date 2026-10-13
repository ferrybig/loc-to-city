/** The element with `id`, which the page is expected to have. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw new Error(`#${id} is missing from the page`);
	return el as T;
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** A per-browser setting from localStorage, or null where there is none
 * or storage is off limits. */
export function readSetting(name: string): string | null {
	try {
		return localStorage.getItem(name);
	} catch (_) {
		return null;
	}
}

export function writeSetting(name: string, value: string): void {
	try {
		localStorage.setItem(name, value);
	} catch (_) {}
}
