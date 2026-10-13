#!/usr/bin/env node
/**
 * Bundles the page (web/) with esbuild: web/main.ts, Leaflet and the
 * stylesheets become one `main-<hash>.js` and one `main-<hash>.css` in
 * dist/assets/ (with Leaflet's images, also hashed), and web/index.html
 * goes to dist/public/ pointing at them. The hashed files never change
 * under their names, so they're served as immutable (staticAssets.ts) and
 * a page load revalidates only index.html.
 *
 *   node src/buildWeb.ts
 *
 * The dev server (src/server.ts run as TypeScript) calls watchWeb()
 * instead, which rebuilds on every edit to web/.
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { ASSETS_DIR, PUBLIC_DIR } from "./staticAssets.ts";

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const TEMPLATE = path.join(WEB_DIR, "index.html");
const ENTRY = path.join(WEB_DIR, "main.ts");

/** Removes every file in `dir` but `keep`: what an earlier build left,
 * and prepareStatic.ts's .br files and ETags, which would otherwise be
 * served for the old contents. */
function prune(dir: string, keep: string[]): void {
	for (const file of readdirSync(dir)) {
		if (!keep.includes(file)) rmSync(path.join(dir, file), { recursive: true });
	}
}

/** Writes index.html with the template's `main.ts` / `main.css`
 * references swapped for the bundle's files, then prunes both
 * directories. */
function writePage(metafile: esbuild.Metafile): void {
	const js = Object.entries(metafile.outputs).find(
		([, out]) => out.entryPoint && path.resolve(out.entryPoint) === ENTRY,
	);
	if (!js?.[1].cssBundle) throw new Error("the bundle has no main js and css");
	const url = (file: string) => `/assets/${path.relative(ASSETS_DIR, file)}`;
	let html = readFileSync(TEMPLATE, "utf8");
	for (const [from, to] of [
		['href="main.css"', `href="${url(js[1].cssBundle)}"`],
		['src="main.ts"', `src="${url(js[0])}"`],
	] as const) {
		if (!html.includes(from)) throw new Error(`index.html has no ${from}`);
		html = html.replace(from, to);
	}
	mkdirSync(PUBLIC_DIR, { recursive: true });
	writeFileSync(path.join(PUBLIC_DIR, "index.html"), html);
	prune(PUBLIC_DIR, ["index.html"]);
	prune(
		ASSETS_DIR,
		Object.keys(metafile.outputs).map((file) =>
			path.relative(ASSETS_DIR, file),
		),
	);
}

const options: esbuild.BuildOptions = {
	entryPoints: [ENTRY],
	bundle: true,
	format: "esm",
	target: "es2023",
	minify: true,
	sourcemap: "linked",
	outdir: ASSETS_DIR,
	entryNames: "[name]-[hash]",
	assetNames: "[name]-[hash]",
	publicPath: "/assets/",
	loader: { ".png": "file" },
	metafile: true,
	logLevel: "warning",
	plugins: [
		{
			name: "page",
			setup(build) {
				// The template isn't part of the bundle, so watch mode only
				// sees an edit to it by way of the entry point.
				build.onLoad({ filter: /[\\/]web[\\/]main\.ts$/ }, (args) => ({
					contents: readFileSync(args.path, "utf8"),
					loader: "ts",
					watchFiles: [TEMPLATE],
				}));
				build.onEnd((result) => {
					if (result.metafile) writePage(result.metafile);
				});
			},
		},
	],
};

export async function buildWeb(): Promise<void> {
	await esbuild.build(options);
}

/** Builds the page, then rebuilds it whenever a file it's made of changes. */
export async function watchWeb(): Promise<void> {
	const context = await esbuild.context(options);
	await context.rebuild();
	await context.watch();
}

if (import.meta.main) await buildWeb();
