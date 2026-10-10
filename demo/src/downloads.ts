/**
 * The files the demo offers for download: the dataset it serves and the
 * sidecar indexes its workers use. Unlike staticAssets.ts's files these
 * are streamed from disk on every request (a worldwide dataset is tens of
 * MB), by `res.download`, which answers byte ranges so a broken download
 * can resume where it stopped. After the build step (prepareStatic.ts,
 * run on the dataset's directory) each gets its content hash as ETag.
 */
import path from "node:path";
import { Router } from "express";
import { readEtags } from "./etags.ts";

export interface Download {
	/** The file's name, in its URL and as saved: the dataset and its
	 * sidecars keep the names `openFile()` pairs them by. */
	name: string;
	/** What the file is, for the page's list. */
	description: string;
	path: string;
}

export function download(filePath: string, description: string): Download {
	return { name: path.basename(filePath), description, path: filePath };
}

/** The URL path a download is served at. */
export function downloadUrl(download: Download): string {
	return `/download/${encodeURIComponent(download.name)}`;
}

/** Serves each of `downloads` at its `downloadUrl`. */
export function downloadRouter(downloads: Download[]): Router {
	const byName = new Map(
		downloads.map((d) => [
			d.name,
			{ ...d, etag: readEtags(path.dirname(d.path)).get(d.name) },
		]),
	);
	const router = Router();
	router.get("/download/:name", (req, res, next) => {
		const file = byName.get(req.params.name);
		if (!file) {
			next();
			return;
		}
		// The directory as `root`: given a whole path, `res.download`
		// refuses any with a dot-directory in it (a dataset under ~/.cache,
		// say).
		res.download(file.name, file.name, {
			root: path.dirname(file.path),
			// A rebuilt image's files are all newer, so with the content
			// hash a Last-Modified would only cost 304s and resumes.
			...(file.etag && { headers: { ETag: file.etag }, lastModified: false }),
		});
	});
	return router;
}
