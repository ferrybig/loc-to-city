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

Each chunk is a single `varint` describing the offset, from the previous one. Each value should be multiplied by 16. This wastes some bytes before the next zlib header starts, but has the advantage of that larger chunks can potentially fit in a smaller varint

Eg, when accessing index 0, you skip `index 0 * 16` bytes after the meta chunk. and when reading index 2, you skip `index 0 * 16 + index 1 * 16 + index 2 * 16` after the meta chunk.

A varint of 0 means that chunk of the map is fully empty, no further processing needed

A valid latitude is `-90 <= lat < 90`, values between -270 to -90 should have +180 subtracted, values between 90 to 270 should have 180 subtracted

A valid longitude is `-180 <= lon < 180`, values between -540 to -180 should have +360 subtracted, values between 180 to 540 should have 360 subtracted

If either latitude or longitude outside the valid range is passed it should be rejected

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
* keyframe offset list (the first keyframe always has an offset and is not listed. You know the total amount of countries expected, so you can skip to the correct index). These are lengths-to-sum with. Each value should be multiplied by 16. This wastes some bytes before the next zlib header starts, but has the advantage of that larger chunks can potentially fit in a smaller varint
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

Each chunks has zlib wrapper around it for compression

A chunk format is:

* Palette: a list of `varint`, referring to the city/region/country indexes's. A `0` marks the end of the list
* record count: `varint`
* Records: adaptive Morton grid, first the depth variables, then the indexes to the palette. A 0 means no city found. If palette is shorter than 255, use 1-byte integers, if palette is shorter than 2^16, use 2 byte integers, if palette is shorter than 2^24, use 3 byte integers, otherwise use 4 byte integers. Most chunks likely use the 2 byte ints.

Note that pallette is also an incrementing list like before, eg to get the value of [2], do p[0] + p[1] + p[2]. The means that chunks are stored in the same row-major order as the meta chunk table. 

## examples

* Header
  * signature: `CGEODATA`
  * version: `0`
  * attribution: `''`
  * width in chunks: 2 (raw: `1`)
  * height in chunks: 2 (raw: `1`)
  * keyframe interval: \<no keyframes> (raw: 0)
* chunk pointer
  * 1024 (fictional length, which is the length of the header, so after this amount of bytes are skipped after the chunk pointers, the reading is now at chunk 0 )
  * 0 (empty chunk)
  * 0 (empty chunk)
  * 0 (empty chunk)
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
* chunks (only 1 chunk is filled)
  * Pallete
  * adaptive Morton grid
