# @ferrybig/cgeodata-reader

Turns a latitude/longitude into the country, region and city it lies in,
using real administrative boundaries from OpenStreetMap rather than "the
nearest labelled point", which goes wrong near borders. Lookups run
in-process against a single CGEODATA file (a worldwide one is about
45 MiB), reading and decoding only the small part of the file each lookup
needs.

- No runtime dependencies. Works in Node.js (24 or newer) and in browsers.
  Chunks decode with WebAssembly SIMD where the platform allows it, and
  in plain JavaScript (about 1.5x as slow, twice for a file of the
  format's previous version, 0) where it doesn't, such as a page whose
  Content Security Policy lacks `'wasm-unsafe-eval'`.
- Async throughout: reads never block, and the event loop is never held
  for more than one chunk's decode.
- Includes place search (diacritic-insensitive, all alternative names)
  and a representative coordinate for every place.

The file format is specified in [binary-format.md](binary-format.md),
which ships with this package.

## Quick start (Node.js)

```ts
import { openFile } from "@ferrybig/cgeodata-reader/node";

const reader = await openFile("world.bin");

const result = await reader.query(35.6762, 139.6503);
result.country?.internationalName; // "Japan"
result.region?.localName;          // "東京都"
result.region?.internationalName;  // "Tokyo"
result.city?.localName;            // "杉並区"
result.city?.internationalName;    // "Suginami"

await reader.close();
```

`query()` returns `null` for a level that doesn't apply: `city` for a point
that only resolves to a region, all three in the open ocean. Its
`boundingBox` is the area the answer holds for. Any point inside it gives
the same result.

## In a browser

```ts
import { CGeoDataReader } from "@ferrybig/cgeodata-reader";

// The whole file in memory...
const bytes = await (await fetch("/data/world.bin")).arrayBuffer();
const reader = await CGeoDataReader.open(bytes);

// ...or a File the user picked, read range by range as lookups need it.
const fromDisk = await CGeoDataReader.open(fileInput.files[0]);
```

`CGeoDataReader.open()` accepts an `ArrayBuffer`, a `Uint8Array`, a `Blob`
or `File`, or any `ByteSource` (an object with a `size` and an async
`read(offset, length)`). With a `ByteSource` you can serve ranges from
anywhere, for example HTTP range requests. Compressed blocks are inflated
with the platform's `DecompressionStream`.

## Many lookups close together

Each lookup decodes the chunk of the file its point lies in, then keeps
it cached. Points close together mostly share a chunk, so most lookups
can answer from memory. `lookupCached()` does exactly that, synchronously,
and returns `undefined` when answering would need a read:

```ts
for (const [lat, lon] of points) {
	const { placeId, boundingBox } =
		reader.lookupCached(lat, lon) ?? (await reader.lookup(lat, lon));
	if (placeId === null) continue; // nothing here
	const { level, country, region, city } = reader.placeIds(placeId); // sync, no names
	// ...
}
```

`lookup()` is `query()` without the names. It returns the place's id,
which `place(id)` resolves to names and `placeIds(id)` resolves
synchronously to the ids of the place and its ancestors. Two results with
the same `placeId` are the same place, so per-place work (a colour, a
label) can be keyed on it. A map tile renderer combines all of this: it
uses `boundingBox` to fill every pixel a result covers, and looks up names
once per place rather than once per pixel.

## Names: `localName` and `internationalName`

Every place has a name in its own language and script, and usually an
international (English) one:

| | `localName` | `internationalName` | `names` |
|---|---|---|---|
| Tokyo | 東京都 | Tokyo | `["東京都", "Tokyo"]` |
| The Hague | Den Haag | The Hague | `["Den Haag", "The Hague"]` |
| Amsterdam | Amsterdam | Amsterdam | `["Amsterdam"]` |

`internationalName` falls back to `localName` when there's no separate
international name. When a name is stored once and shown to everyone,
whatever their language, use `internationalName`. **Don't** index into
`names`: `names[0]` is the local name, so it gives non-Latin script for
every place in Japan, Korea, China, Russia and many other countries.
`names` lists every name, alternative spellings included. It's what
`search()` matches against.

## Search, and a coordinate per place

```ts
for await (const place of reader.search("munchen", { sort: true, limit: 20 })) {
	place.internationalName;            // "Munich"
	place.country.internationalName;    // "Germany"
	const position = await reader.locate(place.id); // { lat, lon, boundingBox, area } or null
}
```

Search is case- and diacritic-insensitive ("munchen" finds München). It
matches any part of any name, alternative names included. With
`sort: true`, an exact name beats a whole-word match, which beats a plain
substring match, and among equal matches a country comes first. Filter
with `level`, `country` or `region` (place ids).

**Equal matches are ranked by area when a locate index is attached**
(`areaTieBreak: "auto"`, the default): "berlin" puts Berlin, Germany
ahead of the towns called Berlin in the United States, and a province
still comes right after its own same-named city. Without a locate index
they fall back to city before region, then id order, which is close to
arbitrary. So attaching a locate index changes the *order* of sorted
results, never which places match. Pass `areaTieBreak: true` to insist on
area order (it rejects without a locate index) or `false` to opt out.
Area is a size signal, not fame: a large rural Portland parish in Jamaica
still outranks Portland, Oregon.

A comma narrows by the places a match lies in: `"Paris, Texas"`,
`"Springfield, Illinois, United States"`. Each part after a comma must
match a different, further-up ancestor (region, then country). The whole
text is still matched as a name too, for the places whose names contain
a comma.

`locate(id)` returns a point inside the place: `query()` at that point
resolves to the place or something inside it. It **can return `null` for
a real place that `search()` finds**: a place smaller than the file's
finest cell (a tiny island, an enclave, a boundary sliver) has no cells
of its own. That's about 0.15% of a worldwide file. Leave those out of
results that need a position. Don't default them to a coordinate.

`area` is the place's approximate size in square degrees (within about
9%), everything under it included. To zoom a Web Mercator map to it,
`Math.log2(360 / Math.sqrt(area))` is the zoom at which a square of that
area spans one 256-pixel tile; subtract a little to leave a margin.

