/**
 * The controls panel (layers and dataset). Beside the map where there's
 * room for both, always open; elsewhere a sheet over the map, opened from
 * the button in the search box -- style.css decides which, and the button
 * is only shown in the second case. Also the "i" buttons, each of which
 * shows or hides the explanation it `aria-controls`.
 */
import { byId } from "./dom.ts";

const panel = byId("controls");
const toggle = byId<HTMLButtonElement>("controls-toggle");

/** Whether the panel is a sheet over the map, which opens and closes. */
function isSheet(): boolean {
	return getComputedStyle(toggle).display !== "none";
}

function setOpen(open: boolean): void {
	panel.classList.toggle("open", open);
	toggle.setAttribute("aria-expanded", String(open));
}

/** Closes the panel where it covers the map; returns whether it did. */
export function closeControls(): boolean {
	if (!isSheet() || !panel.classList.contains("open")) return false;
	setOpen(false);
	return true;
}

toggle.addEventListener("click", () => {
	setOpen(!panel.classList.contains("open"));
});

document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && closeControls()) toggle.focus();
});

for (const button of document.querySelectorAll<HTMLButtonElement>(
	"button.info",
)) {
	const hint = byId(button.getAttribute("aria-controls") ?? "");
	button.addEventListener("click", () => {
		hint.hidden = !hint.hidden;
		button.setAttribute("aria-expanded", String(!hint.hidden));
	});
}
