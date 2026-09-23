import { workerData } from "node:worker_threads";
import { CGeoDataReader } from "@loc-to-city/reader";
import { move } from "piscina";
import type { ColorSpace } from "./colors.js";
import { renderTilePng } from "./tiles.js";

const datasetPath = workerData.datasetPath;

const reader = CGeoDataReader.open(datasetPath);

export default ({
	x,
	y,
	z,
	resolution,
	colorSpace,
}: {
	z: number;
	x: number;
	y: number;
	resolution: number;
	colorSpace: ColorSpace;
}): unknown => {
	return renderTilePng(reader, z, x, y, resolution, colorSpace);
};
