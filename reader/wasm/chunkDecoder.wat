;; Fast paths for parseChunk (src/chunk.ts), checking every Section 8.5
;; invariant parseChunk checks, 16 records at a time with 128-bit SIMD:
;; - parse, for a version 0 file (binary-format.md Section 8.6): decodes
;;   a chunk's delta-coded codes into 32-bit integers, 16 at a time
;;   wherever 16 code deltas in a row take one byte each (over 99.9% of
;;   them in world.bin).
;; - parseDepths, for version 1 (Section 8.2): derives each code from the
;;   depths before it, 16 at a time up to max_depth 13.
;;
;; It never reports an error itself: anything it doesn't accept -- a
;; malformed chunk, or a valid one it can't handle, such as a code delta
;; over 5 bytes -- returns 0, and the caller reparses the block in
;; JavaScript, which throws the error or returns the records. So it must
;; never accept a block the JavaScript parser rejects, nor decode one
;; differently; rejecting a valid block only costs time.
;;
;; Build: npm run build:wasm -w reader (regenerates src/chunkDecoderWasm.ts).
(module
  (memory (export "memory") 1)

  ;; parse(codesLength, n, maxDepth, paletteCount, indexWidth, out) -> 1 | 0
  ;;
  ;; Memory from address 0 holds the block from its codes onwards:
  ;; codesLength bytes of codes, n depths, then n palette indices of
  ;; indexWidth bytes each. Codes go to `out` as n little-endian u32s.
  ;; maxDepth is at most 16, so every valid code fits in 32 bits.
  (func (export "parse")
    (param $codesLength i32) (param $n i32) (param $maxDepth i32)
    (param $paletteCount i32) (param $width i32) (param $out i32)
    (result i32)
    (local $i i32) (local $src i32) (local $prev i64) (local $maxCode i64)
    (local $code i64) (local $value i64) (local $shift i64)
    (local $byte i32) (local $depth i32)
    (local $splatD v128) (local $deltas v128) (local $k v128) (local $kPrev v128)
    (local $m0 v128) (local $m1 v128) (local $m2 v128) (local $m3 v128)
    (local $lo01 v128) (local $hi01 v128) (local $lo23 v128) (local $hi23 v128)
    (local $lo v128) (local $hi v128) (local $base v128)
    (local $a v128) (local $b v128) (local $c v128) (local $d v128)

    (local.set $maxCode (i64.shl (i64.const 1) (i64.extend_i32_u
      (i32.shl (local.get $maxDepth) (i32.const 1)))))
    (local.set $splatD (i8x16.splat (local.get $maxDepth)))

    (block $codesDone
      (loop $record
        (br_if $codesDone (i32.ge_u (local.get $i) (local.get $n)))

        ;; 16 records at once: not record 0 (it has no predecessor to
        ;; check against), and only when all 16 deltas are one byte.
        (block $scalar
          (br_if $scalar (i32.eqz (local.get $i)))
          (br_if $scalar (i32.gt_u (i32.add (local.get $i) (i32.const 16)) (local.get $n)))
          (br_if $scalar (i32.gt_u (i32.add (local.get $src) (i32.const 16)) (local.get $codesLength)))
          (local.set $deltas (v128.load (local.get $src)))
          (br_if $scalar (i8x16.bitmask (local.get $deltas)))

          ;; Depths: k = maxDepth - depth, the record's 4^k-cell span.
          ;; (Past maxDepth, k wraps round to above maxDepth, whose mask
          ;; below fails every code but 0 -- but say so outright.)
          (local.set $k (v128.load (i32.add (local.get $codesLength) (local.get $i))))
          (if (v128.any_true (i8x16.gt_u (local.get $k) (local.get $splatD)))
            (then (return (i32.const 0))))
          (local.set $k (i8x16.sub (local.get $splatD) (local.get $k)))
          (local.set $kPrev (i8x16.sub (local.get $splatD) (v128.load
            (i32.sub (i32.add (local.get $codesLength) (local.get $i)) (i32.const 1)))))
          ;; The tables below cover k up to 15; k = 16 (a depth-0 record
          ;; at max_depth 16) goes the scalar way.
          (br_if $scalar (v128.any_true (i8x16.gt_u
            (v128.or (local.get $k) (local.get $kPrev)) (i8x16.splat (i32.const 15)))))

          ;; No overlap: each delta at least the previous record's span,
          ;; 4^kPrev, which a one-byte delta can only reach for kPrev <= 3
          ;; (255 stands in for every larger span). Every span is at least
          ;; 1, so this also keeps the codes strictly increasing.
          (if (v128.any_true (i8x16.lt_u (local.get $deltas) (i8x16.swizzle
                (v128.const i8x16 1 4 16 64 255 255 255 255 255 255 255 255 255 255 255 255)
                (local.get $kPrev))))
            (then (return (i32.const 0))))

          ;; Each code's alignment mask, 4^k - 1, a byte at a time from k,
          ;; then interleaved into four u32x4 masks for records 0-3, 4-7,
          ;; 8-11 and 12-15.
          (local.set $m0 (i8x16.swizzle
            (v128.const i8x16 0x00 0x03 0x0f 0x3f 0xff 0xff 0xff 0xff 0xff 0xff 0xff 0xff 0xff 0xff 0xff 0xff)
            (local.get $k)))
          (local.set $m1 (i8x16.swizzle
            (v128.const i8x16 0x00 0x00 0x00 0x00 0x00 0x03 0x0f 0x3f 0xff 0xff 0xff 0xff 0xff 0xff 0xff 0xff)
            (local.get $k)))
          (local.set $m2 (i8x16.swizzle
            (v128.const i8x16 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x03 0x0f 0x3f 0xff 0xff 0xff 0xff)
            (local.get $k)))
          (local.set $m3 (i8x16.swizzle
            (v128.const i8x16 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x03 0x0f 0x3f)
            (local.get $k)))
          (local.set $lo01 (i8x16.shuffle 0 16 1 17 2 18 3 19 4 20 5 21 6 22 7 23 (local.get $m0) (local.get $m1)))
          (local.set $hi01 (i8x16.shuffle 8 24 9 25 10 26 11 27 12 28 13 29 14 30 15 31 (local.get $m0) (local.get $m1)))
          (local.set $lo23 (i8x16.shuffle 0 16 1 17 2 18 3 19 4 20 5 21 6 22 7 23 (local.get $m2) (local.get $m3)))
          (local.set $hi23 (i8x16.shuffle 8 24 9 25 10 26 11 27 12 28 13 29 14 30 15 31 (local.get $m2) (local.get $m3)))
          (local.set $m0 (i8x16.shuffle 0 1 16 17 2 3 18 19 4 5 20 21 6 7 22 23 (local.get $lo01) (local.get $lo23)))
          (local.set $m1 (i8x16.shuffle 8 9 24 25 10 11 26 27 12 13 28 29 14 15 30 31 (local.get $lo01) (local.get $lo23)))
          (local.set $m2 (i8x16.shuffle 0 1 16 17 2 3 18 19 4 5 20 21 6 7 22 23 (local.get $hi01) (local.get $hi23)))
          (local.set $m3 (i8x16.shuffle 8 9 24 25 10 11 26 27 12 13 28 29 14 15 30 31 (local.get $hi01) (local.get $hi23)))

          ;; Codes: inclusive prefix sums of the deltas, within each half
          ;; as u16x8 (at most 8 x 127), then widened and offset.
          (local.set $lo (i16x8.extend_low_i8x16_u (local.get $deltas)))
          (local.set $hi (i16x8.extend_high_i8x16_u (local.get $deltas)))
          (local.set $lo (i16x8.add (local.get $lo) (i8x16.shuffle 16 16 0 1 2 3 4 5 6 7 8 9 10 11 12 13 (local.get $lo) (v128.const i64x2 0 0))))
          (local.set $hi (i16x8.add (local.get $hi) (i8x16.shuffle 16 16 0 1 2 3 4 5 6 7 8 9 10 11 12 13 (local.get $hi) (v128.const i64x2 0 0))))
          (local.set $lo (i16x8.add (local.get $lo) (i8x16.shuffle 16 16 16 16 0 1 2 3 4 5 6 7 8 9 10 11 (local.get $lo) (v128.const i64x2 0 0))))
          (local.set $hi (i16x8.add (local.get $hi) (i8x16.shuffle 16 16 16 16 0 1 2 3 4 5 6 7 8 9 10 11 (local.get $hi) (v128.const i64x2 0 0))))
          (local.set $lo (i16x8.add (local.get $lo) (i8x16.shuffle 16 16 16 16 16 16 16 16 0 1 2 3 4 5 6 7 (local.get $lo) (v128.const i64x2 0 0))))
          (local.set $hi (i16x8.add (local.get $hi) (i8x16.shuffle 16 16 16 16 16 16 16 16 0 1 2 3 4 5 6 7 (local.get $hi) (v128.const i64x2 0 0))))
          ;; The last code must stay below 4^max_depth (<= 2^32), so no
          ;; lane can have wrapped round 32 bits.
          (local.set $code (i64.add (local.get $prev) (i64.extend_i32_u (i32.add
            (i16x8.extract_lane_u 7 (local.get $lo))
            (i16x8.extract_lane_u 7 (local.get $hi))))))
          (if (i64.ge_u (local.get $code) (local.get $maxCode))
            (then (return (i32.const 0))))
          (local.set $base (i32x4.splat (i32.wrap_i64 (local.get $prev))))
          (local.set $a (i32x4.add (local.get $base) (i32x4.extend_low_i16x8_u (local.get $lo))))
          (local.set $b (i32x4.add (local.get $base) (i32x4.extend_high_i16x8_u (local.get $lo))))
          (local.set $base (i32x4.add (local.get $base) (i32x4.splat (i16x8.extract_lane_u 7 (local.get $lo)))))
          (local.set $c (i32x4.add (local.get $base) (i32x4.extend_low_i16x8_u (local.get $hi))))
          (local.set $d (i32x4.add (local.get $base) (i32x4.extend_high_i16x8_u (local.get $hi))))

          ;; Alignment: every code a multiple of its span.
          (if (v128.any_true (v128.or
                (v128.or (v128.and (local.get $a) (local.get $m0)) (v128.and (local.get $b) (local.get $m1)))
                (v128.or (v128.and (local.get $c) (local.get $m2)) (v128.and (local.get $d) (local.get $m3)))))
            (then (return (i32.const 0))))

          (v128.store (local.get $out) (local.get $a))
          (v128.store offset=16 (local.get $out) (local.get $b))
          (v128.store offset=32 (local.get $out) (local.get $c))
          (v128.store offset=48 (local.get $out) (local.get $d))
          (local.set $prev (local.get $code))
          (local.set $src (i32.add (local.get $src) (i32.const 16)))
          (local.set $out (i32.add (local.get $out) (i32.const 64)))
          (local.set $i (i32.add (local.get $i) (i32.const 16)))
          (br $record))

        ;; One record. A varint of up to 5 bytes, minimally encoded.
        (if (i32.ge_u (local.get $src) (local.get $codesLength))
          (then (return (i32.const 0))))
        (local.set $byte (i32.load8_u (local.get $src)))
        (local.set $src (i32.add (local.get $src) (i32.const 1)))
        (local.set $value (i64.extend_i32_u (i32.and (local.get $byte) (i32.const 0x7f))))
        (local.set $shift (i64.const 7))
        (block $varintDone
          (loop $varintByte
            (br_if $varintDone (i32.eqz (i32.and (local.get $byte) (i32.const 0x80))))
            (if (i64.eq (local.get $shift) (i64.const 35))
              (then (return (i32.const 0))))
            (if (i32.ge_u (local.get $src) (local.get $codesLength))
              (then (return (i32.const 0))))
            (local.set $byte (i32.load8_u (local.get $src)))
            (local.set $src (i32.add (local.get $src) (i32.const 1)))
            (if (i32.eqz (local.get $byte))
              (then (return (i32.const 0))))
            (local.set $value (i64.or (local.get $value) (i64.shl
              (i64.extend_i32_u (i32.and (local.get $byte) (i32.const 0x7f)))
              (local.get $shift))))
            (local.set $shift (i64.add (local.get $shift) (i64.const 7)))
            (br $varintByte)))
        (local.set $code (i64.add (local.get $prev) (local.get $value)))
        (if (i64.ge_u (local.get $code) (local.get $maxCode))
          (then (return (i32.const 0))))
        (local.set $depth (i32.load8_u (i32.add (local.get $codesLength) (local.get $i))))
        (if (i32.gt_u (local.get $depth) (local.get $maxDepth))
          (then (return (i32.const 0))))
        ;; Aligned to its span, 4^(maxDepth - depth).
        (if (i64.ne (i64.const 0) (i64.and (local.get $code)
              (i64.sub (i64.shl (i64.const 1) (i64.extend_i32_u (i32.shl
                (i32.sub (local.get $maxDepth) (local.get $depth)) (i32.const 1))))
                (i64.const 1))))
          (then (return (i32.const 0))))
        ;; Clear of the previous record's span (so strictly increasing).
        (if (local.get $i)
          (then
            (local.set $depth (i32.load8_u (i32.sub
              (i32.add (local.get $codesLength) (local.get $i)) (i32.const 1))))
            (if (i64.gt_u
                  (i64.add (local.get $prev) (i64.shl (i64.const 1) (i64.extend_i32_u (i32.shl
                    (i32.sub (local.get $maxDepth) (local.get $depth)) (i32.const 1)))))
                  (local.get $code))
              (then (return (i32.const 0))))))
        (i32.store (local.get $out) (i32.wrap_i64 (local.get $code)))
        (local.set $prev (local.get $code))
        (local.set $out (i32.add (local.get $out) (i32.const 4)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $record)))
    ;; The codes take exactly codes_length bytes.
    (if (i32.ne (local.get $src) (local.get $codesLength))
      (then (return (i32.const 0))))

    ;; Every palette index at most paletteCount.
    (call $indicesOk
      (i32.add (local.get $codesLength) (local.get $n))
      (local.get $n) (local.get $width) (local.get $paletteCount)))

  ;; parseDepths(n, maxDepth, paletteCount, indexWidth, out) -> 1 | 0
  ;;
  ;; A version 1 chunk (binary-format.md Section 8.2), whose codes are not
  ;; stored: each is where the record before it ends (Section 8.4).
  ;; Memory from address 0 holds the block from its depths onwards: n
  ;; depths, then n palette indices of indexWidth bytes each. Codes go to
  ;; `out` as n little-endian u32s, after the Section 8.5 checks
  ;; parseChunk makes: every depth at most maxDepth, every code a
  ;; multiple of its span, every record inside the chunk, every palette
  ;; index at most paletteCount.
  (func (export "parseDepths")
    (param $n i32) (param $maxDepth i32) (param $paletteCount i32)
    (param $width i32) (param $out i32)
    (result i32)
    (local $i i32) (local $code i64) (local $maxCode i64) (local $span i64)
    (local $depth i32) (local $base i32)
    (local $splatD v128) (local $k v128)
    (local $m0 v128) (local $m1 v128) (local $m2 v128) (local $m3 v128)
    (local $lo01 v128) (local $hi01 v128) (local $lo23 v128) (local $hi23 v128)
    (local $a v128) (local $b v128) (local $c v128) (local $d v128)

    (local.set $maxCode (i64.shl (i64.const 1) (i64.extend_i32_u
      (i32.shl (local.get $maxDepth) (i32.const 1)))))
    (local.set $splatD (i8x16.splat (local.get $maxDepth)))

    ;; 16 records at once, up to max_depth 13: a code is then below 2^26,
    ;; so the start of 16 records past one below 2^26, each spanning at
    ;; most 2^26, stays below 2^31 in a u32 lane.
    (if (i32.le_u (local.get $maxDepth) (i32.const 13))
      (then
        (block $simdDone
          (loop $simd
            (br_if $simdDone (i32.gt_u (i32.add (local.get $i) (i32.const 16)) (local.get $n)))

            ;; k = maxDepth - depth, the record's 4^k-cell span.
            (local.set $k (v128.load (local.get $i)))
            (if (v128.any_true (i8x16.gt_u (local.get $k) (local.get $splatD)))
              (then (return (i32.const 0))))
            (local.set $k (i8x16.sub (local.get $splatD) (local.get $k)))

            ;; Each span's mask, 4^k - 1, a byte at a time from k (k is at
            ;; most 13), then interleaved into four u32x4 masks for records
            ;; 0-3, 4-7, 8-11 and 12-15.
            (local.set $m0 (i8x16.swizzle
              (v128.const i8x16 0x00 0x03 0x0f 0x3f 0xff 0xff 0xff 0xff 0xff 0xff 0xff 0xff 0xff 0xff 0xff 0xff)
              (local.get $k)))
            (local.set $m1 (i8x16.swizzle
              (v128.const i8x16 0x00 0x00 0x00 0x00 0x00 0x03 0x0f 0x3f 0xff 0xff 0xff 0xff 0xff 0xff 0xff 0xff)
              (local.get $k)))
            (local.set $m2 (i8x16.swizzle
              (v128.const i8x16 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x03 0x0f 0x3f 0xff 0xff 0xff 0xff)
              (local.get $k)))
            (local.set $m3 (i8x16.swizzle
              (v128.const i8x16 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x03 0x0f 0x3f)
              (local.get $k)))
            (local.set $lo01 (i8x16.shuffle 0 16 1 17 2 18 3 19 4 20 5 21 6 22 7 23 (local.get $m0) (local.get $m1)))
            (local.set $hi01 (i8x16.shuffle 8 24 9 25 10 26 11 27 12 28 13 29 14 30 15 31 (local.get $m0) (local.get $m1)))
            (local.set $lo23 (i8x16.shuffle 0 16 1 17 2 18 3 19 4 20 5 21 6 22 7 23 (local.get $m2) (local.get $m3)))
            (local.set $hi23 (i8x16.shuffle 8 24 9 25 10 26 11 27 12 28 13 29 14 30 15 31 (local.get $m2) (local.get $m3)))
            (local.set $m0 (i8x16.shuffle 0 1 16 17 2 3 18 19 4 5 20 21 6 7 22 23 (local.get $lo01) (local.get $lo23)))
            (local.set $m1 (i8x16.shuffle 8 9 24 25 10 11 26 27 12 13 28 29 14 15 30 31 (local.get $lo01) (local.get $lo23)))
            (local.set $m2 (i8x16.shuffle 0 1 16 17 2 3 18 19 4 5 20 21 6 7 22 23 (local.get $hi01) (local.get $hi23)))
            (local.set $m3 (i8x16.shuffle 8 9 24 25 10 11 26 27 12 13 28 29 14 15 30 31 (local.get $hi01) (local.get $hi23)))

            ;; Codes: each start is the start of the group plus the spans
            ;; before it, an exclusive prefix sum of span = mask + 1: shift
            ;; the spans one lane up, then add each vector to itself two
            ;; and one lanes up.
            (local.set $a (call $startsWithin (i32x4.add (local.get $m0) (i32x4.splat (i32.const 1)))))
            (local.set $b (call $startsWithin (i32x4.add (local.get $m1) (i32x4.splat (i32.const 1)))))
            (local.set $c (call $startsWithin (i32x4.add (local.get $m2) (i32x4.splat (i32.const 1)))))
            (local.set $d (call $startsWithin (i32x4.add (local.get $m3) (i32x4.splat (i32.const 1)))))
            ;; Each vector's first start is the end of the one before it:
            ;; its last start plus its last span.
            (local.set $base (i32.wrap_i64 (local.get $code)))
            (local.set $a (i32x4.add (local.get $a) (i32x4.splat (local.get $base))))
            (local.set $b (i32x4.add (local.get $b) (i32x4.splat (call $endOf (local.get $a) (local.get $m0)))))
            (local.set $c (i32x4.add (local.get $c) (i32x4.splat (call $endOf (local.get $b) (local.get $m1)))))
            (local.set $d (i32x4.add (local.get $d) (i32x4.splat (call $endOf (local.get $c) (local.get $m2)))))

            ;; Inside the chunk: starts increase, so the last one is the
            ;; largest.
            (if (i64.ge_u (i64.extend_i32_u (i32x4.extract_lane 3 (local.get $d))) (local.get $maxCode))
              (then (return (i32.const 0))))
            ;; Alignment: every code a multiple of its span.
            (if (v128.any_true (v128.or
                  (v128.or (v128.and (local.get $a) (local.get $m0)) (v128.and (local.get $b) (local.get $m1)))
                  (v128.or (v128.and (local.get $c) (local.get $m2)) (v128.and (local.get $d) (local.get $m3)))))
              (then (return (i32.const 0))))

            (v128.store (local.get $out) (local.get $a))
            (v128.store offset=16 (local.get $out) (local.get $b))
            (v128.store offset=32 (local.get $out) (local.get $c))
            (v128.store offset=48 (local.get $out) (local.get $d))
            (local.set $code (i64.extend_i32_u (call $endOf (local.get $d) (local.get $m3))))
            (local.set $out (i32.add (local.get $out) (i32.const 64)))
            (local.set $i (i32.add (local.get $i) (i32.const 16)))
            (br $simd)))))

    ;; One record at a time: the rest, and every record past max_depth 13.
    (block $done
      (loop $record
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $depth (i32.load8_u (local.get $i)))
        (if (i32.gt_u (local.get $depth) (local.get $maxDepth))
          (then (return (i32.const 0))))
        (if (i64.ge_u (local.get $code) (local.get $maxCode))
          (then (return (i32.const 0))))
        (local.set $span (i64.shl (i64.const 1) (i64.extend_i32_u (i32.shl
          (i32.sub (local.get $maxDepth) (local.get $depth)) (i32.const 1)))))
        (if (i64.ne (i64.const 0) (i64.and (local.get $code)
              (i64.sub (local.get $span) (i64.const 1))))
          (then (return (i32.const 0))))
        (i32.store (local.get $out) (i32.wrap_i64 (local.get $code)))
        (local.set $code (i64.add (local.get $code) (local.get $span)))
        (local.set $out (i32.add (local.get $out) (i32.const 4)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $record)))
    ;; Every record starts inside the chunk and is aligned to its span,
    ;; which divides 4^maxDepth, so the last one also ends inside it.

    (call $indicesOk (local.get $n) (local.get $n) (local.get $width) (local.get $paletteCount)))

  ;; Where each of four records starts, from the start of the first, given
  ;; their spans: 0, s0, s0 + s1, s0 + s1 + s2.
  (func $startsWithin (param $s v128) (result v128)
    (local.set $s (i8x16.shuffle 16 16 16 16 0 1 2 3 4 5 6 7 8 9 10 11 (local.get $s) (v128.const i64x2 0 0)))
    (local.set $s (i32x4.add (local.get $s) (i8x16.shuffle 16 16 16 16 0 1 2 3 4 5 6 7 8 9 10 11 (local.get $s) (v128.const i64x2 0 0))))
    (i32x4.add (local.get $s) (i8x16.shuffle 16 16 16 16 16 16 16 16 0 1 2 3 4 5 6 7 (local.get $s) (v128.const i64x2 0 0))))

  ;; Where the last of four records ends: its start plus its span, the
  ;; mask plus one.
  (func $endOf (param $starts v128) (param $masks v128) (result i32)
    (i32.add (i32.add (i32x4.extract_lane 3 (local.get $starts)) (i32x4.extract_lane 3 (local.get $masks))) (i32.const 1)))

  ;; indicesOk(pos, n, width, paletteCount) -> 1 | 0: whether each of the
  ;; n palette indices of `width` bytes from `pos` is at most paletteCount.
  (func $indicesOk
    (param $pos i32) (param $n i32) (param $width i32) (param $paletteCount i32)
    (result i32)
    (local $end i32) (local $byte i32) (local $acc v128)
    (local.set $end (i32.add (local.get $pos) (i32.mul (local.get $n) (local.get $width))))
    (if (i32.eq (local.get $width) (i32.const 1))
      (then
        (block $simdDone
          (loop $simd
            (br_if $simdDone (i32.gt_u (i32.add (local.get $pos) (i32.const 16)) (local.get $end)))
            (local.set $acc (i8x16.max_u (local.get $acc) (v128.load (local.get $pos))))
            (local.set $pos (i32.add (local.get $pos) (i32.const 16)))
            (br $simd)))
        (if (v128.any_true (i8x16.gt_u (local.get $acc) (i8x16.splat (local.get $paletteCount))))
          (then (return (i32.const 0))))
        (block $done
          (loop $scalar
            (br_if $done (i32.ge_u (local.get $pos) (local.get $end)))
            (if (i32.gt_u (i32.load8_u (local.get $pos)) (local.get $paletteCount))
              (then (return (i32.const 0))))
            (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
            (br $scalar)))
        (return (i32.const 1))))
    (if (i32.eq (local.get $width) (i32.const 2))
      (then
        (block $simdDone
          (loop $simd
            (br_if $simdDone (i32.gt_u (i32.add (local.get $pos) (i32.const 16)) (local.get $end)))
            (local.set $acc (i16x8.max_u (local.get $acc) (v128.load (local.get $pos))))
            (local.set $pos (i32.add (local.get $pos) (i32.const 16)))
            (br $simd)))
        (if (v128.any_true (i16x8.gt_u (local.get $acc) (i16x8.splat (local.get $paletteCount))))
          (then (return (i32.const 0))))
        (block $done
          (loop $scalar
            (br_if $done (i32.ge_u (local.get $pos) (local.get $end)))
            (if (i32.gt_u (i32.load16_u (local.get $pos)) (local.get $paletteCount))
              (then (return (i32.const 0))))
            (local.set $pos (i32.add (local.get $pos) (i32.const 2)))
            (br $scalar)))
        (return (i32.const 1))))
    ;; 3- and 4-byte indices: chunks with over 65535 places, rare enough
    ;; that a plain loop does.
    (block $done
      (loop $scalar
        (br_if $done (i32.ge_u (local.get $pos) (local.get $end)))
        (local.set $byte (i32.load (local.get $pos)))
        (if (i32.eq (local.get $width) (i32.const 3))
          (then (local.set $byte (i32.and (local.get $byte) (i32.const 0xffffff)))))
        (if (i32.gt_u (local.get $byte) (local.get $paletteCount))
          (then (return (i32.const 0))))
        (local.set $pos (i32.add (local.get $pos) (local.get $width)))
        (br $scalar)))
    (i32.const 1)))
