/** The demo page: a click-to-query map of the dataset, with search, a
 * grid overlay of what each point resolves to and the controls for it. */
import "leaflet/dist/leaflet.css";
import "./style.css";
import "./layers.ts";
import { closeControls } from "./controls.ts";
import { initDataset } from "./dataset.ts";
import { map } from "./map.ts";
import { queryAndPopup } from "./query.ts";
import { closeResults } from "./search.ts";

map.on("click", (e) => {
	// A tap beside the controls sheet only closes it.
	if (closeControls()) return;
	closeResults();
	queryAndPopup(e.latlng.lat, e.latlng.lng);
});

initDataset();
