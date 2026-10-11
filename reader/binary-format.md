# CGEODATA: A Compact Binary Format for Reverse Geocoding

Version 0 (draft)

## Abstract

This document specifies CGEODATA, a binary file format that maps a WGS84
coordinate to the country, region, and city that contain it, and that
carries a searchable list of those places. The format stores a quadtree
partition of the world as sorted Morton codes, split into independently
compressed chunks so that a lookup reads only a small part of the file.
The place list is stored as delta-coded hierarchy counts plus
keyframe-compressed name blocks, so that names can be recovered by index
without decompressing the whole list.

## Table of Contents

1. [Introduction](#1-introduction)
2. [Conventions and Terminology](#2-conventions-and-terminology)
3. [Primitive Types](#3-primitive-types)
4. [File Layout](#4-file-layout)
5. [Header](#5-header)
6. [Directory](#6-directory)
7. [Place Table](#7-place-table)
8. [Chunks](#8-chunks)
9. [Lookup Procedure](#9-lookup-procedure)
10. [Encoder Considerations](#10-encoder-considerations)
11. [Robustness and Security Considerations](#11-robustness-and-security-considerations)
12. [Open Issues](#12-open-issues)
- [Appendix A. Worked Example](#appendix-a-worked-example)
- [Appendix B. Text Search Index](#appendix-b-text-search-index)
- [Appendix C. Place Location Index](#appendix-c-place-location-index)
- [Appendix D. References](#appendix-d-references)

## 1. Introduction

### 1.1. Motivation

Reverse geocoding for photo management (see the project's [README](https://github.com/ferrybig/loc-to-city#readme))
is commonly implemented by storing one labelled point per place and
returning the nearest label. Cities are not points, and near any border
the nearest label is frequently wrong. Storing full polygons is accurate
but large and requires polygon arithmetic at query time.

CGEODATA stores the result of point-in-polygon classification instead of
the polygons: the world is recursively subdivided into cells until each
cell is attributed to a single place, and the resulting leaf cells are
stored as a sorted list of Morton codes. A lookup is then one binary
search.

### 1.2. Design Goals

The format is designed with the following goals, in rough priority order:

1. **Small on disk.** The place names and the spatial index together
   should be far smaller than a worldwide nearest-point table.
2. **Partial reads.** A reader MUST be able to answer a lookup by reading
   and decompressing only a small, bounded part of the file, without
   loading the entire file into memory. The file is expected to be large
   at worldwide scale.
3. **Fast lookups** after a modest one-time load of the directory.
4. **Adequate accuracy for geotagging.** The target cell resolution is on
   the order of a few hundred metres; the format itself supports finer
   resolution at the cost of size.
5. **Searchable place names.** The place list supports listing and text
   search over countries, regions, and cities, and resolving a place to
   its parents. An optional sidecar index
   ([Appendix B](#appendix-b-text-search-index)) speeds up text search
   without changing the file, and another
   ([Appendix C](#appendix-c-place-location-index)) gives each place a
   representative coordinate.
6. **Implementable with no dependencies in JavaScript** (Node.js and
   browsers) as well as other languages: only zlib, integer arithmetic,
   and binary search are required.

### 1.3. Non-Goals

- The format does not store polygon geometry and cannot answer
  distance-to-border or area queries.
- The file itself does not store a representative coordinate per place.
  One is defined by the chunks ([Section C.3](#c3-representative-cell))
  and can be precomputed into an optional sidecar file
  ([Appendix C](#appendix-c-place-location-index)).
- The format does not attempt exact answers at borders; cells that remain
  ambiguous at the maximum depth are attributed to one place by the
  encoder.

## 2. Conventions and Terminology

### 2.1. Requirements Language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in BCP 14
[RFC2119] [RFC8174] when, and only when, they appear in all capitals, as
shown here.

### 2.2. Terms

- **Byte**: an octet, 8 bits.
- **Writer**, **encoder**: software that produces a CGEODATA file.
- **Reader**, **decoder**: software that consumes a CGEODATA file.
- **Place**: a country, region, or city. Every place has an
  **identifier** (ID), which is its zero-based position in the place
  table ([Section 7](#7-place-table)).
- **Chunk grid**: the fixed rectangular grid of `W × H` chunks that
  covers the world ([Section 6.1](#61-chunk-grid)).
- **Chunk**: one cell of the chunk grid, together with its stored
  spatial index ([Section 8](#8-chunks)). The stored form is one
  independently compressed block.
- **Cell**: a rectangular area produced by quadtree subdivision of a
  chunk. A cell at depth `d` is `2^d` times smaller than the chunk in each
  direction.
- **Record**: one leaf cell stored in a chunk, attributing that cell to
  one place (or to no place).
- **Morton code** (also Z-order code): the integer obtained by
  interleaving the bits of a cell's row and column, so that quadtree
  order becomes numeric order ([Section 8.1](#81-cell-grid-and-morton-codes)).
- **Unknown**: the lookup result for a coordinate that no record
  attributes to a place.

### 2.3. Coordinate System

All coordinates are WGS84 latitude and longitude in decimal degrees. A
valid latitude satisfies `-90 <= lat < 90`. A valid longitude satisfies
`-180 <= lon < 180`. Readers MUST reject coordinates outside these ranges.
Readers do not normalise longitude; a caller that wishes to accept
`lon = 180` or values outside the range MUST wrap them itself before the
lookup.

All intervals in this document are half-open: `[a, b)` includes `a` and
excludes `b`. The world grid is equirectangular: cells are equal in
degrees, not in metres.

## 3. Primitive Types

### 3.1. Fixed-Width Integers

`u8` is one byte. `u16`, `u24`, `u32`, and `u64` are unsigned integers of
2, 3, 4, and 8 bytes, stored least significant byte first
(little-endian). `u64` is used only for checksums; a reader never needs
its value as a number and can compare it byte by byte, which sidesteps
the 53-bit integer limit of JavaScript.

### 3.2. Variable-Length Integers (varint)

A `varint` is an unsigned integer encoded as in unsigned LEB128 (the
"base 128 varint" of Protocol Buffers):

- Each byte carries 7 bits of the value in its low bits.
- The high bit (`0x80`) is a continuation flag: `1` means another byte
  follows, `0` marks the last byte.
- Groups are stored least significant first. The decoder accumulates
  `byte & 0x7F` shifted left by `7 × i` for the `i`-th byte, and stops
  after the first byte whose high bit is clear.

Every varint in this format MUST be less than `2^53`, so that it can be
represented exactly as an IEEE 754 double. An encoding therefore never
exceeds 8 bytes; readers MUST reject a varint longer than 8 bytes.
Writers MUST use the shortest encoding (no trailing `0x80 0x00`
padding). Readers MAY reject non-minimal encodings.

Examples: `0` is `00`; `127` is `7f`; `128` is `80 01`; `300` is
`ac 02`; `8192` is `80 40`.

### 3.3. Delta-Coded Lists

Several lists in this format are stored delta-coded: each stored varint is
the difference between an element and the element before it, with an
implicit previous element of `0` before the first. A delta-coded list is
therefore always non-decreasing; where this document says "strictly
increasing", every stored delta after the first MUST be at least `1`.

### 3.4. Strings

Strings are UTF-8 [RFC3629]. The header's attribution string is length
prefixed. Place names are `NUL` (`0x00`) terminated inside their
compressed block and MUST NOT contain `NUL`.

### 3.5. Compressed Blocks

A compressed block is one complete zlib stream [RFC1950] containing
DEFLATE data [RFC1951]. Every compressed block in this format is
self-contained: it can be inflated without any other block. Readers
locate a block by the byte lengths recorded in the file, not by scanning
for stream boundaries.

## 4. File Layout

A CGEODATA file consists of four consecutive sections, with no padding or
alignment between or within them:

```
+---------------------------+
| Header         (Sec. 5)   |  fixed fields, uncompressed
+---------------------------+
| Directory      (Sec. 6)   |  place table length + chunk length table
+---------------------------+
| Place table    (Sec. 7)   |  hierarchy counts + compressed name blocks
+---------------------------+
| Chunk 0        (Sec. 8)   |  one compressed block, or absent if empty
| Chunk 1                   |
| ...                       |
| Chunk W*H - 1             |
+---------------------------+
```

The header and directory are small and are expected to be read once and
kept in memory. The place table's uncompressed prefix is also small. The
compressed name blocks and the chunks are read on demand.

The file has no trailer. The end of the last chunk is the end of the
file.

Derived sidecar files, such as the text search index of
[Appendix B](#appendix-b-text-search-index) and the place location index
of [Appendix C](#appendix-c-place-location-index), are separate files that
share the signature and the version field's kind mechanism
([Section 5](#5-header)). They are never embedded in a CGEODATA file,
and a CGEODATA file never refers to them.

## 5. Header

| Field                | Type       | Description |
|----------------------|------------|-------------|
| `signature`          | 8 bytes    | The ASCII bytes `CGEODATA` (`43 47 45 4f 44 41 54 41`). |
| `version`            | varint     | File kind and format version, `kind × 16 + version`. A CGEODATA file is kind `0`; this document specifies version `0`, so the field is `0`. See below. |
| `attribution_length` | varint     | Byte length of `attribution`. |
| `attribution`        | bytes      | UTF-8 text, MAY contain Markdown, intended for display to humans, for example `[OpenStreetMap](https://openstreetmap.org/copyright)`. MAY be empty. |
| `width_exp`          | u8         | The chunk grid has `W = 2^width_exp` columns. |
| `height_exp`         | u8         | The chunk grid has `H = 2^height_exp` rows. |
| `max_depth`          | u8         | The maximum quadtree depth `D` inside a chunk. Every Morton code in the file is `2 × D` bits wide. |
| `keyframe_exp`       | u8         | Name block size. `0` means the whole name list is a single block. Any other value `k` means each block holds `I = 2^k` names. See [Section 7.3](#73-name-blocks). |

The `version` field carries two numbers: its low 4 bits are the format
version within a kind, and the remaining high bits are the **kind**,
which distinguishes the different files that share the `CGEODATA`
signature. The kinds are:

| Kind | Value of `version` | File |
|------|--------------------|------|
| `0`  | `0` to `15`        | A CGEODATA file as described by Sections 4 to 9. |
| `1`  | `16` to `31`       | A text search index derived from a kind `0` file ([Appendix B](#appendix-b-text-search-index)). |
| `2`  | `32` to `47`       | A place location index derived from a kind `0` file ([Appendix C](#appendix-c-place-location-index)). |

Other kinds are reserved. Kinds `1` and up are sidecar files: each is
derived from one kind `0` file, is regenerated rather than edited, and
has its own layout after the `version` field. Whether a file is a
sidecar is fixed by its kind, not by its name or location.

Readers MUST reject a file whose signature does not match, whose kind
is not the kind they expect, or whose version they do not implement.
Version `0` of any kind is a pre-release version: files written under
this document carry no compatibility promise once the version number
changes.

Constraints:

- `max_depth` MUST be at most `26`, so that a Morton code (`2 × D` bits)
  fits in 52 bits and is an exact integer in JavaScript.
- `width_exp` and `height_exp` MUST each be at most `15`. Larger values
  are reserved.

Choosing the grid sizes is discussed in
[Section 10](#10-encoder-considerations).

## 6. Directory

### 6.1. Chunk Grid

The chunk grid divides the world into `W` columns and `H` rows of equal
angular size. Column `c` (`0 <= c < W`) covers longitudes
`[-180 + c × 360 / W, -180 + (c + 1) × 360 / W)`. Row `r` (`0 <= r < H`)
covers latitudes `[-90 + r × 180 / H, -90 + (r + 1) × 180 / H)`. Row `0`
is the southernmost row; the origin of the grid is the south-west corner
of the world at `(lat -90, lon -180)`.

Chunks are numbered in row-major order: chunk index `i = r × W + c`.
This is the order of both the chunk length table and the stored chunks.

For example, with `width_exp = 6` (`W = 64`) each column is `5.625°`
wide: column `0` covers `[-180, -174.375)`, column `1` covers
`[-174.375, -168.75)`, and so on.

### 6.2. Layout

Immediately after the header:

| Field                | Type              | Description |
|----------------------|-------------------|-------------|
| `place_table_length` | varint            | Byte length of the entire place table ([Section 7](#7-place-table)), including its uncompressed prefix. |
| `chunk_lengths`      | `W × H` varints   | Entry `i` is the byte length of the compressed block for chunk `i`. `0` means chunk `i` is empty: no bytes are stored for it, and every coordinate inside it resolves to unknown. |

Entries are plain lengths, not deltas and not offsets.

### 6.3. Locating a Chunk

Let `chunks_start` be the file offset of the first byte after the place
table, that is, the offset of the end of `chunk_lengths` plus
`place_table_length`. Then the compressed block for chunk `i` occupies

```
offset(i) = chunks_start + sum(chunk_lengths[0 .. i-1])
length(i) = chunk_lengths[i]
```

Readers SHOULD compute the prefix sums once when loading the directory,
so that locating a chunk is an array index. The directory alone is
enough to locate any chunk; no chunk needs to be decompressed to find
another.

The last chunk's length is recorded like any other. Because each chunk
is a self-contained zlib stream, a reader could inflate it without
knowing its length, but the recorded length lets a reader bound the read
and verify that the file is complete.

## 7. Place Table

The place table is the list of all countries, regions, and cities the
file knows about, their names, and the parent of each region and city.
It is used to turn the identifier found by a spatial lookup into names,
and to support text search and listing.

### 7.1. Identifiers and Hierarchy

The hierarchy has exactly three levels: countries contain regions, and
regions contain cities. Places are numbered in one shared identifier
space:

- IDs `0 .. C-1` are the `C` countries.
- IDs `C .. C+R-1` are the `R` regions, grouped by country: all regions
  of country `0` first, then all regions of country `1`, and so on.
- IDs `C+R .. N-1` are the cities, grouped by region in the same way.
  `N = C + R + (number of cities)` is the total number of places.

An identifier denotes exactly one place; a value used for a country is
never also used for a region or city. Chunk palettes
([Section 8.3](#83-palette)) MAY reference any place, at any level: a
cell whose most specific known place is a region resolves to that
region.

The grouping order is what makes the hierarchy cheap to store: instead
of a parent pointer per place, the table stores only how many children
each parent has, and readers recover parents from prefix sums. A useful
side effect is that a search that stops after a limited number of hits
naturally reports countries before regions before cities.

### 7.2. Layout

| Field               | Type                 | Description |
|---------------------|----------------------|-------------|
| `country_count`     | varint               | `C`, the number of countries. |
| `region_counts`     | `C` varints          | Entry `j` is the number of regions belonging to country `j`. `R` is the sum of all entries. |
| `city_counts`       | `R` varints          | Entry `j` is the number of cities belonging to region `j` (region index, not ID). The number of cities is the sum of all entries. |
| `block_lengths`     | `K - 1` varints      | Entry `b` is the byte length of name block `b`, for `0 <= b < K-1`. `K` is defined in Section 7.3. |
| `name_blocks`       | `K` compressed blocks | The name list, in ID order, split into blocks as described in Section 7.3. |

The four count fields are uncompressed and are expected to be read once
and kept in memory. A country's region count or a region's city count
MAY be `0`.

### 7.3. Name Blocks

The name list is the concatenation, in ID order, of every place's name
entry ([Section 7.4](#74-name-entries)), each followed by a `NUL` byte.
It is split into `K` blocks of `I` consecutive entries each (the last
block MAY be shorter), where

```
I = 2^keyframe_exp        (if keyframe_exp != 0)
K = ceil(N / I)           (if keyframe_exp != 0)
K = 1                     (if keyframe_exp == 0)
```

A file with no places (`N = 0`) has `K = 0` and no name blocks.

Block `b` holds the entries with IDs `b × I .. min((b + 1) × I, N) - 1`.
A block boundary MAY fall anywhere, including between a country and a
region. Each block is compressed separately as one compressed block
([Section 3.5](#35-compressed-blocks)).

Block `b` starts at

```
names_start + sum(block_lengths[0 .. b-1])
```

where `names_start` is the offset of the first byte after
`block_lengths`. The length of the last block is not stored; it extends
to the end of the place table, so its length is `place_table_length`
minus the number of bytes consumed by everything before it.

The blocks act as keyframes for random access: to recover the name of
place `id`, a reader inflates only block `floor(id / I)` and skips
`id mod I` `NUL`-terminated entries. A smaller `I` gives cheaper random
access; a larger `I` gives better compression, since zlib finds more
repetition in a larger block, and a shorter `block_lengths` list.

`keyframe_exp = 7` (blocks of 128 names) is RECOMMENDED. Measured on the
worldwide file (about 319,000 places), with a reader that opens the file
afresh for every operation so that no name block is cached, which is
the situation of a reader that is queried only occasionally:

| `keyframe_exp` | Place table | Resolving one place | Scanning all names |
|----------------|-------------|---------------------|--------------------|
| `13`           | 1.64 MB     | 4.9 ms              | 134 ms             |
| `11`           | 1.70 MB     | 1.7 ms              | 142 ms             |
| `9`            | 1.82 MB     | 0.9 ms              | 141 ms             |
| `7`            | 2.05 MB     | 0.7 ms              | 152 ms             |
| `5`            | 2.53 MB     | 1.4 ms              | 210 ms             |

"Resolving one place" is a place and its parents' names, as every
lookup ([Section 9](#9-lookup-procedure)) that finds a place needs.
Name access is random in nearly every use: a lookup needs up to three
names from anywhere in the table, and a search confirms candidates
spread across it ([Section B.9](#b9-query-procedure)), so every
operation other than a full scan pays for one block per distinct name
it touches, and a smaller block is directly cheaper. Below `7` the
fixed costs take over: a reader parses `K - 1` block lengths when it
opens the file, and each block carries its own zlib framing, so both
opening the file and a full scan get slower. The place table grows by
a quarter from `13` to `7`, which is small beside the chunks at any
useful `max_depth`.

### 7.4. Name Entries

A name entry is one or more names separated by `|` (`0x7C`), interpreted
by position:

1. The first field is the local name, as the place is called in its own
   language, for example `Nederland`. It MUST NOT be empty.
2. The second field is the international (English) name, for example
   `The Netherlands`. It MAY be empty or absent, meaning the
   international name is the same as the local name.
3. Any further fields are alternative names or spellings, useful for
   search, for example the historical or transliterated names.

Writers SHOULD omit trailing empty fields, so a place with a single name
is stored as `Amsterdam`, not `Amsterdam|`. Fields MUST NOT contain `|`
or `NUL`; there is no escape mechanism. A reader that displays a place
SHOULD show the local name, and a search SHOULD match against every
field.

Examples:

```
Nederland|The Netherlands
Den Haag|The Hague|'s-Gravenhage
Amsterdam
```

### 7.5. Resolving an Identifier

Given the counts of Section 7.2, a reader classifies `id` as follows:

- If `id < C`, it is country `id`.
- Otherwise, if `id < C + R`, it is the region with region index
  `j = id - C`. Its country is the largest `c` such that
  `sum(region_counts[0 .. c-1]) <= j`.
- Otherwise it is the city with city index `j = id - C - R`. Its region
  index is the largest `r` such that `sum(city_counts[0 .. r-1]) <= j`,
  and its country follows from the region as above.

Readers SHOULD precompute the two prefix-sum arrays at load time, after
which both steps are a binary search. Readers MUST reject an `id` that
is not less than `N`.

## 8. Chunks

Each non-empty chunk stores the spatial index for its area as a single
compressed block ([Section 3.5](#35-compressed-blocks)). This section
describes the inflated content.

### 8.1. Cell Grid and Morton Codes

Inside a chunk, a quadtree of depth `D = max_depth` subdivides the chunk
into `2^D × 2^D` cells of equal angular size. A cell is addressed by its
column `x` and row `y`, each in `[0, 2^D)`, counted from the chunk's
south-west corner: `x` increases eastward and `y` increases northward.

The full-precision Morton code of cell `(x, y)` is the `2 × D`-bit
integer obtained by interleaving the bits of `y` and `x`, most
significant first, with the `y` bit placed above the `x` bit in every
pair:

```
code = 0
for i from D-1 down to 0:
    code = (code << 1) | ((y >> i) & 1)
    code = (code << 1) | ((x >> i) & 1)
```

Equivalently, reading the code two bits at a time from the top selects a
quadrant at each level: `00` south-west, `01` south-east, `10`
north-west, `11` north-east.

A cell at depth `d < D` is the union of the `4^(D-d)` full-precision
cells whose codes share its top `2 × d` bits. Its **stored code** is the
smallest of those codes: the `2 × d` path bits followed by
`2 × (D - d)` zero bits. Consequently the stored code of a cell is the
minimum full-precision code of any point inside it, which is the
invariant the lookup in [Section 9](#9-lookup-procedure) depends on.

Codes are chunk-local. Cell `(0, 0)` is the chunk's own south-west
corner, not the world's. This keeps codes, and the deltas between them,
small.

For `D = 2` the sixteen full-precision codes are laid out as follows
(north is up):

```
 y=3 | 10  11  14  15
 y=2 |  8   9  12  13
 y=1 |  2   3   6   7
 y=0 |  0   1   4   5
     +----------------
       x=0 x=1 x=2 x=3
```

### 8.2. Layout

| Field             | Type                       | Description |
|-------------------|----------------------------|-------------|
| `palette_count`   | varint                     | `P`, the number of palette entries. |
| `palette`         | `P` varints, delta-coded   | Place IDs referenced by this chunk, strictly increasing ([Section 8.3](#83-palette)). |
| `record_count`    | varint                     | `M`, the number of records. |
| `codes_length`    | varint                     | Byte length of `codes`. |
| `codes`           | `M` varints, delta-coded   | Stored Morton codes, strictly increasing. |
| `depths`          | `M` u8                     | Depth `d` of each record, in record order. |
| `palette_indices` | `M` × `S` bytes            | Palette index of each record, in record order, as unsigned little-endian integers of `S` bytes. |

The three per-record arrays are stored one after the other rather than
interleaved per record. Grouping same-typed values together lets zlib
find far more repetition; on the prototype data this columnar layout
plus delta coding reduced the index about twelvefold compared with
fixed 8-byte records.

`codes_length` is present because varints are variable width, so the
start of `depths` cannot otherwise be computed without decoding every
code. `depths` and `palette_indices` are fixed width and need no length.

The inflated block MUST contain exactly these fields and nothing else:
after `palette_indices` the block ends.

### 8.3. Palette

The palette lists every place ID referenced by the chunk's records, in
strictly increasing order, delta-coded ([Section 3.3](#33-delta-coded-lists)).
The first stored value is the first ID itself (its delta from `0`), so an
ID of `0`, the first country, can be referenced.

Records refer to the palette by a **local index** in `[0, P]`:

- Index `0` means "no place". A record with index `0` resolves to
  unknown, exactly as if no record covered the cell.
- Index `k` for `1 <= k <= P` refers to `palette[k - 1]`.

The index width `S` is derived from `P`:

| `P`                     | `S`     |
|-------------------------|---------|
| `P <= 255`              | 1 byte  |
| `256 <= P <= 65535`     | 2 bytes |
| `65536 <= P <= 2^24-1`  | 3 bytes |
| otherwise               | 4 bytes |

Most chunks are expected to reference a few dozen places at most and to
use 1-byte indices.

Every palette entry MUST be a valid place ID, that is, less than `N`.

### 8.4. Records

Record `j` is the triple `(codes[j], depths[j], palette_indices[j])`.
It states that the cell at depth `depths[j]` whose stored code is
`codes[j]` is attributed to the place selected by `palette_indices[j]`.

A cell denoted by `(code, d)` covers the full-precision code range
`[code, code + 4^(D-d))`.

### 8.5. Invariants

A chunk MUST satisfy all of the following. Readers MAY verify them at
load time and MUST NOT rely on undefined behaviour if they do not.

1. `0 <= depths[j] <= D` for every record.
2. The low `2 × (D - depths[j])` bits of `codes[j]` are zero (the code
   is a stored code as defined in Section 8.1).
3. Codes are strictly increasing: `codes[j] < codes[j+1]`.
4. Cells do not overlap. Given invariant 3 this is equivalent to
   `codes[j] + 4^(D - depths[j]) <= codes[j+1]` for every consecutive
   pair.
5. Every code is less than `4^D`.
6. Every palette index is at most `P`.

Cells need not cover the whole chunk. A writer MAY leave gaps for areas
with no place; a coordinate in a gap resolves to unknown. Gaps and
index-`0` records are equivalent for lookup purposes; gaps are smaller,
while index-`0` records allow a writer to emit a complete partition if
it prefers.

## 9. Lookup Procedure

To resolve a coordinate `(lat, lon)` to a place ID, a reader performs the
following steps. `W`, `H`, and `D` come from the header.

1. **Validate.** If `lat` or `lon` is outside the ranges of
   [Section 2.3](#23-coordinate-system), fail.
2. **Compute global cell coordinates.** Let `NX = W × 2^D` and
   `NY = H × 2^D` be the total number of full-precision cells across the
   world in each direction.

   ```
   gx = floor((lon + 180) / 360 × NX)
   gy = floor((lat +  90) / 180 × NY)
   ```

   Because floating-point rounding can push a value just below the upper
   bound onto it, readers MUST clamp `gx` to `[0, NX-1]` and `gy` to
   `[0, NY-1]`.
3. **Split into chunk and local cell.** `c = gx >> D`, `r = gy >> D`,
   `x = gx & (2^D - 1)`, `y = gy & (2^D - 1)`, and the chunk index is
   `i = r × W + c`. Computing `gx` and `gy` once and splitting them, rather
   than computing the chunk and the local cell with separate divisions,
   avoids inconsistent rounding between the two.
4. **Fetch the chunk.** If `chunk_lengths[i]` is `0`, the result is
   unknown. Otherwise read `length(i)` bytes at `offset(i)`
   ([Section 6.3](#63-locating-a-chunk)) and inflate them. Readers
   SHOULD cache inflated chunks.
5. **Compute the query code** `q` from `(x, y)` with the procedure of
   [Section 8.1](#81-cell-grid-and-morton-codes).
6. **Binary search.** Find the largest `j` such that `codes[j] <= q`
   (`bisect_right(codes, q) - 1` in Python terms). If no such `j` exists,
   the result is unknown.
7. **Verify containment.** Let `shift = 2 × (D - depths[j])`. If
   `(q >> shift) != (codes[j] >> shift)`, the point lies in a gap between
   records and the result is unknown.
8. **Resolve the palette index.** Let `k = palette_indices[j]`. If `k` is
   `0`, the result is unknown. Otherwise the result is `palette[k - 1]`.

Step 6 is correct because of the invariants of
[Section 8.5](#85-invariants): every stored code is the minimum code of
its cell, cells do not overlap, and codes are sorted, so the cell
containing `q`, if any, is the one with the largest stored code not
exceeding `q`. Step 7 is required because the partition may have gaps.

To present the result, the reader resolves the ID to its parents
([Section 7.5](#75-resolving-an-identifier)) and recovers the names from
the appropriate name blocks ([Section 7.3](#73-name-blocks)).

## 10. Encoder Considerations

This section is informative.

**Chunk grid size.** More chunks mean that each lookup inflates a smaller
block and that codes are shorter, at the cost of a larger directory and
some per-chunk overhead (zlib framing and a palette per chunk). Chunks
over open ocean cost only their `0` length entry. `width_exp = height_exp + 1`
gives chunks that are square in degrees; any other ratio gives
rectangular chunks and cells, which is permitted.

**Maximum depth.** `D` together with the chunk grid fixes the finest
resolution: a full-precision cell is `360 / (W × 2^D)` degrees of
longitude by `180 / (H × 2^D)` degrees of latitude. The prototype found
that forcing every ambiguous cell down to a 10 m floor produced far more
records than the size budget allowed, while stopping at roughly 300 m
and attributing the remaining ambiguous cells to the candidate with the
largest share of the cell's area gave good results for geotagging.

**Building records.** The intended construction is recursive: starting
from the chunk as a depth-`0` cell, stop and emit a record when no place
touches the cell (or emit nothing), or when exactly one place fully
contains it; otherwise subdivide, and at depth `D` pick one candidate.
When several places fully contain a cell (nested administrative levels),
prefer the smallest.

**Keyframe interval.** See [Section 7.3](#73-name-blocks).

**Compression.** zlib was chosen over zstd or brotli because it is a
zero-dependency built-in in Node.js and browsers. The columnar and
delta-coded layout captures most of the gain regardless of the
compressor; on the prototype, zstd and brotli were only 10–20% smaller.
Writers SHOULD use the highest zlib compression level; compression is a
one-time cost.

## 11. Robustness and Security Considerations

A CGEODATA file may come from an untrusted source. Readers MUST NOT
assume that a file is well formed.

- Readers MUST verify the signature, kind, and version before
  interpreting any other field.
- Readers MUST check that `place_table_length`, every chunk offset, and
  every chunk length lie within the file before reading.
- Readers MUST bound the inflated size of every compressed block. A
  chunk's inflated size is at most a small multiple of what its counts
  imply; a reader SHOULD inflate with an explicit output limit and reject
  a block that exceeds it, to defend against decompression bombs.
- Readers MUST check that the inflated chunk contains exactly the bytes
  its counts require, that every depth is at most `D`, that every
  palette index is at most `P`, and that every palette entry is less than
  `N`. Readers MAY additionally verify the ordering and non-overlap
  invariants of [Section 8.5](#85-invariants).
- Readers MUST treat the attribution text and place names as untrusted
  text. Where they are rendered as Markdown or HTML, they MUST be
  sanitised.
- Varints MUST be rejected when longer than 8 bytes, so that a malformed
  file cannot cause unbounded loops or values beyond `2^53`.

## 12. Open Issues

The following are known gaps or unresolved decisions in version `0`.

1. **Latitude scaling.** Because the grid is equirectangular, cells
   shrink in east-west extent towards the poles. A per-row scaling
   factor, or fewer columns at high latitudes, would keep cells closer to
   square on the ground. Not addressed in this version.
2. **Representative points are derived, not stored.** A place search
   that returns a location for each hit (as Immich's `searchPlaces`
   does) needs a representative point per place. The place table has no
   such field; the point is derived from the chunks
   ([Section C.3](#c3-representative-cell)) and cached in a sidecar file
   of kind `2`. It is therefore limited to what the cells show: it cannot
   be an administrative centre or a label position from the source data.
   A future version could let the encoder supply one.
3. **No exact-fallback marker.** The prototype's approach C reserves a
   sentinel for cells that should be resolved by exact polygon
   arithmetic. This format only supports build-time attribution
   (approach D). A reserved palette index could be added later.
4. **Fixed three-level hierarchy.** Countries whose cities sit directly
   under the country need a placeholder region.
5. **Global versus per-chunk depth.** `D` is global. A per-chunk depth
   would let sparse areas use shorter codes; whether that is worth the
   complexity has not been measured.
6. **Name escaping.** `|` cannot appear in a name. No real place name
   affected by this is known, but there is no escape mechanism.

## Appendix A. Worked Example

This appendix gives a complete, valid, synthetic file of 157 bytes and
walks through several lookups. Its geography is fictional. The file uses
a `2 × 2` chunk grid, a quadtree depth of `2`, and name blocks of `4`
entries.

### A.1. Header (17 bytes)

```
43 47 45 4f 44 41 54 41   signature "CGEODATA"
00                        version 0
03  4f 53 4d              attribution_length 3, attribution "OSM"
01                        width_exp  1  -> W = 2
01                        height_exp 1  -> H = 2
02                        max_depth  2  -> D = 2, codes are 4 bits
02                        keyframe_exp 2 -> I = 4 names per block
```

### A.2. Directory (5 bytes)

```
6d                        place_table_length 109
00 00 00 1a               chunk_lengths: chunk 0, 1, 2 empty; chunk 3 is 26 bytes
```

Chunk `3` is row `1`, column `1`: latitudes `[0, 90)`, longitudes
`[0, 180)`. Its block starts at offset `17 + 5 + 109 = 131` and ends at
`157`, the end of the file.

### A.3. Place Table (109 bytes)

Uncompressed prefix (6 bytes):

```
02                        country_count C = 2
01 01                     region_counts: country 0 has 1 region, country 1 has 1  -> R = 2
02 01                     city_counts: region 0 has 2 cities, region 1 has 1     -> 3 cities, N = 7
43                        block_lengths: block 0 is 67 bytes (K = ceil(7/4) = 2, so K-1 = 1 entry)
```

The identifier space is:

| ID | Kind    | Parent | Name entry                 |
|----|---------|--------|----------------------------|
| 0  | country |        | `Nederland\|The Netherlands` |
| 1  | country |        | `België\|Belgium`          |
| 2  | region  | 0      | `Noord-Holland`            |
| 3  | region  | 1      | `Antwerpen\|Antwerp`       |
| 4  | city    | 2      | `Amsterdam`                |
| 5  | city    | 2      | `Zaandam`                  |
| 6  | city    | 3      | `Antwerpen\|Antwerp`       |

Block `0` (IDs 0–3) inflates to
`Nederland|The Netherlands\0België|Belgium\0Noord-Holland\0Antwerpen|Antwerp\0`
and is stored as these 67 bytes:

```
78 da f3 4b 4d 49 2d ca 49 cc 4b a9 09 c9 48 55 f0 4b 2d c9 80 70 8b 19
9c 52 73 d2 33 0f af ae 01 d3 a5 b9 0c 7e f9 f9 45 29 ba 1e f9 39 20 69
06 c7 bc 92 f2 d4 a2 82 d4 bc 1a 28 8b 01 00 2e 70 1c 57
```

Block `1` (IDs 4–6) inflates to `Amsterdam\0Zaandam\0Antwerpen|Antwerp\0`
and is stored as the remaining `109 - 6 - 67 = 36` bytes:

```
78 da 73 cc 2d 2e 49 2d 4a 49 cc 65 88 4a 4c cc 03 d1 8e 79 25 e5 a9 45
05 a9 79 35 50 16 03 00 f7 a7 0d 6c
```

To find the name of ID `5`, a reader inflates block `floor(5 / 4) = 1`
and skips `5 mod 4 = 1` entry, arriving at `Zaandam`.

### A.4. Chunk 3 (26 bytes compressed)

Stored bytes:

```
78 da 63 62 62 66 65 65 60 61 64 66 61 64 62 62 04 42 06 46 26 00 02 22
00 2c
```

Inflated content (20 bytes):

```
02                        palette_count P = 2  -> S = 1
02 03                     palette deltas 2, 3  -> IDs 2 (Noord-Holland), 5 (Zaandam)
05                        record_count M = 5
05                        codes_length 5
00 04 01 03 04            code deltas       -> codes  0, 4, 5, 8, 12
01 02 02 01 02            depths
01 02 00 01 02            palette_indices   -> ID 2, ID 5, none, ID 2, ID 5
```

The five records cover the chunk's `4 × 4` cell grid as follows
(north is up; `A` = Noord-Holland, `B` = Zaandam, `-` = index 0,
`.` = no record):

```
 y=3 |  A   A   .   .
 y=2 |  A   A   B   .
 y=1 |  A   A   .   .
 y=0 |  A   A   B   -
     +-----------------
       x=0 x=1 x=2 x=3
```

Record `0` is `(code 0, depth 1)`, the depth-1 cell covering codes
`0..3`. Record `3` is `(code 8, depth 1)`, covering codes `8..11`. The
other three are full-precision cells. Codes `6`, `7`, `13`, `14`, and
`15` have no record.

### A.5. Lookups

`NX = NY = 2 × 2^2 = 8`.

**`(lat 20, lon 100)`.** `gx = floor(280/360 × 8) = 6`,
`gy = floor(110/180 × 8) = 4`. Chunk `c = 1, r = 1`, index `3`; local
cell `x = 2, y = 0`, code `q = 4`. The largest stored code `<= 4` is
record `1` (`code 4, depth 2`). `shift = 0`, and `4 == 4`, so the point
is inside. Palette index `2` selects ID `5`: **Zaandam**, in
Noord-Holland, Nederland.

**`(lat 40, lon 30)`.** `gx = floor(210/360 × 8) = 4`,
`gy = floor(130/180 × 8) = 5`. Chunk `3`; local cell `x = 0, y = 1`,
`q = 2`. The largest stored code `<= 2` is record `0` (`code 0,
depth 1`). `shift = 2 × (2 - 1) = 2`, and `2 >> 2 == 0 >> 2`, so the
point is inside that depth-1 cell. Palette index `1` selects ID `2`:
**Noord-Holland** (a region-level result).

**`(lat 30, lon 100)`.** `gx = 6`, `gy = floor(120/180 × 8) = 5`;
chunk `3`, local `x = 2, y = 1`, `q = 6`. The largest stored code
`<= 6` is record `2` (`code 5, depth 2`). `shift = 0` and `6 != 5`, so
the point is in a gap: **unknown**.

**`(lat 20, lon 170)`.** `gx = 7`, `gy = 4`; local `x = 3, y = 0`,
`q = 5`. Record `2` matches exactly, but its palette index is `0`:
**unknown**.

**`(lat -10, lon 10)`.** `gx = 4`, `gy = floor(80/180 × 8) = 3`; chunk
`c = 1, r = 0`, index `1`. Its length is `0`: **unknown**, with no
decompression performed.

## Appendix B. Text Search Index

This appendix specifies an OPTIONAL sidecar file that speeds up substring
search over place names. It is a separate file, derived entirely from the
place table ([Section 7](#7-place-table)) of one CGEODATA file, and it
carries file kind `1` ([Section 5](#5-header)).

### B.1. Purpose and Properties

A text search without an index reads every name in the place table and
compares it with the query: a linear scan over every name block, which
at worldwide scale means inflating the names of over 300,000 places. The
index described here lets a reader avoid most of that, in two ways:

- **Trigram lists** ([Section B.3](#b3-trigrams-and-lists)) record, for
  every run of three symbols, which places contain it in one of their
  names. A query of three or more symbols reads only the lists of its own
  trigrams, and only the places present in all of them can match.
- **A short-query table** ([Section B.6](#b6-short-query-table)) answers
  queries of one or two characters, which have no trigram and match a
  large part of the table, by storing the first places of their
  relevance-ordered result directly.

The index has the following properties:

- **It covers every place.** Countries, regions, and cities are all
  indexed, so a query never has to scan any part of the place table
  linearly while the index applies.
- **The trigram lists only over-approximate.** Every step that maps
  names to lists is many-to-one, so the places they leave over are a
  superset of the true matches ([Section B.9](#b9-query-procedure)). A
  reader confirms every candidate by comparing its names, exactly as it
  would without the index, and MUST produce the same results with and
  without it.
- **It is a pure function of its source.** Two writers given the
  same source, the same parameters, and the same relevance rule
  ([Section B.7](#b7-file-layout)) MUST produce byte-identical files.
  The file carries no timestamp and nothing else that depends on
  the writer, and nothing in it is compressed, since deflate output is
  not guaranteed to be identical between zlib implementations. It is
  bound to its source by a checksum ([Section B.8](#b8-source-checksum)):
  over the source's place table, or for a short-query table in area
  order, over everything up to the first chunk.
- **It is read in parts.** The header records the length of every
  section, so a reader reads only the header up front, and afterwards
  only what a query needs: the list directory and a few lists for a long
  query, or the table directory and one table block for a short one.
- **It is disposable.** Because it is derived, it can be rebuilt from
  its source at any time.

### B.2. Symbol Folding

Names and queries are reduced in two stages, both used elsewhere in this
appendix: first to their **folded form**, a plain string that is
diacritic- and case-insensitive; then, for trigram purposes only, further
to a sequence of **symbols**, non-negative integers that also collapse
every ASCII digit together and every other ASCII punctuation/space
character together. The folded form is what [Section B.5](#b5-relevance-order)
and [Section B.6](#b6-short-query-table) compare and rank with; the
symbol sequence is what trigrams ([Section B.3](#b3-trigrams-and-lists))
are taken from. Keeping them distinct matters: the symbol sequence's
digit/punctuation bucketing is the right call for keeping the number of
trigram lists bounded, but it would make `5th` match `9th` as a
substring, which is too loose for deciding whether, or how well, text
actually matches a query.

The folded form is produced by:

1. Decompose the text into Unicode Normalization Form D [UAX15].
2. Remove every code point in the Combining Diacritical Marks block,
   `U+0300` to `U+036F` inclusive.
3. Convert the result to lowercase with the Unicode default case
   conversion (the locale-independent `toLowercase()` of [UNICODE]
   Section 3.13).

Step 1 followed by step 2 turns `é` into `e`. Step 3 turns `E` into `e`.
`ß`, `ø`, and `ł`, which have no decomposition, and every letter of a
non-Latin script, pass through unchanged apart from case.

The symbol sequence continues from the folded form with a fourth step,
mapping each remaining code point `c` to one symbol:

| Code points                     | Symbol |
|---------------------------------|--------|
| `a` to `z` (`U+0061`–`U+007A`)  | `0` to `25` in alphabetical order |
| `0` to `9` (`U+0030`–`U+0039`)  | `27`, the digit symbol |
| any other code point below `U+0080` | `26`, the separator symbol |
| any code point from `U+0080` up | `c` itself |

Step 4 puts all ASCII digits in one bucket and all ASCII spaces and
punctuation in another, and keeps every other character distinct: `ß`,
`ø`, and `ł` and every letter of a non-Latin script are symbols of their
own, same as in the folded form. Symbols `0` to `27` are the **Latin
symbols**; every other symbol is at least `128`.

Both reductions are lossy, but one code point never becomes more than one
folded character, and one folded character never becomes more than one
symbol, so any text that contains another as a substring contains it as a
substring after folding, and after taking symbols, too
([Section B.9](#b9-query-procedure)). Step 4's bucketing means the symbol
sequence is a *further*, coarser folding of the folded form -- so a
comparison against the folded form alone (Sections B.5, B.6) is stricter
than, and therefore safe to confirm trigram-index candidates with, a
comparison against the symbol sequence ([Section B.9](#b9-query-procedure)
explains why that direction is the one that matters). Neither stage uses
any Unicode character property beyond normalization and case conversion,
so that a writer and a reader built against different versions of the
Unicode Character Database fold the same text the same way. Writers and
readers MUST use exactly this procedure for both the folded form and the
symbol sequence.

### B.3. Trigrams and Lists

A **trigram** is a run of three consecutive symbols. The trigram set of
a place is the union, over every field of its name entry
([Section 7.4](#74-name-entries)), of the trigrams of that field's
symbol sequence. Each field is folded separately; no trigram spans the
`|` between two fields. A field shorter than three symbols contributes
nothing.

The index has one list per possible **list index**. There are

```
L = 28^3 + 2^hash_exp = 21952 + 2^hash_exp
```

list indices. A trigram `(s0, s1, s2)` whose symbols are all Latin has
the list index

```
l = s0 × 784 + s1 × 28 + s2              (0 <= l < 21952)
```

so every Latin trigram has a list of its own. Any other trigram is
hashed into one of `2^hash_exp` shared lists: let `bytes` be the nine
bytes formed by writing `s0`, `s1`, and `s2` each as a `u24`
([Section 3.1](#31-fixed-width-integers)), let `h` be the 32-bit
FNV-1a hash [FNV] of `bytes`, and fold `h` to `hash_exp` bits:

```
h = 0x811c9dc5
for each byte b of bytes, in order:
    h = h xor b
    h = (h × 0x01000193) mod 2^32
l = 21952 + (((h >> hash_exp) xor h) mod 2^hash_exp)
```

Symbols are code points or smaller, so each fits in a `u24`. Test
vectors for the 32-bit hash: the empty input hashes to `811c9dc5`, the
single byte `a` to `e40c292c`, and the ASCII text `foobar` to
`bf9cf968`. Some trigram list indices with `hash_exp = 15`:

| Text     | Trigram                    | `bytes`                      | `h`        | `l`     |
|----------|----------------------------|------------------------------|------------|---------|
| `łód`    | `(0x142, 14, 3)`           | `42 01 00 0e 00 00 03 00 00` | `0702848f` | `24650` |
| `東京都` | `(0x6771, 0x4eac, 0x90fd)` | `71 67 00 ac 4e 00 fd 90 00` | `574bcbf2` | `47909` |
| `straße` | `(0, 0xdf, 4)`, from `aße` | `00 00 00 df 00 00 04 00 00` | `e5f8c954` | `22629` |

List `l` holds every place whose trigram set contains a trigram with
list index `l`. Two hashed trigrams may share a list; that only admits
more candidates, never fewer.

### B.4. List Encoding

Each list is a strictly increasing set of place IDs, stored in one of
two encodings:

- **ID list** (encoding `0`): the IDs as a delta-coded list
  ([Section 3.3](#33-delta-coded-lists)), with no count. The list ends
  where its stored length ends.
- **Bitmap** (encoding `1`): `ceil(N / 8)` bytes, one bit per place of
  the source, where `N` is the number of places. The bit of place `id`
  is in byte `id >> 3`, at bit position `id & 7`, least significant bit
  first. Bits for positions `N` and beyond in the last byte MUST be `0`.

Writers MUST use the ID list when its encoded length is at most
`ceil(N / 8)`, and the bitmap otherwise. The choice is then fixed by the
set, which keeps the file a pure function of its source. A list that
would be empty is not stored at all ([Section B.7](#b7-file-layout)).

### B.5. Relevance Order

A reader that returns search results ordered by relevance, rather than
by ID, SHOULD use this order or the area order of
[Section B.5.1](#b51-area-order), and the short-query table
([Section B.6](#b6-short-query-table)) MUST be built with the one its
`relevance_rule` names ([Section B.7](#b7-file-layout)).

A place **matches** a query when the folded form
([Section B.2](#b2-symbol-folding)) of at least one field of its name
entry contains the folded form of the query as a substring. Folding
before comparing means a query need not be typed with the right
diacritics: `zurich` matches a field spelled `Zürich`.

The **tier** of a field that contains the query, against the folded
form of both, is:

- `40` when the field's folded form equals the query's;
- otherwise `20` when the query's **tokens** occur in the field's tokens
  as a contiguous run, where the tokens of a text are its folded form
  split at every code point whose General Category is not a letter (`L*`)
  or a number (`N*`), with empty tokens dropped;
- otherwise `10`.

A field that does not contain the query folded has tier `0` and, with
it, **quality** `0`: nothing below distinguishes a non-match. A field
that does contain it gets `1` added to its folded tier -- an **exact
spelling bonus** -- when the *unfolded* comparison (plain lowercase, no
decomposition or diacritic stripping) reaches that same tier against the
*unfolded* query, i.e. when folding was not actually needed to reach it.
The unfolded comparison can never reach a *better* tier than the folded
one -- folding only ever adds matches -- so "reaches at least the same
tier" is exactly "the query's own spelling, as given, was already
enough". Unlike the folded tier itself, and unlike
[Section B.9](#b9-query-procedure)'s confirmation step, which compares
folded forms, the bonus is evaluated with no normalization beyond
lowercasing: it decides only how well a field matches, never whether it
matches at all, so it can be stricter than the comparison the index's
guarantee rests on without ever losing a match. A field's **quality** is
its folded tier plus this bonus, so quality is one of `0`, `10`, `11`,
`20`, `21`, `40`, `41`.

The quality of a place is the highest quality of its fields, and its
**score** is its quality plus a level bonus: `3` for a country, `2` for
a city, `1` for a region. Results are ordered by descending score,
places with equal scores by descending context quality
([Section B.13](#b13-qualified-queries)), which is `0` for a query
without contexts, and then by ascending ID.

The level bonus only ever breaks a tie between two places of equal
quality: its spread (`3 - 1 = 2`) is kept well under the gap between any
two quality values that differ in folded tier (`11` to `20` is `9`, `21`
to `40` is `19`), so a worse tier can never outscore a better one no
matter which levels are involved, and the exact spelling bonus can never
promote a field past the next tier either. A country outranks a
same-quality city or region specifically because a query that exactly
names a country is a rarer, more deliberate kind of search than one
that merely happens to match one of the many more numerous cities or
regions sharing the text -- a plain reversal of city and region was
deliberately not used instead, since it would equally rank, say, a
*province* named Antwerpen above the *city* of Antwerp on an identical
exact match, which is backwards for the far more common case of
searching a city's own name; a city therefore still outranks a region of
equal quality, exactly as if countries did not exist in the formula.

For example, the query `amsterdam` gives the city `Amsterdam` quality
`41` (folded tier `40`, an exact match that needed no folding) and score
`43`, and the city `Nieuw-Amsterdam` quality `21` (folded tier `20`; its
tokens are `nieuw`, `amsterdam`) and score `23`. The query `belgie`
(typed without the diaeresis) gives the country `België` folded tier
`40` (an exact match once both are folded to `belgie`) but quality `40`,
not `41`: the unfolded comparison, `belgië` against `belgie`, does not
reach an exact match (or even a substring match) on its own, so the
spelling bonus does not apply; querying `belgië` instead reaches quality
`41`. The query ` amsterdam` with a leading space matches neither: token
matching only ranks places that already match.

Only the ranking depends on Unicode character properties, never whether
a place matches, so a reader and writer that disagree about a character's
category can disagree about order but not about the set of results.

#### B.5.1. Area Order

Among places of equal score, the order above falls back to IDs, which
carry no meaning: the query `berlin` would list a dozen towns in the
United States before the city-state of Berlin. A reader that knows the
area of every place -- the area bytes of
[Section C.3](#c3-representative-cell), which a place location index
stores -- MAY instead order results by area, so that among equally good
matches a large place comes first. Whether to is the application's
choice, and a reader SHOULD let it make it. A reader MUST NOT use this
order without the areas, since a reader that has them and one that does
not would then disagree.

The **rank area** of a country or a city is its area byte. The rank
area of a region is also its area byte, unless one or more of its cities
has a local name (field `0`, [Section 7.4](#74-name-entries)) whose
folded form ([Section B.2](#b2-symbol-folding)) equals that of the
region's own local name: then it is the largest area byte among those
cities. A province would otherwise come before its own capital of the
same name (the province of Utrecht before the city of Utrecht) for no
reason but its size, which Section B.5's level bonus exists to prevent;
with this rule it comes right after it, while a city-state with no city
of its own name (Berlin, Vienna) still ranks by its own area.

In area order, places are compared on the following keys in turn, each
one only deciding between places equal on all keys before it:

1. the folded tier of their quality ([Section B.5](#b5-relevance-order),
   quality without the exact spelling bonus), higher first;
2. their context quality ([Section B.13](#b13-qualified-queries)),
   higher first;
3. countries before regions and cities;
4. their rank area, higher first;
5. the exact spelling bonus, present first;
6. cities before regions;
7. their ID, lower first.

The exact spelling bonus comes after the area, unlike in Section B.5's
score, or the query `zurich` would rank a village spelled `Zurich` ahead
of `Zürich` whatever their sizes. Countries keep their precedence for
the reason Section B.5 gives.

For example, the query `dam` against the file of
[Appendix A](#appendix-a-worked-example) matches `Amsterdam` and
`Zaandam`, both with quality `11` and score `13`. Section B.5 orders them
by ID, `Amsterdam` first. In area order `Zaandam`, with area byte `5`
([Section C.8](#c8-worked-example)), comes first, and `Amsterdam`, which
has no cells and so area byte `0`, second.

Area order matches the same places as Section B.5 and only orders them
differently.

### B.6. Short-Query Table

A query of one or two characters has no trigram, and matches so many
places that comparing every name is the only way to rank them. The
short-query table instead stores, for every such query that has any
match, the first `top_count` places in relevance order
([Section B.5](#b5-relevance-order)).

The table's **keys** are every string of one or two consecutive code
points that occurs in the folded form ([Section B.2](#b2-symbol-folding))
of some field of some name entry. The table MUST contain every key and
no other. The **entry** of a key is the list of the places that match
it, in the relevance order the file's `relevance_rule` names
([Section B.5](#b5-relevance-order) or
[Section B.5.1](#b51-area-order), scoring the key itself as the query),
truncated to its first `top_count` places. A
key always has at least one match, so an entry is never empty; it has
fewer than `top_count` places only when fewer places match. A query
whose folded form is one or two code points long and is not a key
matches no place at all.

Because a key is already in folded form, scoring it as a query can never
need Section B.5's exact spelling bonus to be anything other than
whatever the key's own, already-folded spelling gives it -- a key never
carries a diacritic of its own to fold away. A *query* that does,
though, may need a different bonus than its key would: `e` and `é` both
fold to the key `e`, but a field spelled with an actual `é` reaches the
exact spelling bonus against the query `é` and not against the query
`e`, which the table cannot represent with one entry per key. A reader
therefore MUST NOT answer a query from this table unless the query's own
folded form already equals its unfolded (plain lowercase) form, i.e. the
query itself has no diacritic to fold -- see [Section B.9](#b9-query-procedure)'s
step 1.

Entries are sorted by the UTF-8 bytes of their key, compared bytewise
(which equals comparing code points), and grouped into **table blocks**
of `2^top_block_exp` consecutive entries; the last block MAY be shorter.
A table block is the concatenation of its entries, each stored as:

| Field   | Type          | Description |
|---------|---------------|-------------|
| `key`   | bytes, `NUL`  | The key in UTF-8, followed by a `NUL` byte. |
| `count` | varint        | The number of places in the entry, from `1` to `top_count`. |
| `ids`   | `count` varints | The places, in relevance order. Not delta-coded: relevance order is not ID order. |

The **table directory** lists, for each block, the key of its first
entry, so that a reader finds the block of a key by binary search over
the directory and then reads that block alone:

| Field           | Type          | Description |
|-----------------|---------------|-------------|
| `key_count`     | varint        | `Q`, the number of keys. There are `ceil(Q / 2^top_block_exp)` blocks. |
| for each block: `first_key` | bytes, `NUL` | The key of the block's first entry, in UTF-8, followed by `NUL`. |
| for each block: `block_length` | varint | The byte length of the block. |

Blocks are stored consecutively in block order, so block `b` starts at
the sum of the lengths of blocks `0` to `b - 1`.

### B.7. File Layout

The file is a header followed by four sections, with no padding and no
trailer.

| Field                   | Type    | Description |
|-------------------------|---------|-------------|
| `signature`             | 8 bytes | The ASCII bytes `CGEODATA`, as in [Section 5](#5-header). |
| `version`               | varint  | Kind and version as defined in Section 5. This appendix specifies kind `1`, version `3`, so the value is `19` (`13`). Version `2` had no `relevance_rule` field, its short-query table always in Section B.5's order; a reader MUST reject it. Version `1` built the short-query table from the unfolded lowercase form and a different level bonus ordering (city highest, not country); a version-1 file is not just an older layout but a different, incompatible relevance order, and nothing in its bytes records which rule built it, since `source_checksum` covers only the place table, not the relevance rule -- a reader MUST reject it rather than answer queries with it. |
| `source_checksum`       | u64     | Checksum of the source file's place table ([Section B.8](#b8-source-checksum)). |
| `place_count`           | varint  | `N`, the number of places in the source. |
| `hash_exp`              | u8      | The number of hashed lists is `2^hash_exp` ([Section B.3](#b3-trigrams-and-lists)). MUST be from `1` to `24`. |
| `top_count`             | u8      | The number of places per short-query entry ([Section B.6](#b6-short-query-table)). `0` means the file has no short-query table. |
| `top_block_exp`         | u8      | Each table block holds `2^top_block_exp` entries. MUST be at most `24`. |
| `relevance_rule`        | u8      | The order of the short-query table ([Section B.6](#b6-short-query-table)): `0` for [Section B.5](#b5-relevance-order)'s, `1` for the area order of [Section B.5.1](#b51-area-order). Other values are reserved. Also decides what `source_checksum` covers ([Section B.8](#b8-source-checksum)). |
| `list_directory_length` | varint  | Byte length of `list_directory`. |
| `lists_length`          | varint  | Byte length of `lists`. |
| `table_directory_length`| varint  | Byte length of `table_directory`. |
| `list_directory`        | bytes   | See below. |
| `lists`                 | bytes   | The stored lists, in increasing list index, each in its encoding ([Section B.4](#b4-list-encoding)). |
| `table_directory`       | bytes   | The table directory of Section B.6. Empty when `top_count` is `0`. |
| `table_blocks`          | bytes   | The table blocks of Section B.6, in block order. They run to the end of the file. Empty when `top_count` is `0`. |

The list directory records which lists are stored and how long each
one is:

| Field      | Type                  | Description |
|------------|-----------------------|-------------|
| `presence` | `ceil(L / 8)` bytes   | Bit `l` is `1` if list `l` is stored, that is, if it is not empty. Bit `l` is in byte `l >> 3`, at bit position `l & 7`, least significant bit first. Bits for `L` and beyond in the last byte MUST be `0`. |
| `entries`  | one varint per stored list | In increasing list index: `length × 2 + encoding`, where `length` is the byte length of the stored list and `encoding` is `0` for an ID list and `1` for a bitmap. |

List `l`, if stored, starts at the sum of the lengths of the stored
lists with a smaller index. A reader computes all offsets with one pass
over `entries`. A list that is not stored is empty: no place has a
trigram with that list index.

Version `0` of kind `1` (value `16`) was an earlier bigram layout of
this index. Readers MUST reject it.

### B.8. Source Checksum

`source_checksum` binds an index to the place table it was built from.
It is the 64-bit FNV-1a hash [FNV] of exactly the `place_table_length`
bytes of the source file's place table ([Section 7.2](#72-layout)),
starting at the first byte after `chunk_lengths`
([Section 6.2](#62-layout)):

```
h = 0xcbf29ce484222325
for each byte b of the place table, in file order:
    h = h xor b
    h = (h × 0x100000001b3) mod 2^64
```

The result is stored as a `u64`, least significant byte first. Test
vectors: the empty input hashes to `cbf29ce484222325`, the single byte
`a` to `af63dc4c8601ec8c`, and the ASCII text `foobar` to
`85944171f73967e8`.

Only the place table is covered, not the whole source file, for two
reasons. The index depends on nothing else, so a source rebuilt with
different chunk parameters, or with some chunks left empty, keeps the
same index valid. And verifying the checksum then reads only the place
table, which stays small (about 2 MiB for the worldwide file at the
recommended `keyframe_exp` of [Section 7.3](#73-name-blocks)), rather
than every chunk.

A short-query table in area order (`relevance_rule = 1`) depends on the
areas of [Section C.3](#c3-representative-cell) as well, which depend on
the chunks. For such an index, `source_checksum` is instead the checksum
of [Section C.4](#c4-file-layout): of the source file from its first
byte up to the first chunk, which covers the chunk lengths.

Readers SHOULD compute the checksum of the source's place table (or
prefix) when they load an index, and a reader that does so MUST reject
an index whose `source_checksum` differs. A reader MAY skip the check where the
build pipeline guarantees the pairing, but it then has no protection
against a stale index, which silently misses places whose names were
added or changed after the index was built. The checksum detects
accidental mismatches; it is not a defence against a deliberately
crafted index ([Section B.10](#b10-robustness)).

FNV-1a was chosen over a cryptographic hash because it is a dozen lines
of integer arithmetic in any language and needs no library. In
JavaScript, where 64-bit integers are not native, the multiplication is
convenient to implement on two 32-bit halves: because the prime is
`2^40 + 0x1b3`, `h × prime` is `(h << 40) + h × 0x1b3`, and `h << 40`
only ever contributes `low32(h) << 8` to the high half.

### B.9. Query Procedure

To search for a query text:

1. **Short queries.** Let `q` be the folded form of the query
   ([Section B.2](#b2-symbol-folding)). If `q` is one or two code points
   long, the search asks for results in the relevance order that
   `relevance_rule` names, with a limit of at most `top_count` and no
   restriction by level or parent, `top_count` is not `0`, the query
   has no comma ([Section B.13](#b13-qualified-queries)), and `q`
   already equals the plain lowercase form of the query (i.e. the query
   has no diacritic of its own to fold --
   [Section B.6](#b6-short-query-table) explains why this matters), then
   look `q` up in the short-query table: find the last block whose
   `first_key` is at most `q`, read that block, and scan it for `q`. The
   result is the first `limit` places of its entry, or nothing if `q` is
   not a key. Stop.
2. **Fold the query** further, with step 4 of
   [Section B.2](#b2-symbol-folding), into a symbol sequence
   `s_0 .. s_{m-1}`. If `m < 3`, the query has no trigram and the lists
   cannot help: compare every name without the index, and stop.
3. **Collect the distinct list indices** of the query's trigrams
   ([Section B.3](#b3-trigrams-and-lists)). If any of them is not
   stored, no place can match: the result is empty.
4. **Intersect the lists.** The candidates are the places present in
   every one of them. A reader SHOULD start from the shortest stored
   list and MAY stop as soon as the intersection is empty. An ID list
   is intersected by merging two sorted sequences; a bitmap by testing
   one bit per remaining candidate.
5. **Confirm each candidate** by comparing its names with the query, as
   the reader would without the index, and report the confirmed ones.
   Candidates come out in increasing ID order, which is the order of a
   search without relevance ranking.

A qualified query ([Section B.13](#b13-qualified-queries)) takes steps 2
to 4 once for the head of each of its readings: the candidates of the
query are the union of the candidates of its heads, and if any head has
no trigram, every name is compared.

The lists never lose a match, under the following condition. Say a
reader matches a name against a query when the name's symbol sequence
contains the query's symbol sequence as a (contiguous) subsequence --
the comparison the trigram lists are actually built from. Then a
matching name contains every trigram of the query's symbol sequence, so
the place is present in every list of step 4 and is examined in step 5.
A reader whose comparison is stricter than this inherits the guarantee,
since everything it accepts is also accepted by the symbol-sequence
comparison. The folded-form substring match of
[Section B.5](#b5-relevance-order) is one such stricter comparison: step
4 of Section B.2 maps each folded-form code point to one symbol, so a
folded-form substring relationship survives into the symbol sequence
unchanged, the same argument Section B.2 makes for why neither folding
stage ever loses a match the other would find. A reader whose comparison
is looser, for example one that tolerates a missing or transposed
character, or that matches across the `|` between fields, does not
inherit the guarantee, and MUST NOT use the index for such queries. In
particular, a reader that ranks by tokens MUST only rank places that
match as a folded substring, as Section B.5 requires; ranking a place
whose tokens match but whose names do not contain the query as a folded
substring would make results depend on the index. The exotic cases in
which lowercasing and decomposition do not commute are not known to
affect any place name.

The short-query table of step 1 is exact rather than an
over-approximation: its entries are the answer. A reader SHOULD still
confirm that each place of an entry matches `q`, which costs at most
`top_count` name lookups, and drop any that do not.

### B.10. Robustness

A search index file may come from an untrusted source, or may be stale.
Readers MUST NOT assume that it is well formed or that it matches its
source.

- Readers MUST verify the signature, kind, and version before
  interpreting any other field, and MUST reject `hash_exp` outside `1`
  to `24`, `top_block_exp` above `24`, and a `relevance_rule` other than
  `0` or `1`.
- Readers MUST check that the header's section lengths add up to at
  most the file length, and that `list_directory_length` equals
  `ceil(L / 8)` plus the length of `entries`, where the number of
  entries is the number of `1` bits in `presence`.
- Readers MUST check that the lengths in `entries` add up to
  `lists_length`, that every bitmap is exactly `ceil(N / 8)` bytes, and
  that every block length in the table directory lies within
  `table_blocks`.
- Readers MUST check that `place_count` equals `N`, the number of places
  in the source, and MUST reject any place ID in a list or table entry
  that is not less than `N`, and any ID list that is not strictly
  increasing.
- Readers MUST confirm every trigram candidate by comparing its names.
  Given this, a malformed or mismatched list can cause missed results
  and wasted work, but never a wrong result. A malformed short-query
  table can reorder or omit results; confirming its places, as
  Section B.9 recommends, keeps it from adding a wrong one.
- Nothing in the file is compressed, so there is no decompression to
  bound. The allocations a query needs are bounded by the lengths of the
  sections and lists it reads, which are bounded by the file length.

### B.11. Choosing Parameters

This section is informative. The measurements were taken on the
worldwide file (239 countries, 5,469 regions, 313,732 cities), with a
reader that opens the source afresh for every query, as a search box
queried only occasionally would: nothing is cached except by the
operating system. Each query asks for the top five places in relevance
order and resolves them to their parents.

**Hashed lists.** With `hash_exp = 15` the file holds 32,768 hashed
lists beside the 21,952 Latin ones; the presence bitmap is 6.7 KiB, and
a query of a script other than Latin leaves about as few candidates as
a Latin one of the same length. With the 28-symbol folding of the
earlier bigram version, which mapped every non-Latin letter to the
separator, a three-letter Cyrillic, Arabic, or Chinese query left every
place with a non-Latin name, over 36,000 cities, as candidates.
`hash_exp = 15` is RECOMMENDED.

**Size.** The worldwide index is 4.2 MiB: 3.8 MiB of lists (36,317
stored), a 49 KiB list directory, and 362 KiB of short-query table.
Every trigram list turned out smaller as an ID list than as a bitmap:
an ID list costs about a byte per place, so a bitmap only wins for a
trigram shared by more than about one place in eight, which the
worldwide data does not have, but a small file (such as the example
below) does. The index is built in under three seconds.

**Speed.** How long a query takes depends far more on the source's
`keyframe_exp` ([Section 7.3](#73-name-blocks)) than on the index,
because confirming a candidate means inflating the name block it is in.
Mean times for random substrings of real city names, with and without
the index; every query opens the source and the index afresh, including
verifying the checksum (about 10 ms of each indexed query):

| `keyframe_exp` | Index | 1 character | 2 characters | 3 characters | 5 characters | 8 characters | 95th percentile |
|----------------|-------|-------------|--------------|--------------|--------------|--------------|-----------------|
| `13`           | yes   | 15 ms       | 13 ms        | 67 ms        | 24 ms        | 15 ms        | 88 ms           |
| `13`           | no    | 155 ms      | 127 ms       | 124 ms       | 123 ms       | 122 ms       | 169 ms          |
| `7`            | yes   | 11 ms       | 10 ms        | 26 ms        | 13 ms        | 12 ms        | 34 ms           |
| `7`            | no    | 181 ms      | 141 ms       | 138 ms       | 136 ms       | 135 ms       | 200 ms          |

The one- and two-character rows are answered by the short-query table.
Intersecting the lists takes well under a millisecond in every case; the
rest of a three-character query is confirming its candidates, of which
there are thousands for the commonest trigrams.

**Short-query table.** With `top_count = 5` the worldwide table has
25,497 keys and takes 365 KiB. It replaces the whole-table
scan that one- and two-character queries otherwise need, for the
common case of a search box that shows the top few matches.
`top_count = 5` and `top_block_exp = 6` (blocks of 64 keys, roughly
1 KiB each) are RECOMMENDED. A reader asked for more results, or for
results restricted by level or parent, falls back to the scan for these
queries.

**Why trigrams.** Bigrams (the earlier version of this index) are
common enough that a query leaves several times more candidates than
with trigrams, and with bigrams pooled into groups of places to keep
the file small, more again: for Latin queries of three or more
characters with on average 530 true matches among the cities, the
earlier layout left 3,500 cities as candidates, where trigrams leave
650. Longer n-grams would narrow queries of four or more characters
further, but these are already fast, and would serve no query of
three.

### B.12. Worked Example

This example indexes the source file of
[Appendix A](#appendix-a-worked-example) with `hash_exp = 4`,
`top_count = 2`, and `top_block_exp = 4`: small parameters, so that
the example is short but still has several table blocks. Its
short-query table is in Section B.5's order (`relevance_rule = 0`). The
seven places and their name fields are:

| ID | Level   | Fields                        |
|----|---------|-------------------------------|
| 0  | country | `Nederland`, `The Netherlands` |
| 1  | country | `België`, `Belgium`           |
| 2  | region  | `Noord-Holland`               |
| 3  | region  | `Antwerpen`, `Antwerp`        |
| 4  | city    | `Amsterdam`                   |
| 5  | city    | `Zaandam`                     |
| 6  | city    | `Antwerpen`, `Antwerp`        |

`L = 21952 + 2^4 = 21968`, so `presence` is `2746` bytes. `N = 7`, so a
bitmap is `1` byte, and any list of two or more places is stored as a
bitmap, since its ID list would take two bytes or more. The file is
`3202` bytes: a 26-byte header, a `2793`-byte list directory, `47` bytes
of lists, a `16`-byte table directory, and `320` bytes of table blocks.

#### B.12.1. Header (26 bytes)

```
43 47 45 4f 44 41 54 41   signature "CGEODATA"
13                        version 19 -> kind 1 (text search index), version 3
9f e6 00 b9 37 18 dc 77   source_checksum 0x77dc1837b900e69f
07                        place_count 7
04                        hash_exp 4 -> 16 hashed lists, L = 21968
02                        top_count 2
04                        top_block_exp 4 -> 16 entries per table block
00                        relevance_rule 0 -> Section B.5's order
e9 15                     list_directory_length 2793
2f                        lists_length 47
10                        table_directory_length 16
```

The checksum is the FNV-1a 64 hash of the 109 bytes of the place table
in [Section A.3](#a3-place-table-109-bytes), that is the bytes at file
offsets `22` to `130` of the Appendix A file, from the `02` of
`country_count` to the `6c` that ends block `1`.

#### B.12.2. Lists

Every name folds to Latin symbols only (`België` becomes `belgie`), so
no hashed list is used. The 47 stored lists, in list index order, are
below; `-` stands for the separator symbol `26`. "Bit" is the `presence`
byte and bit that mark the list as stored, "Entry" is its varint in
`entries`, and "Stored" is the list itself.

| Trigram | `l`   | Bit          | Entry | Stored      | Places |
|---------|-------|--------------|-------|-------------|--------|
| `aan`   | 13    | 1: `20`      | `02`  | IDs `05`    | 5 |
| `ams`   | 354   | 44: `04`     | `02`  | IDs `04`    | 4 |
| `and`   | 367   | 45: `80`     | `03`  | bitmap `25` | 0, 2, 5 |
| `ant`   | 383   | 47: `80`     | `03`  | bitmap `48` | 3, 6 |
| `bel`   | 907   | 113: `08`    | `02`  | IDs `01`    | 1 |
| `dam`   | 2364  | 295: `10`    | `03`  | bitmap `30` | 4, 5 |
| `der`   | 2481  | 310: `02`    | `02`  | IDs `00`    | 0 |
| `d-h`   | 3087  | 385: `80`    | `02`  | IDs `02`    | 2 |
| `ede`   | 3224  | 403: `01`    | `02`  | IDs `00`    | 0 |
| `elg`   | 3450  | 431: `04`    | `02`  | IDs `01`    | 1 |
| `erd`   | 3615  | 451: `80`    | `02`  | IDs `04`    | 4 |
| `erl`   | 3623  | 452: `80`    | `02`  | IDs `00`    | 0 |
| `erp`   | 3627  | 453: `08`    | `03`  | bitmap `48` | 3, 6 |
| `eth`   | 3675  | 459: `08`    | `02`  | IDs `00`    | 0 |
| `e-n`   | 3877  | 484: `20`    | `02`  | IDs `00`    | 0 |
| `gie`   | 4932  | 616: `10`    | `02`  | IDs `01`    | 1 |
| `giu`   | 4948  | 618: `10`    | `02`  | IDs `01`    | 1 |
| `her`   | 5617  | 702: `02`    | `02`  | IDs `00`    | 0 |
| `he-`   | 5626  | 703: `04`    | `02`  | IDs `00`    | 0 |
| `hol`   | 5891  | 736: `08`    | `02`  | IDs `02`    | 2 |
| `ium`   | 6844  | 855: `10`    | `02`  | IDs `01`    | 1 |
| `lan`   | 8637  | 1079: `20`   | `03`  | bitmap `05` | 0, 2 |
| `lgi`   | 8800  | 1100: `01`   | `02`  | IDs `01`    | 1 |
| `lla`   | 8932  | 1116: `10`   | `02`  | IDs `02`    | 2 |
| `mst`   | 9931  | 1241: `08`   | `02`  | IDs `04`    | 4 |
| `nda`   | 10276 | 1284: `10`   | `02`  | IDs `05`    | 5 |
| `nds`   | 10294 | 1286: `40`   | `02`  | IDs `00`    | 0 |
| `ned`   | 10307 | 1288: `08`   | `02`  | IDs `00`    | 0 |
| `net`   | 10323 | 1290: `08`   | `02`  | IDs `00`    | 0 |
| `noo`   | 10598 | 1324: `40`   | `02`  | IDs `02`    | 2 |
| `ntw`   | 10746 | 1343: `04`   | `03`  | bitmap `48` | 3, 6 |
| `oll`   | 11295 | 1411: `80`   | `02`  | IDs `02`    | 2 |
| `oor`   | 11385 | 1423: `02`   | `02`  | IDs `02`    | 2 |
| `ord`   | 11455 | 1431: `80`   | `02`  | IDs `02`    | 2 |
| `pen`   | 11885 | 1485: `20`   | `03`  | bitmap `48` | 3, 6 |
| `rda`   | 13412 | 1676: `10`   | `02`  | IDs `04`    | 4 |
| `rd-`   | 13438 | 1679: `40`   | `02`  | IDs `02`    | 2 |
| `rla`   | 13636 | 1704: `10`   | `02`  | IDs `00`    | 0 |
| `rpe`   | 13752 | 1719: `01`   | `03`  | bitmap `48` | 3, 6 |
| `ste`   | 14648 | 1831: `01`   | `02`  | IDs `04`    | 4 |
| `ter`   | 15025 | 1878: `02`   | `02`  | IDs `04`    | 4 |
| `the`   | 15096 | 1887: `01`   | `02`  | IDs `00`    | 0 |
| `twe`   | 15516 | 1939: `10`   | `03`  | bitmap `48` | 3, 6 |
| `wer`   | 17377 | 2172: `02`   | `03`  | bitmap `48` | 3, 6 |
| `zaa`   | 19600 | 2450: `01`   | `02`  | IDs `05`    | 5 |
| `-ho`   | 20594 | 2574: `04`   | `02`  | IDs `02`    | 2 |
| `-ne`   | 20752 | 2594: `01`   | `02`  | IDs `00`    | 0 |

All other `presence` bytes are `00`. The entries and the lists are the
"Entry" and "Stored" columns concatenated: `entries` is 47 bytes, one
varint per list, and `lists` is 47 bytes, since every stored list here
is one byte long. The ID list of a single place is its ID, since the
first delta is taken from `0`. The place table's `The Netherlands` and
`Noord-Holland` contribute the separator trigrams `e-n`, `he-`, `-ne`,
`d-h`, `rd-`, and `-ho`.

#### B.12.3. Short-Query Table

The names' folded forms contain 63 distinct strings of one or two code
points, so the table has four blocks: three of 16 entries and one of
15. The table directory (16 bytes) is:

```
3f                        key_count 63 -> 4 blocks
20 00  50                 block 0: first_key " ", block_length 80
65 20 00  51              block 1: first_key "e ", block_length 81
6c 67 00  52              block 2: first_key "lg", block_length 82
72 64 00  4d              block 3: first_key "rd", block_length 77
```

The entries, key followed by its places in relevance order:

```
block 0   " " 0      " n" 0     "-" 2      "-h" 2     "a" 0 4    "aa" 5
          "am" 4 5   "an" 0 5   "b" 1      "be" 1     "d" 0 4    "d-" 2
          "da" 4 5   "de" 0     "ds" 0     "e" 0 1
block 1   "e " 0     "ed" 0     "el" 1     "en" 6 3   "er" 0 4   "et" 0
          "g" 1      "gi" 1     "h" 0 2    "he" 0     "ho" 2     "i" 1
          "ie" 1     "iu" 1     "l" 0 1    "la" 0 2
block 2   "lg" 1     "ll" 2     "m" 1 4    "ms" 4     "n" 0 5    "nd" 0 5
          "ne" 0     "no" 2     "nt" 6 3   "o" 2      "ol" 2     "oo" 2
          "or" 2     "p" 6 3    "pe" 6 3   "r" 0 4
block 3   "rd" 4 2   "rl" 0     "rp" 6 3   "s" 0 4    "st" 4     "t" 0 4
          "te" 4     "th" 0     "tw" 6 3   "u" 1      "um" 1     "w" 6 3
          "we" 6 3   "z" 5      "za" 5
```

Block 0 is stored as these 80 bytes:

```
20 00 01 00  20 6e 00 01 00  2d 00 01 02  2d 68 00 01 02  61 00 02 00 04
61 61 00 01 05  61 6d 00 02 04 05  61 6e 00 02 00 05  62 00 01 01
62 65 00 01 01  64 00 02 00 04  64 2d 00 01 02  64 61 00 02 04 05
64 65 00 01 00  64 73 00 01 00  65 00 02 00 01
```

Some entries worked through Section B.5 (scores aren't stored, only the
ID order they produce, but are given here to show why):

- `en`: the region `Antwerpen` (ID 3) and the city `Antwerpen` (ID 6)
  both reach folded tier `10` (a substring match) and need no folding
  either, so both get the exact spelling bonus, quality `11`; the
  city's level bonus (`2`) still beats the region's (`1`), giving scores
  `13` and `12` -- the entry is `6 3`, not in ID order. (Country beating
  city and region at equal quality is the point of this version's level
  bonus; city still beats region here exactly as version 1's did, since
  neither place in this example is a country.)
- `h`: the country `Nederland` / `The Netherlands` (ID 0, matching via
  the `The Netherlands` field) and the region `Noord-Holland` (ID 2)
  both reach quality `11` the same way `en` does; the country's level
  bonus (`3`) beats the region's (`1`), giving scores `14` and `12` --
  the entry is `0 2`. Under version 1's level bonus (city `4`, region
  `2`, country `1`) this came out the other way, `2 0` -- a region used
  to outrank a country of equal quality, which this version's bonus
  ordering specifically fixes.
- `ie` and `iu` are both keys of the country `België` / `Belgium` (ID
  `1`) alone, reached in opposite ways. `ie` exists only in `België`'s
  folded form (`belgië` does not contain the literal substring `ie`,
  since its sixth letter is `ë` not `e`, and `belgium` does not contain
  it either), so it reaches quality `10`, no exact spelling bonus, score
  `13`; `iu` is a literal substring of `belgium` with no folding
  involved at all, quality `11`, score `14`. Both entries hold only ID
  `1`, so the difference isn't visible in the stored bytes, only in how
  each key was reached.
- `nl` is not a key, so a search for `nl` matches nothing, without
  reading any block beyond the one that would hold it.

#### B.12.4. Queries

**`dam`.** Folds to symbols `3, 0, 12`: the one trigram `dam`, list
`2364`, a bitmap `30`, places `4` and `5`. Both `Amsterdam` and
`Zaandam` contain `dam`, so both are confirmed.

**`dams`.** Trigrams `dam` (list `2364`, places `4`, `5`) and `ams`
(list `354`, place `4`). The intersection is place `4`, `Amsterdam`,
whose names do not contain `dams`: it is rejected and the search
reports nothing. The lists passed it because a trigram set discards
where the trigrams occur: `Amsterdam` has both, just not overlapping as
in `dams`.

**`antwerp`.** Trigrams `ant`, `ntw`, `twe`, `wer`, `erp`, all with
bitmap `48` (places `3` and `6`). Both are confirmed, and in relevance
order the city (quality `41`, an exact match of the field `Antwerp`
needing no folding, score `41 + 2 = 43`) comes before the region
(quality `41`, score `41 + 1 = 42`).

**`belgie`, sorted.** Typed without the diaeresis. Trigrams `bel`,
`elg`, `lgi`, `gie`, all list `België`'s country alone (places `1`'s
lists -- see B.12.2). `België`'s folded form, `belgie`, equals the
query exactly: folded tier `40`. The *unfolded* comparison, `belgië`
against `belgie`, does not reach even a substring match (`belgië`
does not contain `belgie` literally -- nor does `Belgium`, whose sixth
letter is `u`, not `e`), so the exact spelling bonus does not apply:
quality stays `40`, score `43`. A reader with no folding at all (version
1, or plain case-insensitive matching) would have found nothing here,
since neither field contains `belgie` literally. Querying `belgië`
instead (typed correctly) matches `België`'s own field without any
folding needed, reaching quality `41`, score `44` -- a query a
non-folding reader would also have found, since it's byte-identical to
the stored field after lowercasing alone. This reader answers both
queries, by folding for the first and plain matching for the second,
and ranks the correctly-spelled one slightly higher.

**`Zaan-dam`.** Folds to `z a a n - d a m`. The trigrams `an-`
(list `390`), `n-d` (`10923`), and `-da` (`20468`) are not stored, so
nothing can match and no list needs to be read at all: step 3 of
Section B.9 ends the search. This is correct, since no name contains
`zaan-dam`.

**`a`, sorted, limit 2.** One code point, and its folded form equals its
plain lowercase form (step 1 of Section B.9 applies, per Section B.6's
restriction): `a` is in block 0 (the last block whose first key, `" "`,
is at most `a`), and its entry is `0 4`, the country `Nederland` (field
`Nederland` matches `a` at quality `11`, score `11 + 3 = 14`) ahead of
the city `Amsterdam` (quality `11`, score `11 + 2 = 13` -- `Zaandam`
ties it but loses the ID tie-break). Under version 1's level bonus this
entry was `4 5`, `Amsterdam` and `Zaandam`, since a country was worth
less than either city. A search for `a` in ID order, or with a limit
above 2, instead compares every name.

Built in area order instead (`relevance_rule = 1`, from the area bytes
of [Section C.8](#c8-worked-example)), the entry of `a` is `0 2`: the
country still comes first, then `Noord-Holland`, whose area byte `14`
is larger than `Zaandam`'s `5`, while `Amsterdam` has none. That
index's `source_checksum` is the one of Section C.8.1,
`0x334bf7a76cac66ea`. A reader that ranks by Section B.5's order cannot
use that table, and compares every name instead.

**`ë`, sorted, limit 1.** Its folded form, `e`, differs from its plain
lowercase form, `ë` itself, so step 1 does NOT apply here even though
`e` is a key (Section B.6) -- comparing against the key `e`'s own
precomputed entry (`0 1`, from B.12.3 above) would silently drop the
exact spelling bonus `België`'s own `belgië` field earns against the
*literal* query `ë`: `belgië` contains `ë`, reaching folded tier `10`
*and* the bonus (the raw comparison also reaches tier `10`, since
`belgië` literally contains `ë`), quality `11`, score `11 + 3 = 14`.
`Nederland` / `The Netherlands` reaches only folded tier `10` with no
bonus (neither field contains a literal `ë`), quality `10`, score
`10 + 3 = 13`. Scored this way, `België` (`14`) outranks `Nederland`
(`13`) outright -- the key `e`'s own precomputed entry, built by
scoring `e` (not `ë`) as the query, has them the other way around
(`0 1`, `Nederland` first) precisely because `e` itself, being
diacritic-free, never earns `België`'s field the bonus the way the
literal query `ë` does. Trusting the key's entry here would report
`Nederland` as the top match for `ë`, the wrong answer. The query
instead falls through to step 2: it folds to one symbol (one short of a
trigram), so the lists cannot help either, and every name is compared
directly, correctly placing `België` first.

### B.13. Qualified Queries

A search box is often typed into as `Paris, Texas`: a place, then a
place it lies in. A reader MAY treat a query that contains a comma
(`,`, U+002C) as a **qualified query**, which has several
**readings**:

- the whole query as given, with no contexts, so that a place whose own
  name contains a comma, such as `Stormont, Dundas and Glengarry
  Counties`, is still found by typing its name;
- for each comma in the query, a reading whose **head** is the text
  before that comma and whose **contexts** are the parts after it,
  divided at the remaining commas. White space (Unicode `White_Space`)
  is removed from both ends of the head and of every context, and
  contexts that are then empty are dropped, so that `Paris,`, typed on
  the way to `Paris, Texas`, reads as `Paris`. A reading whose head is
  empty is dropped, as is one identical to an earlier reading.

A place matches a reading when its name entry matches the head
([Section B.5](#b5-relevance-order)) and every context matches the name
entry of one of the place's ancestors
([Section 7.1](#71-identifiers-and-hierarchy)), each context a further
ancestor than the one before it, nearest first: for a city, the first
context may match its region or its country, and a second only its
country. A reading with more contexts than the place has ancestors does
not match it. A place matches a qualified query when it matches any of
its readings.

For ranking, a place's quality is that of the head against its own name
entry, and its **context quality** is the sum of the qualities of the
contexts against the ancestors they match, under the assignment of
contexts to ancestors that gives the highest sum. Among the readings a
place matches, the one that ranks first in the order being used counts.

Every head is matched as a query of its own, so the trigram lists never
lose a match of a reading, and a reader uses them head by head
([Section B.9](#b9-query-procedure)). The short-query table is not used
for a query with a comma.

For example, against the file of
[Appendix A](#appendix-a-worked-example), `zaandam, noord` has the
readings `zaandam, noord` (no contexts), which matches nothing, and
`zaandam` with the context `noord`, which matches `Zaandam`, whose
region `Noord-Holland` contains `noord`. `antwerp, antwerpen` matches
the city `Antwerpen`, whose region is `Antwerpen`, but not the region
`Antwerpen`, whose only ancestor is `België`. `zaandam, nederland,
noord` matches nothing, since the contexts are nearest first.

## Appendix C. Place Location Index

This appendix defines a **representative cell** for every place, a
cell near the middle of the place's area whose centre serves as the
place's coordinate, and an **area byte**, the size of that area on a
logarithmic scale, and specifies an OPTIONAL sidecar file that stores
both. The file is derived entirely from one CGEODATA file and carries
file kind `2` ([Section 5](#5-header)).

### C.1. Purpose and Properties

A place search that shows its results on a map, or hands them to an
application that wants a coordinate per result, needs a point for each
place. The file stores areas, not points, so the point has to be
derived from the chunks: [Section C.3](#c3-representative-cell) defines
it. Deriving it for one place means decoding every chunk that might
hold one of the place's cells, which at worldwide scale is every chunk,
about 1.5 seconds. The index described here stores the result for every
place, so that finding it costs one read of a few bytes. The area tells
an application how far to zoom a map in on the place, and lets a search
rank large places before small ones of the same name
([Section B.5.1](#b51-area-order)); computing it is as costly as the
cell.

The index has the following properties:

- **It is a cache, not a data source.** Every entry is the
  representative cell, and every area byte the area byte, of
  [Section C.3](#c3-representative-cell), which a reader can compute
  from the source file alone. A reader MUST produce the same result with
  and without the index. The one exception is search ranking: a reader
  that ranks by area ([Section B.5.1](#b51-area-order)) only while an
  index supplies the areas orders its search results differently
  without one, though it finds the same places.
- **It is a pure function of its source.** Two writers given the same
  source file MUST produce byte-identical files. The file carries no
  timestamp and no parameter chosen by the writer. It is bound to its
  source by a checksum ([Section C.4](#c4-file-layout)).
- **It is uncompressed and fixed-width.** Entry `id` is at a computed
  offset, so a lookup reads exactly one entry and a reader needs to keep
  nothing but the header in memory between lookups.
- **It is disposable.** It can be rebuilt from its source at any time,
  and a reader that lacks it computes the same cells from the chunks.

### C.2. Entries

An **entry** names one cell of the source file, or no cell at all. It
is an unsigned integer. Let `B = width_exp + height_exp`, so that a
chunk index fits in `B` bits. The entry for the cell of depth `d` whose
chunk index is `i` ([Section 6.1](#61-chunk-grid)) and whose stored code
is `code` ([Section 8.1](#81-cell-grid-and-morton-codes)) is

```
entry = 2^(B + 2d) + i × 4^d + (code >> 2(D - d))
```

that is, a single `1` bit (the **marker**), followed by the `B` bits of
the chunk index, followed by the cell's `2d`-bit path from the top of
the chunk's quadtree. The entry `0` has no marker and means that the
place has no cells. A reader decodes a non-zero entry as follows:

1. Let `t` be the position of the most significant `1` bit, so that
   `2^t <= entry < 2^(t+1)`.
2. `t - B` MUST be even, and between `0` and `2D` inclusive. Otherwise
   the entry is invalid. The depth is `d = (t - B) / 2`.
3. Let `rest = entry - 2^t`. The chunk index is `i = rest >> 2d`, and
   the stored code is `(rest mod 4^d) << 2(D - d)`.

Since `rest < 2^(B + 2d)`, the chunk index is always less than
`W × H`. The largest entry, for a cell of depth `D`, has
`B + 2D + 1` bits, so every entry of a file fits in

```
entry_width = ceil((width_exp + height_exp + 2 × max_depth + 1) / 8)
```

bytes, which is what the index uses for all of them. For a `64 × 64`
chunk grid this is 4 bytes up to `max_depth = 9`, 5 bytes up to
`max_depth = 13`, and 6 bytes up to `max_depth = 17`. A reader whose
integers are exact only up to `2^53`, such as one in JavaScript, can
handle entries of up to 6 bytes and MAY reject an index with wider
ones. The marker is what lets one width serve cells of
every depth, and lets `0` stand for no cell without reserving any
valid cell's value.

Writers following this version store only full-precision cells
(`d = D`), as [Section C.3](#c3-representative-cell) requires. Readers
MUST nevertheless accept an entry of any depth, so that a later version
can name coarser cells without a new layout.

### C.3. Representative Cell

The **area** of a place is the set of records, across all chunks,
attributed to that place or to a place under it: for a city, the
records whose palette entry is the city; for a region, those of the
region and of its cities; for a country, those of the country, its
regions, and their cities ([Section 7.1](#71-identifiers-and-hierarchy)).
Records with palette index `0` belong to no area. A place whose area is
empty has no representative cell, and its entry is `0`.

Each record of the area is placed on the global grid of full-precision
cells used by the lookup procedure ([Section 9](#9-lookup-procedure),
step 2). For a record with stored code `code` and depth `d` in chunk
`i = r × W + c`, let `(x, y)` be the cell whose full-precision code is
`code`, the south-west corner cell of the record. Then the record
covers the `s × s` square of global cells with south-west corner
`(gx, gy)`, where

```
gx = c × 2^D + x        gy = r × 2^D + y        s = 2^(D - d)
```

and it has **weight** `s × s`, its area in full-precision cells. The
representative cell is computed from these squares in four steps.

1. **Centres.** The centre of each square, in units of half a cell, is
   `u = 2 × gx + s` horizontally and `v = 2 × gy + s` vertically. Both
   are integers.
2. **Weighted median per axis.** Let `T` be the total weight of the
   area. For the `u` axis, let `lo` be the smallest centre `u` for which
   the weight of all squares with centre at most `u` is at least `T / 2`.
   If that weight is exactly `T / 2`, let `hi` be the smallest centre
   greater than `lo`, which exists because the remaining weight is
   positive. Otherwise let `hi = lo`. The median lies at `(lo + hi) / 2`
   half-cells, in the full-precision cell column

   ```
   fx = floor((lo + hi) / 4)
   ```

   The same procedure on the `v` centres gives the row `fy`. With equal
   weights this is the familiar median: the middle value of an odd
   count, and the midpoint of the two middle values of an even one.
3. **Nearest cell of the area.** For every square, its cell nearest to
   `(fx, fy)` is `(clamp(fx, gx, gx + s - 1), clamp(fy, gy, gy + s - 1))`,
   at offset `(dx, dy)` from `(fx, fy)`. Its squared distance is

   ```
   (a × dx)^2 + (b × dy)^2      where  g = min(2 × H, W),  a = 2 × H / g,  b = W / g
   ```

   which is proportional to the squared distance in degrees, a
   full-precision cell being `360 / (W × 2^D)` degrees wide and
   `180 / (H × 2^D)` high. The representative cell is the nearest of
   these cells. Among equally near cells, it is the one in the lower
   row, and among those, the one in the lower column. When `(fx, fy)`
   itself lies in the area, it is the only cell at distance `0`, and so
   it is the representative cell.
4. **Entry.** The representative cell `(px, py)` is the full-precision
   cell `x = px mod 2^D`, `y = py mod 2^D` of chunk
   `i = (py >> D) × W + (px >> D)`, and its entry is formed as in
   [Section C.2](#c2-entries) with `d = D`.

The representative cell always lies within one of the area's records,
so a lookup ([Section 9](#9-lookup-procedure)) of any point in it, in
particular its centre, resolves to the place or to a place under it.
The result depends only on the set of records in the area, not on the
order in which they are visited.

The **area byte** of a place is `0` when its area is empty. Otherwise it
is the number of binary digits of `T^4`, where `T` is the total weight
of step 2, but at most `255`:

```
area_byte = min(255, floor(log2(T^4)) + 1)
```

Each step is a quarter of a doubling: an area of `T` cells has area byte
`v` when `2^((v - 1) / 4) <= T < 2^(v / 4)`, so a reader can recover the
area to within about 9%. Implementations MUST compute it exactly, for
example by counting the bits of `T^4` in integer arithmetic, since a
floating-point logarithm can round the wrong way for an area just below
a power of two. A `128 × 128` chunk grid with `max_depth = 10` has
`2^34` full-precision cells, area byte `137`; the cap of `255` is only
reached by an area of `2^63.5` cells or more.

Every quantity above is an integer, and implementations MUST compute
them exactly. The largest is a squared distance, which is less than
`(a × W × 2^D)^2 + (b × H × 2^D)^2`; an implementation whose integers
are exact only up to `2^53`, such as one in JavaScript, SHOULD check
this bound before computing any representative cell. It holds for a
`64 × 64` chunk grid up to `max_depth = 19`.

Informally: the median locates the middle of the place along each axis
independently, weighting every cell by its area. Unlike the mean, it is
not dragged away by a distant exclave or island. Unlike the centre of
the bounding box, it follows where the area actually is. When the
median point falls outside the place, as it can for a crescent-shaped
area or one made of several islands, step 3 moves it to the nearest
cell that is inside. Two known imperfections follow from working on
the grid: weights are areas in degrees, not on the ground, so cells at
high latitude count for more than their true size, in the area byte as
much as in the median; and the horizontal
axis does not wrap, so the median of a place that straddles the 180th
meridian lands on one side of it rather than in the middle.

### C.4. File Layout

The file is one header followed by the entries and the area bytes,
with no padding and no trailer.

| Field             | Type                         | Description |
|-------------------|------------------------------|-------------|
| `signature`       | 8 bytes                      | The ASCII bytes `CGEODATA`, as in [Section 5](#5-header). |
| `version`         | varint                       | Kind and version as defined in Section 5. This appendix specifies kind `2`, version `1`, so the value is `33` (`21`). Version `0` had no `areas`; readers MUST reject it. |
| `source_checksum` | u64                          | Checksum of the start of the source file, defined below. |
| `entry_width`     | u8                           | The width in bytes of every entry. MUST equal the value given in [Section C.2](#c2-entries) for the source's header. |
| `place_count`     | varint                       | `N`, the number of places in the source ([Section 7.1](#71-identifiers-and-hierarchy)). |
| `entries`         | `N × entry_width` bytes      | The entry of place `0`, then of place `1`, and so on, each an unsigned little-endian integer of `entry_width` bytes. |
| `areas`           | `N` bytes                    | The area byte ([Section C.3](#c3-representative-cell)) of place `0`, then of place `1`, and so on. |

The file length MUST be exactly the header length plus
`N × (entry_width + 1)`. The entry of place `id` starts at byte
`header_length + id × entry_width`, and its area byte is at
`header_length + N × entry_width + id`. The area bytes follow the
entries rather than being part of them so that a reader ranking a
search by area reads all of them in one read.

`source_checksum` is the 64-bit FNV-1a hash
([Section B.8](#b8-source-checksum)) of the first bytes of the source
file up to, but not including, the first chunk: the header, the
directory, and the place table, that is file offsets `0` to
`chunks_start - 1` ([Section 6.3](#63-locating-a-chunk)). It is stored
least significant byte first.

The index depends on the chunks as well as on the place table, so the
checksum of [Section B.8](#b8-source-checksum), which covers only the
place table, would not do. Hashing the chunks themselves would make
loading an index read the whole source file. The directory is a
compromise: it holds the length of every compressed chunk, which
changes whenever the chunk's content does, except in the unlikely case
that a rebuilt chunk compresses to exactly its old length. Writers that
rebuild a source SHOULD rebuild its index at the same time rather than
rely on the checksum to catch the difference.

Readers SHOULD compute the checksum when they load an index, and a
reader that does so MUST reject an index whose `source_checksum`
differs from it. A reader that rejects an index falls back to computing
representative cells from the chunks.

### C.5. Lookup Procedure

To find the representative coordinate of place `id` with an index:

1. **Validate.** `id` MUST be less than `N`.
2. **Read the entry.** Read `entry_width` bytes at
   `header_length + id × entry_width` and interpret them as an unsigned
   little-endian integer.
3. **Decode** it as in [Section C.2](#c2-entries). An entry of `0`
   means the place has no representative cell, and no coordinate.
4. **Compute the coordinate.** The cell's extent follows from its chunk
   ([Section 6.1](#61-chunk-grid)) and its path within the chunk
   ([Section 8.1](#81-cell-grid-and-morton-codes)), as for any record.
   The place's coordinate is the centre of that extent.
5. **Read the area**, if wanted: the byte at
   `header_length + N × entry_width + id`.

Without an index, a reader computes the same cell and area byte from the
chunks by [Section C.3](#c3-representative-cell) and continues at
step 4.

A place of area byte `v` covers about `2^((v - 0.5) / 4)` full-precision
cells, each `360 / (W × 2^D)` degrees wide and `180 / (H × 2^D)` high.
A square of the same area in degrees is a rough guide to how far to zoom
a map in on the place: at zoom `z`, a Web Mercator map shows
`360 / 2^z` degrees of longitude across one 256-pixel tile.

The extent of the cell tells a reader how precisely to present the
coordinate: a full-precision cell of a worldwide file with
`max_depth = 8` is about `0.02°` wide, so three decimals are
meaningful and more are not.

### C.6. Robustness

A locate index may come from an untrusted source, or may be stale.
Readers MUST NOT assume that it is well formed or that it matches its
source.

- Readers MUST verify the signature, kind, and version before
  interpreting any other field.
- Readers MUST check that `entry_width` equals the value
  [Section C.2](#c2-entries) gives for the source, that `place_count`
  equals `N`, and that the file length is exactly the header length
  plus `N × (entry_width + 1)`, before reading any entry.
- Every byte is a valid area byte, so there is nothing to check. A
  wrong one only misorders search results ranked by area or misjudges a
  zoom level.
- Readers MUST reject an entry whose marker is not at a valid position
  ([Section C.2](#c2-entries), step 2). The decoding cannot produce a
  chunk index outside the grid, so no further bounds check is needed
  before computing the cell's extent.
- Unlike a search index, a locate index contributes its result directly:
  a malformed or mismatched index yields a wrong coordinate rather than
  a missed one. A reader that cannot trust the pairing MAY confirm a
  result by looking up its coordinate and checking that it resolves to
  the place or to a place under it, at the cost of decoding one chunk.

### C.7. Design Notes

This section is informative.

**Measurements.** On a worldwide file of 319,440 places with a
`64 × 64` chunk grid and `max_depth = 8` (9.5 MiB), entries are 4 bytes
and the index (of version `0`, without area bytes) is 1.2 MiB; the area
bytes add one byte per place, 0.3 MiB. Building it decodes the chunks two or three
times, since places are processed a batch of countries at a time to
bound memory, and takes about 11 seconds. Without the index, one representative cell
costs about 1.6 seconds, nearly all of it spent decoding chunks. With
it, a lookup takes well under a millisecond, even with the file evicted
from the operating system's cache, and a reader that is idle between
lookups holds nothing but an open file. An older worldwide build at
`max_depth = 11` (67 MiB, 255,555 places) needs 5-byte entries, for an
index of 1.2 MiB built in 2.5 minutes. A `128 × 128` grid with
`max_depth = 10` (71 MiB, 259,598 places) also needs 5-byte entries;
with its area bytes the index is 1.5 MiB, built in about 90 seconds,
of which totalling the areas takes a few.

**Alternatives measured.** Storing only the chunk of each place's cell
(2 bytes per place for a `64 × 64` grid) and decoding that chunk at
lookup time cost 4 to 6 ms per lookup, and about 50 ms for a burst of
ten, the typical page of search results; the time goes into decoding
the chunk, not reading it. With `max_depth = 11`, where chunks are
about ten times larger, it would cost tens of milliseconds per lookup.
Compressing the entries in blocks of 256 saved 30% of the size and
doubled the lookup time, since the cells of neighbouring places are
close but their low-order bits are not. Storing a coarser cell to save
bytes and refining it from the chunk at lookup time has the costs of
the chunk-only design for every place whose cell is deeper than the
coarse cell. Fitting 4-byte entries at `max_depth = 11` means coarsening
every cell deeper than depth 9, which was 16% of places, with chunk
decodes of 40 to 140 ms each.

**Why the whole area.** The records attributed directly to a region or
country are only the parts not covered by any of its children: often
nothing at all, and otherwise leftover strips such as water or
unincorporated land. On the worldwide file, 41% of regions have no
records of their own. Including the records of every place under a
place makes the coordinate of a region or country the middle of the
region or country, as a user expects.

### C.8. Worked Example

This example indexes the source file of
[Appendix A](#appendix-a-worked-example). There, `B = 1 + 1 = 2` and
`D = 2`, so entries have at most `2 + 4 + 1 = 7` bits and
`entry_width = 1`. The file is `19 + 7 = 26` bytes.

#### C.8.1. File (33 bytes)

```
43 47 45 4f 44 41 54 41   signature "CGEODATA"
21                        version 33 -> kind 2 (place location index), version 1
ea 66 ac 6c a7 f7 4b 33   source_checksum 0x334bf7a76cac66ea
01                        entry_width 1
07                        place_count 7
73 00 73 00 00 74 00      entries of places 0 to 6
0e 00 0e 00 00 05 00      areas of places 0 to 6
```

The checksum is the FNV-1a 64 hash of the first 131 bytes of the
Appendix A file: the 17-byte header, the 5-byte directory, and the
109-byte place table, up to the first byte of chunk `3` at offset
`131`.

#### C.8.2. Areas

All records are in chunk `3` (`c = 1`, `r = 1`), so `gx = 4 + x` and
`gy = 4 + y`. The four records with a place are:

| Record | Code, depth | Place            | `(gx, gy)` | `s` | Weight | `u`  | `v`  |
|--------|-------------|------------------|------------|-----|--------|------|------|
| 0      | 0, 1        | 2, Noord-Holland | (4, 4)     | 2   | 4      | 10   | 10   |
| 1      | 4, 2        | 5, Zaandam       | (6, 4)     | 1   | 1      | 13   | 9    |
| 3      | 8, 1        | 2, Noord-Holland | (4, 6)     | 2   | 4      | 10   | 14   |
| 4      | 12, 2       | 5, Zaandam       | (6, 6)     | 1   | 1      | 13   | 13   |

Record `2` has palette index `0`. The area of Zaandam (`5`) is records
`1` and `4`. The areas of Noord-Holland (`2`) and of Nederland (`0`),
which contains it, are all four records. Amsterdam, België, and both
Antwerpens have no records, so their entries are `00`.

#### C.8.3. Zaandam

`T = 2`. Both `u` centres are `13`, which already holds more than half
the weight, so `lo = hi = 13` and `fx = floor(26 / 4) = 6`. The `v`
centres are `9` and `13`, one weight each. The weight at or below `9`
is exactly `T / 2`, so `lo = 9`, `hi = 13`, and
`fy = floor(22 / 4) = 5`: the median falls midway between Zaandam's two
cells.

Cell `(6, 5)` is local cell `(2, 1)` of chunk `3`, code `6`, which has
no record. The nearest cells of the area are record `1`'s `(6, 4)` and
record `4`'s `(6, 6)`, both one row away. With `g = min(4, 2) = 2`,
`a = 2` and `b = 1`, both are at squared distance `1`. The tie goes to
the lower row, `(6, 4)`: local cell `(2, 0)` of chunk `3`, code `4`.
The entry is `2^(2 + 4) + 3 × 16 + 4 = 116`, `74`.

Its centre is `lat -90 + 4.5 × 22.5 = 11.25`,
`lon -180 + 6.5 × 45 = 112.5`, which is the cell of the first lookup in
[Section A.5](#a5-lookups), Zaandam.

#### C.8.4. Noord-Holland and Nederland

`T = 4 + 1 + 4 + 1 = 10`. The `u` centres are `10` with weight `8`
and `13` with weight `2`: `10` holds more than half, so
`fx = floor(20 / 4) = 5`. The `v` centres are `9` (weight `1`), `10`
(`4`), `13` (`1`), and `14` (`4`). The weight at or below `10` is `5`,
exactly half, so `lo = 10`, `hi = 13`, and `fy = floor(23 / 4) = 5`.

Cell `(5, 5)` is local cell `(1, 1)`, inside record `0`'s square, so it
is the representative cell. Its code at depth `2` is `3`, and the
entry is `64 + 48 + 3 = 115`, `73`. Its centre is `lat 33.75`,
`lon 67.5`, where a lookup finds record `0`: Noord-Holland, which is
the place itself for ID `2` and a place under it for ID `0`.

#### C.8.5. Decoding

Entry `74` is `116`. Its most significant bit is `t = 6`, and
`t - B = 4` is even and at most `2D = 4`, so `d = 2`.
`rest = 116 - 64 = 52`, the chunk index is `52 >> 4 = 3`, and the
stored code is `52 mod 16 = 4`. An entry of `75` (`117`) would decode
the same way to code `5`, a cell with no place: a well-formed entry is
not necessarily a correct one, which is what the checksum is for. An
entry of `20` (`32`) would be rejected, since `t - B = 3` is odd.

#### C.8.6. Area Bytes

Zaandam's area has `T = 2` (C.8.3). `T^4 = 16`, `10000` in binary, has
five digits, so its area byte is `05`: `2^(4/4) <= 2 < 2^(5/4)`.
Noord-Holland's and Nederland's have `T = 10` (C.8.4). `T^4 = 10000` lies
between `2^13 = 8192` and `2^14 = 16384`, so it has fourteen binary
digits and their area byte is `0e`. The four places without records
have area byte `00`.

A full-precision cell of this file is `45°` wide and `22.5°` high,
`1012.5` square degrees. Area byte `05` stands for about
`2^(4.5 / 4) × 1012.5 ≈ 2209` square degrees, against Zaandam's true
`2025`.

## Appendix D. References

- [RFC1950] Deutsch, P. and J-L. Gailly, "ZLIB Compressed Data Format
  Specification version 3.3", May 1996.
- [RFC1951] Deutsch, P., "DEFLATE Compressed Data Format Specification
  version 1.3", May 1996.
- [RFC2119] Bradner, S., "Key words for use in RFCs to Indicate
  Requirement Levels", BCP 14, March 1997.
- [RFC3629] Yergeau, F., "UTF-8, a transformation format of ISO 10646",
  STD 63, November 2003.
- [RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119
  Key Words", BCP 14, May 2017.
- Protocol Buffers, "Encoding: Base 128 Varints",
  <https://protobuf.dev/programming-guides/encoding/#varints>.
- Morton, G. M., "A computer oriented geodetic data base and a new
  technique in file sequencing", IBM, 1966.
- [UAX15] Whistler, K., "Unicode Normalization Forms", Unicode Standard
  Annex #15, <https://unicode.org/reports/tr15/>.
- [UNICODE] The Unicode Consortium, "The Unicode Standard", Section
  3.13 "Default Case Algorithms", <https://www.unicode.org/versions/latest/>.
- [FNV] Eastlake, D., Fowler, G., Noll, L., Vo, K-P., and T. Hansen,
  "The FNV Non-Cryptographic Hash Algorithm",
  draft-eastlake-fnv, <https://datatracker.ietf.org/doc/draft-eastlake-fnv/>.
- [history.md](https://github.com/ferrybig/loc-to-city/blob/master/history.md): the prototype and measurements this format
  is derived from.