`search()` and `places()` are async iterators. Collect them with
`for await`, or with `Array.fromAsync()` where your runtime has it.

## Ship the index files too

Two sidecar files make search and locate fast. On a server they're
effectively **required**:

| File | Without it |
|---|---|
| `world.search-index.bin` | every `search()` scans every name: ~430 ms on a worldwide file |
| `world.locate-index.bin` | every `locate()` decodes the whole file: ~1.2 s on a worldwide file |

`openFile("world.bin")` picks up `world.search-index.bin` and
`world.locate-index.bin` next to it, the first time a `search()` or
`locate()` can use them. An index that doesn't belong to the file (built
from an older build of it, say) makes those calls reject with a
`CGeoDataIndexMismatchError` naming the index file. The reader never
falls back to a slow scan silently, so rebuild the index or delete it.
Elsewhere, pass the indexes yourself:

```ts
const reader = await CGeoDataReader.open(bytes, {
	searchIndex: await (await fetch("/data/world.search-index.bin")).arrayBuffer(),
	locateIndex: await (await fetch("/data/world.locate-index.bin")).arrayBuffer(),
});
```

`cgeodata build-locate-index world.bin --output world.locate-index.bin`
and `cgeodata build-search-index ...` build them (see [CLI](#cli)).
**Build the locate index first.** The search index stores the top
results of 1-2 character searches ranked the same way the reader will
rank them. With a locate index next to the `.bin`, it ranks them by area,
matching the reader's default. Built without one, sorted 1-2 character
searches can't use it once a locate index is present. They still return
the same results, just more slowly (~0.6 s on a worldwide file).

Only the `.bin` needs distributing: both indexes are a pure function of
it and can be built where it's used.

## Memory and the event loop

- **Cache**: decoded chunks and names are kept in a least-recently-used
  cache, by default up to 64 MiB (`open(input, { cacheBytes })`). A
  worldwide file decodes to about 690 MB in all and its largest chunk to
  about 1.9 MB. Lookups in a few regions fit easily. Lookups scattered over
  a whole continent re-decode chunks unless you give the cache more room.
  `0` turns caching off.
- **Event loop**: every read is asynchronous, and decodes take turns, one
  per macrotask, even when many lookups run at once. The longest the
  reader holds the event loop is one chunk's decode: under 1 ms for most
  chunks, about 3 ms for the largest chunk of a worldwide file (8 ms
  for a version 0 file without WebAssembly SIMD).
- **Decoding**: the WebAssembly decoder keeps one block of memory, as
  big as the largest chunk it has decoded (about 2 MB for a worldwide
  file), while decodes follow each other, and frees it once none has run
  for a second. An idle reader holds only its cache.
- **Synchronous methods** answer from memory only: `lookupCached()`,
  `placeIds()`, `chunkIndexAt()`, `subtreeIdRanges()`, `placeCounts`,
  `header`.
- **Closing**: `await reader.close()` closes the file. A reader that's
  garbage collected without being closed has its file closed then, rather
  than leaking it.

## Errors

Problems with the data reject with one of these, all exported from the
package root:

| Class | Meaning |
|---|---|
| `CGeoDataFormatError` | the `.bin` or an index file is malformed or truncated. Download it again. |
| `CGeoDataVersionError` | (a `CGeoDataFormatError`) the file uses a format version this reader doesn't know (`error.version`). Upgrade the reader. |
| `CGeoDataUnsupportedError` | (a `CGeoDataFormatError`) a valid file this reader won't read: `max_depth` past 16. Rebuild it with a bigger chunk grid. |
| `CGeoDataIndexMismatchError` | a valid index, but built from a different `.bin`. Rebuild or delete it. |
| `CGeoDataError` | base class of all of the above; also a read that returned fewer bytes than the file's size promised. |

Invalid arguments (a latitude outside [-90, 90), an id the file doesn't
have) are plain `RangeError`s.

## What the data does and doesn't contain

Check these before migrating from another geocoder:

- **Three tiers: country, region, city.** There is no second
  administrative level (GeoNames' `admin2`). A schema with a field for it
  needs changing, not filling.
- **What "city" means varies by country.** The reader returns whichever
  OpenStreetMap level covers that country best: municipalities in the
  Netherlands, counties in most of the US, communes in France, localities
  in Australia. See `countries.md` in the project root for each country.
- **Country names come from Natural Earth, in English.** `localName` and
  `internationalName` are the same for countries. Some spellings differ
  from GeoNames: "United States of America" (GeoNames: "United States"),
  "North Macedonia" ("Macedonia"), "Macao" ("Macau"). Data you stored
  earlier under the GeoNames spelling won't match new lookups until it's
  looked up again.
- **Search ranks by size, not by importance.** With a locate index,
  equally good matches are ordered by area ("berlin" puts the German
  capital first); without one, the order among them is close to
  arbitrary. Area isn't fame, though: "portland" still puts a Jamaican
  parish before Portland, Oregon. Show enough results, and show each
  one's region and country.
- **Attribution**: the data is derived from OpenStreetMap (ODbL), GeoNames
  and Natural Earth. `reader.header.attribution` holds the notice the file
  was built with. Show it wherever you show the results.

## Entry points

| Import | Contents |
|---|---|
| `@ferrybig/cgeodata-reader` | `CGeoDataReader`, its result types, the error classes, `BytesSource` / `BlobSource` / `ByteSource`, `streamInflater`. Works everywhere. |
| `@ferrybig/cgeodata-reader/node` | `openFile()`, `FileSource`, `nodeInflater` (zlib, faster than `DecompressionStream` on Node.js), `searchIndexPathFor()` / `locateIndexPathFor()`. |
| `@ferrybig/cgeodata-reader/indexes` | `SearchIndex` / `LocateIndex`, to open an index once and share it between readers, and `buildSearchIndex()` / `buildLocateIndex()`. |
| `@ferrybig/cgeodata-reader/format` | The format's low-level codecs and parsers, for tools that write or inspect files. These follow the spec, not a stable API. |

The package is ESM, with `.d.ts` types included. `dist/` is prebuilt, so
you don't compile this package's sources.

## CLI

The package installs `cgeodata`, a command-line front end to the same API:

```sh
cgeodata lookup world.bin 52.37,4.9            # or points on stdin, one per line
cgeodata search world.bin amsterdam --sort --locate
cgeodata show   world.bin 192858               # a place id from any other command
cgeodata info   world.bin                      # header, counts, sizes
cgeodata build-locate-index world.bin --output world.locate-index.bin
cgeodata build-search-index world.bin --output world.search-index.bin  # after the locate index
cgeodata help [<command>]
```

## API reference

Every exported symbol has a doc comment, and your editor shows them.
`npm run docs` in this package's source generates an HTML reference
(TypeDoc) into `docs/`. The file format, including the exact lookup
procedure, is in [binary-format.md](binary-format.md).

## License

MIT for the code. A data file carries the license and attribution of the
data it was built from (see above).
