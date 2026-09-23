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
- [Appendix C. References](#appendix-c-references)

## 1. Introduction

### 1.1. Motivation

Reverse geocoding for photo management (see [README.md](README.md))
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
   without changing the file.
6. **Implementable with no dependencies in JavaScript** (Node.js and
   browsers) as well as other languages: only zlib, integer arithmetic,
   and binary search are required.

### 1.3. Non-Goals

- The format does not store polygon geometry and cannot answer
  distance-to-border or area queries.
- The format does not store a representative coordinate per place (see
  [Section 12](#12-open-issues)).
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
[Appendix B](#appendix-b-text-search-index), are separate files that
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
| `2`  | `32` to `47`       | Reserved for a place location index, which maps places to coordinates. Not yet specified. |

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
repetition in a larger block. An interval around `2^13` entries is
expected to be a reasonable compromise but has not been measured
carefully.

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
2. **No coordinate per place.** A place search that returns a location
   for each hit (as Immich's `searchPlaces` does) needs a representative
   point per place. The place table has no such field; a future version
   could add a delta-coded coordinate per entry, or a sidecar file of
   kind `2` ([Section 5](#5-header)) could carry it.
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
7. **Keyframe interval.** The suggested `2^13` has not been measured
   against real data.

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
compares it with the query. That is a linear scan over the name blocks
and, at worldwide scale, over a quarter of a million cities. The index
described here lets a reader discard most places without reading their
names: it records, for every place, which letter pairs occur in its
names, so that a query can eliminate every place that lacks even one of
the pairs the query contains.

The index has the following properties:

- **It is an accelerator, not a data source.** It never contributes a
  result by itself. A reader confirms every place the index leaves over
  by comparing its names, exactly as it would without the index, and
  MUST produce the same results with and without it.
- **It can only over-approximate.** Every step that maps names to index
  bits is many-to-one, so the set of places the index leaves over is a
  superset of the true matches ([Section B.7](#b7-query-procedure)).
- **It is a pure function of the place table.** Two writers given the
  same place table and the same parameters MUST produce byte-identical
  files. The file carries no timestamp, and no field whose value
  depends on the writer. It is bound to its source by a checksum over
  the source's place table ([Section B.6](#b6-source-checksum)).
- **It is uncompressed.** A query reads a handful of whole lists and
  combines them bitwise; compressing the lists would only mean
  inflating each one before use, so the lists are stored raw. This also
  lets a reader keep the file memory-mapped and read only the lists a
  query needs.
- **It is disposable.** Because it is derived, it can be rebuilt from
  its source at any time, and a reader that lacks it, or that finds it
  does not match its source, falls back to the linear scan.

### B.2. Symbol Folding

Names and queries are reduced to sequences of **symbols** from a fixed
alphabet of 28 values before they are indexed or looked up. The
procedure is:

1. Decompose the text into Unicode Normalization Form D [UAX15].
2. Remove every code point in the Combining Diacritical Marks block,
   `U+0300` to `U+036F` inclusive.
3. Convert the result to lowercase with the Unicode default case
   conversion (the locale-independent `toLowercase()` of [UNICODE]
   Section 3.13).
4. Map each remaining code point to one symbol:

| Code points                | Symbol   |
|----------------------------|----------|
| `a` to `z` (`U+0061`–`U+007A`) | `0` to `25` in alphabetical order |
| `0` to `9` (`U+0030`–`U+0039`) | `27`, the digit symbol |
| anything else              | `26`, the separator symbol |

Step 1 followed by step 2 turns `é` into `e`. Step 3 turns `E` into
`e`. Step 4 puts all digits in one bucket, and spaces, punctuation, and
every letter outside the basic Latin alphabet in another. The folding
is deliberately lossy: several characters may become the same symbol,
but one character never becomes more than one symbol, so any text that
contains another as a substring, contains it as a substring after
folding too. Writers and readers MUST use exactly this procedure; a
reader that folds differently from the writer loses the guarantee of
[Section B.7](#b7-query-procedure).

### B.3. N-grams and Lists

The index holds one bit list per **n-gram**, a run of `n` consecutive
symbols. `n` is stored in the header and is `1` or `2` in this version.
There are `L = 28^n` possible n-grams, hence `L` lists: `28` for `n = 1`,
`784` for `n = 2`.

The n-gram of symbols `s_0, s_1, ..., s_{n-1}` has **list index**

```
l = s_0 × 28^(n-1) + s_1 × 28^(n-2) + ... + s_{n-1}
```

so for `n = 2` the pair `(s_0, s_1)` is list `s_0 × 28 + s_1`.

The n-gram set of a place is the union, over every field of its name
entry ([Section 7.4](#74-name-entries)), of the n-grams of that field's
symbol sequence. Each field is folded separately; no n-gram spans the
`|` between two fields. A field shorter than `n` symbols contributes
nothing.

### B.4. Bit Lists and Groups

The index covers the `place_count` places with consecutive IDs
`first_id .. first_id + place_count - 1`. The **position** of a place is
`p = id - first_id`. Positions are pooled into **groups** of `group_size`
(written `G`) consecutive positions: group `g` covers positions
`g × G .. min((g + 1) × G, place_count) - 1`, and there are

```
bits_per_list  = ceil(place_count / G)
bytes_per_list = ceil(bits_per_list / 8)
```

groups. Bit `g` of list `l` is `1` if and only if at least one place in
group `g` has n-gram `l` in its n-gram set. With `G = 1` every place has
its own bit. With `G > 1` the bits of `G` places are OR-ed together,
which divides the file size by `G` at the cost of some places surviving
the index only because a neighbour in their group matched; these are
rejected when their names are compared.

Each list is `bytes_per_list` bytes. Bit `g` is stored in byte `g >> 3`
of its list, at bit position `g & 7`, least significant bit first: byte
`0` holds groups `0` to `7`, with group `0` in bit `0x01`. Bits beyond
`bits_per_list - 1` in the last byte MUST be `0`.

### B.5. File Layout

The file is one header followed by the lists, with no padding and no
trailer.

| Field             | Type                       | Description |
|-------------------|----------------------------|-------------|
| `signature`       | 8 bytes                    | The ASCII bytes `CGEODATA`, as in [Section 5](#5-header). |
| `version`         | varint                     | Kind and version as defined in Section 5. This appendix specifies kind `1`, version `0`, so the value is `16` (`10`). |
| `source_checksum` | u64                        | Checksum of the source file's place table ([Section B.6](#b6-source-checksum)). |
| `ngram`           | u8                         | `n`, the n-gram length. MUST be `1` or `2`; other values are reserved. |
| `group_size`      | varint                     | `G`, the number of places per bit. MUST be at least `1`. |
| `first_id`        | varint                     | The ID of the first indexed place. |
| `place_count`     | varint                     | The number of indexed places. |
| `lists`           | `L × bytes_per_list` bytes | List `0`, then list `1`, and so on up to list `L - 1`, each `bytes_per_list` bytes ([Section B.4](#b4-bit-lists-and-groups)). |

The file length MUST be exactly the header length plus
`L × bytes_per_list`. `L`, `bits_per_list`, and `bytes_per_list` are not
stored; they follow from `ngram`, `group_size`, and `place_count`.

Writers SHOULD index exactly the cities, that is `first_id = C + R` and
`place_count = N - C - R` in the terms of
[Section 7.1](#71-identifiers-and-hierarchy). Countries and regions are
few enough that scanning them linearly costs nothing measurable, and
leaving them out keeps the index a single contiguous ID range. A reader
MUST NOT assume this choice, and MUST compare the names of every place
outside `first_id .. first_id + place_count - 1` without the index.

### B.6. Source Checksum

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
table, which stays small (about 1.3 MiB for the worldwide file), rather
than every chunk.

Readers SHOULD compute the checksum of the source's place table when
they load an index, and a reader that does so MUST reject an index
whose `source_checksum` differs. A reader MAY skip the check where the
build pipeline guarantees the pairing, but it then has no protection
against a stale index, which silently misses places whose names were
added or changed after the index was built. The checksum detects
accidental mismatches; it is not a defence against a deliberately
crafted index, which is unnecessary because the index cannot add
results ([Section B.8](#b8-robustness)).

FNV-1a was chosen over a cryptographic hash because it is a dozen lines
of integer arithmetic in any language and needs no library. In
JavaScript, where 64-bit integers are not native, the multiplication is
convenient to implement on two 32-bit halves: because the prime is
`2^40 + 0x1b3`, `h × prime` is `(h << 40) + h × 0x1b3`, and `h << 40`
only ever contributes `low32(h) << 8` to the high half.

### B.7. Query Procedure

To search for a query text with an index whose parameters are `n`, `G`,
`first_id`, and `place_count`:

1. **Fold the query** with the procedure of
   [Section B.2](#b2-symbol-folding) into a symbol sequence
   `s_0 .. s_{m-1}`.
2. **Decide whether the index applies.** If `m < n`, the query has no
   n-gram and the index cannot help; compare every name without it and
   stop.
3. **Collect the distinct n-grams** of the query, and their list
   indices as defined in [Section B.3](#b3-n-grams-and-lists).
4. **AND the lists.** Copy the first list into a buffer of
   `bytes_per_list` bytes, then AND each remaining list into it byte by
   byte. Readers MUST NOT modify the stored lists in place: a buffer
   obtained by memory-mapping or by viewing a larger buffer is shared
   with the next query. If any list is entirely zero, the result is
   entirely zero, and a reader MAY stop early.
5. **Expand the groups.** Every bit `g` that is still set in the buffer
   makes the places at positions `g × G .. min((g + 1) × G, place_count) - 1`
   candidates, with IDs `first_id + position`.
6. **Confirm each candidate** by comparing its names with the query, as
   the reader would without the index, and report the confirmed ones.
7. **Scan the rest.** Compare the names of every place outside the
   indexed ID range without the index, and report the matches. A
   reader that reports results in ID order emits these in their place
   among the others.

The index never loses a match, under the following condition. Say a
reader matches a name against a query when the name contains the query
as a substring after both have been folded as in Section B.2. Then a
matching name contains every n-gram of the folded query, so the place
survives step 4 and is examined in step 6. A reader whose comparison is
stricter than folded substring containment, for example one that keeps
accents or case distinct, inherits the guarantee, since everything it
accepts is also accepted by the folded comparison. A reader whose
comparison is looser, for example one that tolerates a missing or
transposed character, or that matches across the `|` between fields,
does not, and MUST NOT use the index for such queries. A plain
case-insensitive substring comparison, such as lowercasing both sides
with the default Unicode case mapping, satisfies the condition for all
practical text; the exotic cases in which lowercasing and
decomposition do not commute are not known to affect any place name.

Step 4 dominates a query's cost and is independent of the query's
selectivity: it reads and combines one list of `bytes_per_list` bytes
per distinct n-gram. Step 6 costs one name-block access per candidate,
so the index pays off when the candidates are a small fraction of the
indexed places, which is the case for nearly all queries of three or
more characters ([Section B.9](#b9-choosing-parameters)).

### B.8. Robustness

A search index file may come from an untrusted source, or may be stale.
Readers MUST NOT assume that it is well formed or that it matches its
source.

- Readers MUST verify the signature, kind, and version before
  interpreting any other field, and MUST reject `ngram` values other
  than `1` and `2`, and `group_size` values of `0`.
- Readers MUST check that the file length is exactly the header length
  plus `L × bytes_per_list` before reading any list.
- Readers MUST check that `first_id + place_count` is at most `N`, the
  number of places in the source, so that no candidate ID falls outside
  the place table.
- Readers MUST confirm every candidate by comparing its names. Given
  this, a malformed or mismatched index can cause missed results and
  wasted work, but never a wrong result.
- The lists are stored raw, so there is no decompression to bound. The
  only allocation a query needs is one buffer of `bytes_per_list`
  bytes, which is bounded by the file length.

### B.9. Choosing Parameters

This section is informative.

**Group size.** Measured on a worldwide place table of roughly 245,000
cities, the bigram index (`n = 2`) has these sizes:

| `G`  | File size |
|------|-----------|
| 1    | 23 MiB    |
| 2    | 12 MiB    |
| 4    | 5.8 MiB   |
| 8    | 2.9 MiB   |
| 16   | 1.5 MiB   |
| 32   | 740 KiB   |
| 64   | 372 KiB   |

Against a set of typical search-box queries, `G = 4` gave the best mean
query time, `G = 8` was close behind, and from `G = 16` on the common
bigrams (`an`, `er`, `st`, ...) leave so many groups set that queries
built from them degrade towards the linear scan. With `G = 4`, queries
of three or more characters typically leave under 3% of the cities as
candidates and run 50 to 200 times faster than the scan. `G = 4` is
RECOMMENDED for general use; a size-constrained reader loses little at
`G = 8`.

**N-gram length.** A unigram index (`n = 1`, 28 lists) is about 28 times
smaller than a bigram index at the same `G`, but each list is far
denser: almost every name contains an `a`, and a two-letter query leaves
most of the table as candidates. It only outperformed the bigram index
on one-character queries, which the bigram index cannot serve at all.
`n = 2` is RECOMMENDED. Longer n-grams are not defined in this version:
`28^3 = 21952` lists would make the file larger than a `G = 1` bigram
index for any realistic place count, and would not serve two-character
queries.

**Separators and digits.** Folding all punctuation and whitespace to one
symbol means a query containing a space eliminates names in which the
two words are not adjacent in the same order, at no extra cost, while a
hyphen and a space in a name still match each other's query. Digits
share one bucket because names containing digits are rare enough that
distinguishing them would not pay for the extra lists.

### B.10. Worked Example

This example indexes the source file of
[Appendix A](#appendix-a-worked-example) with `n = 2` and `G = 1`, so
that each of the three cities has its own bit. The indexed places are
IDs `4` (`Amsterdam`), `5` (`Zaandam`), and `6` (`Antwerpen|Antwerp`),
at positions `0`, `1`, and `2`. The file is `21 + 784 = 805` bytes.

#### B.10.1. Header (21 bytes)

```
43 47 45 4f 44 41 54 41   signature "CGEODATA"
10                        version 16 -> kind 1 (text search index), version 0
9f e6 00 b9 37 18 dc 77   source_checksum 0x77dc1837b900e69f
02                        ngram 2  -> L = 784 lists
01                        group_size 1
04                        first_id 4
03                        place_count 3  -> bits_per_list 3, bytes_per_list 1
```

The checksum is the FNV-1a 64 hash of the 109 bytes of the place table
in [Section A.3](#a3-place-table-109-bytes), that is the bytes at file
offsets `22` to `130` of the Appendix A file, from the `02` of
`country_count` to the `6c` that ends block `1`.

#### B.10.2. Lists (784 bytes)

Every list is one byte. Bit `0x01` is Amsterdam, `0x02` is Zaandam, and
`0x04` is Antwerpen. The bigram sets are:

| ID | Names                | Bigrams |
|----|----------------------|---------|
| 4  | `Amsterdam`          | `am ms st te er rd da` |
| 5  | `Zaandam`            | `za aa an nd da am` |
| 6  | `Antwerpen`, `Antwerp` | `an nt tw we er rp pe en` |

`Antwerp` adds no bigram beyond those of `Antwerpen`. Seventeen lists
are non-zero; the other 767 are `00`:

| Bigram | List index      | Byte | Places |
|--------|-----------------|------|--------|
| `aa`   | `0 × 28 + 0 = 0`   | `02` | Zaandam |
| `am`   | `0 × 28 + 12 = 12` | `03` | Amsterdam, Zaandam |
| `an`   | `13`            | `06` | Zaandam, Antwerpen |
| `da`   | `3 × 28 + 0 = 84`  | `03` | Amsterdam, Zaandam |
| `en`   | `125`           | `04` | Antwerpen |
| `er`   | `129`           | `05` | Amsterdam, Antwerpen |
| `ms`   | `354`           | `01` | Amsterdam |
| `nd`   | `367`           | `02` | Zaandam |
| `nt`   | `383`           | `04` | Antwerpen |
| `pe`   | `424`           | `04` | Antwerpen |
| `rd`   | `479`           | `01` | Amsterdam |
| `rp`   | `491`           | `04` | Antwerpen |
| `st`   | `523`           | `01` | Amsterdam |
| `te`   | `536`           | `01` | Amsterdam |
| `tw`   | `554`           | `04` | Antwerpen |
| `we`   | `620`           | `04` | Antwerpen |
| `za`   | `25 × 28 + 0 = 700` | `02` | Zaandam |

List `l` is at file offset `21 + l`.

#### B.10.3. Queries

**`dam`.** Folds to symbols `3, 0, 12`; bigrams `da` (list `84`) and
`am` (list `12`). `03 AND 03 = 03`: candidates are positions `0` and
`1`, IDs `4` and `5`. Both `Amsterdam` and `Zaandam` contain `dam`, so
both are confirmed.

**`dams`.** Bigrams `da` (`84`), `am` (`12`), `ms` (`354`).
`03 AND 03 AND 01 = 01`: the only candidate is `Amsterdam`. Its names
do not contain `dams`, so it is rejected and the search reports
nothing. The index passed it because a bigram set discards the order
in which the bigrams occur: `Amsterdam` has all three, just not
consecutively.

**`antwerp`.** Bigrams `an`, `nt`, `tw`, `we`, `er`, `rp`, lists `13`,
`383`, `554`, `620`, `129`, `491`. `06 AND 04 AND 04 AND 04 AND 05 AND
04 = 04`: the only candidate is ID `6`, which is confirmed. Note that
`an` alone would also have admitted `Zaandam`, and `er` alone
`Amsterdam`.

**`Zaan-dam`.** Folds to `za aa an n- -d da am`, where `-` stands for
the separator symbol `26`. Lists `390` (`n-`) and `731` (`-d`) are
zero, so the AND is zero: no candidates, nothing to confirm. This is
correct, since no name contains `zaan-dam`.

**`a`.** One symbol, fewer than `n = 2`. The index does not apply and
every name is compared; all three cities match.

#### B.10.4. The Same Index with `G = 4`

With `group_size = 4` the header's `01` becomes `04`, and all three
positions fall in group `0`, so `bits_per_list = 1` and every non-zero
list byte becomes `01`. The file is still 805 bytes. The query `aa`
now yields `01`, making all three cities candidates; comparing their
names confirms only `Zaandam`. The result is the same as with `G = 1`,
after two more name comparisons.

## Appendix C. References

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
- [README.md](README.md): the prototype and measurements this format
  is derived from.
