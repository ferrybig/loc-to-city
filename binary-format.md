# Location binary format

This location format is designed for the following goals:

* Low disk space
* Relatively quick lookup speed
* Reasonable accuracy for geotagging photo purposes, it has a resolution of around 300 meters
* Not too much memory usage not bootup time
* WGS84 coordinate system

One design goal is that it is possible to answer a geocode request without having to read a 1GB file into memory, rather seeking can be used to only load smaller parts

## types

### varint

A varint (variable-length integer) encodes an unsigned integer in a variable number of bytes instead of a fixed 4 or 8 — small values take 1 byte, large ones take more. It's the standard LEB128 scheme:

* Each byte carries 7 bits of the value in its low bits.
* The top bit (0x80) is a continuation flag: 1 means "more bytes follow," 0 means "this is the last byte."
* Bytes are written least-significant-group first, so decoding just accumulates 7-bit chunks until it hits a byte with the continuation bit clear.

## Structure

`file.bin`

* Header
* Meta chunk
* City/Region/Country data
* (section chunk data, repeated X times)

### Header

The header contains the following data:

* signature: `8 bytes` CGEODATA: Standing for Compressed GEO DATA
* version: `varint` version of the file, for now `0`
* `varint` The length of the next field
* Attribution: `x bytes` An attribution field, so things like "`[OpenStreetMap](https://openstreetmap.org/copyright)`" can be captured. This field is designed for human ingestion and is markdown
* Meta chunk width in chunks: `1-byte int`: base 2 number
* Meta chunk height in chunks: `1-byte int`: base 2 number
* Keyframe interval: `1-byte int`: base 2 number how often a keyframe exists in the "name list". A value of 0 means no keyframes used. Usually a value of around 13 (2 ^ 13) = 8192 seems to be fine for compression vs recall speed, through further testing needs to be done

(TODO, maybe a scaling factor for latitude, so locations closer to the earths poles can be also made less detailed in the north/south directions to make sure each chunk is more or less square, or each chunk is a about the same size)

### Meta chunk

The meta chunk divides the world into sections. If you have 90 (which is *not* possible with the base 2 width system, but makes the visual below easier) meta chunks in width, you have bands like

* -180 - -178
* -178 - -176
* -176 - -174

Immediately after the header comes:

* Length of the City/Region/Country data section, in bytes: `varint`. This lets a reader skip straight from the chunk-length table to the start of chunk data, without ever touching (or decompressing) the name lists.
* Chunk-length table: `width * height` varints, one per meta-chunk cell, in row-major order. Entry `i` is the compressed byte length of chunk `i` — nothing more, no shifting. A value of `0` means that chunk is fully empty: no bytes are stored for it, and it should never be decompressed.

Chunk `i`'s absolute file offset is `(end of the chunk-length table) + (City/Region/Country section length) + sum(entries[0..i-1])`. Since each entry is a plain, un-shifted length, reaching chunk `i` only means summing the `i` entries before it — none of those need to be decompressed to do that.

The last chunk's declared length is there for consistency (and lets a reader sanity-check the file), but isn't strictly required: each chunk is its own independent zlib stream, so decompression naturally stops at that chunk's own end-of-stream marker regardless of what, if anything, follows it in the file.

A valid latitude is `-90 <= lat < 90`

A valid longitude is `-180 <= lon < 180` 

If either latitude or longitude outside the valid range is passed it should be rejected

Callers are responsible for performing wrap of longitude values, if desired.

A `(lat, lon)` point maps to a meta chunk index via `row * width + col`, where `col = floor((lon + 180) / 360 * width)` and `row = floor((lat + 90) / 180 * height)` — i.e. row-major, matching the chunk-length table and chunk storage order.

Having more chunks means faster decoding at the expense of more storage space.

### City/Region/Country data

The grid data is compressible, but the country names are not... We also want the country name to be useable for autocompletion.

Again, here we need to make decisions for multiple aspects

* We want to support searching through the list
* We need to support random access
* Cities/country/etc take up a lot of storage space, we want to minimize this!

We have the following data:

* varint countries size (there is no need for a regio size, since we can sum all the next entries, same for cities)
* Countries-to-region list (list of varints, 1 per country of the number of the following regios belong to that country)
* Regions-to-cities list (list of varints, 1 per region of the number of the following cities belong to that country)
* keyframe offset list (the first keyframe always has an offset and is not listed. You know the total amount of countries expected, so you can skip to the correct index). These are lengths-to-sum with.
* zlib header, from here all compressed (repeats every keyframe, even in the middle of either country/region/city block)
  * Countries list (delimited by \0)
  * Regions (delimited by \0)
  * Cities (delimited by \0)

