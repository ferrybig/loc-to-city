/** An image the bundle copies next to it (buildWeb.ts's `file` loader):
 * imports as its URL. */
declare module "*.png" {
	const url: string;
	export default url;
}