The 2 lists of ints means that the order of cities is significant. Countries are earlier in the list, and search tool that has a limit on results shows countries before regions, before cities, which *can* be seen as an advantage. Efficient storage of entries is more important than a fast search speed

Each country/region/city has an unique id. The id is the index. Ids can only occur a single time, eg an id used by a country cannot be used by a region. Inside the chunks, we refer to the indexes of cities in the main list

The whole list of countries/regions/cities is a zlib compressed data blob, with the zlib container restarting every X keyframes

More keyframes means faster random access at the downside of space consumption by the format

The keyframe count can be computed by the formulae ceil((countries+regions+cities)/interval) - 1

### Chunks

Each chunk has its own zlib wrapper — an independent stream, decodable without touching any other chunk.

A chunk format is:

* Palette count: `varint`, the number of entries in the palette.
* Palette: that many `varint`s, referring to city/region/country indexes. Like the other incrementing lists in this format, entries are deltas — to get palette[2], sum `p[0] + p[1] + p[2]`. (An explicit count instead of a `0`-terminator, so a real index of `0` — the very first country — can still be referenced.)
* Record count: `varint`.
* Records, stored as three separate columnar arrays (same-typed values adjacent compresses better than interleaving them):
  1. **Codes** — length-prefixed (`varint` byte length, since entries are variable-width): `record count` Morton codes, delta-varint-encoded and sorted ascending, so a lookup binary-searches then linear-scans a handful of deltas. Codes are **chunk-local**: cell `0` is this chunk's own top-left corner, not global `(-90, -180)` — this keeps codes, and their deltas, small, since they never need to spend bits on which chunk they're in.
  2. **Depths** — one byte per record, same order as codes: the quadtree recursion depth at which that leaf cell was resolved. Fixed size (`record count` bytes), no length prefix needed.
  3. **Palette indices** — one entry per record, same order again. A `0` means "no city found" at that cell, so real palette entries are addressed starting from local index `1`. Fixed size (`record count * width` bytes, no length prefix needed), where `width` is: 1 byte if the palette has fewer than 255 entries, 2 bytes if fewer than `2^16`, 3 bytes if fewer than `2^24`, otherwise 4 bytes. Most chunks likely use 1 or 2 byte indices, since a single meta-chunk cell rarely touches more than a handful of distinct cities.

Chunks are stored in the same row-major order as the meta chunk table.

## examples

* Header
  * signature: `CGEODATA`
  * version: `0`
  * attribution: `''`
  * width in chunks: 2 (raw: `1`)
  * height in chunks: 2 (raw: `1`)
  * keyframe interval: \<no keyframes> (raw: 0)
* Meta chunk
  * City/Region/Country data section length: `50` (fictional)
  * chunk-length table (`width * height` = 4 entries, row-major):
    * 0 (empty chunk)
    * 0 (empty chunk)
    * 0 (empty chunk)
    * 200 (fictional length -- the only filled chunk, index 3)
  * so chunk 3's offset is `(end of this table) + 50 + 0 + 0 + 0`, and it spans 200 bytes to EOF
* City/Region/Country data
  * country size: `2`
  * Countries-to-region list:
    * 3
    * 2
  * Region to cities list:
    * 2
    * 3
    * 1
    * 1
    * 1
  * countries list
    * Test country 1
    * test country 2
  * regions list
    * regio 1
    * regio 2
    * regio 3
    * regio 1
    * regio 2
  * cities list:
    * city 1
    * city 2
    * city 1
    * city 2
    * city 3
    * city 1
    * city 1
    * city 1
* chunks (only chunk 3 is filled)
  * Palette count: `2`
  * Palette: `5, 3` (deltas -- real indexes are `5` and `5+3=8`)
  * Record count: `3`
  * Codes (delta-varint, chunk-local): first code `120`, then deltas `4, 11` -> decoded codes are `120, 124, 135`
  * Depths: `9, 9, 10`
  * Palette indices (1-byte, palette has 2 entries): `1, 2, 1` -> leaves 1 and 3 resolve to global index `5`, leaf 2 resolves to global index `8`
