;; Fast path for a version 2 chunk (binary-format.md Section 8.7): decodes
;; the range-coded quadtree and palette indices into the same arrays the
;; JavaScript decoder (src/rangeChunk.ts) returns, about twice as fast.
;;
;; Like chunkDecoder.wat, it never reports an error: anything it doesn't
;; accept returns 0, and the caller decodes the block again in JavaScript,
;; which throws the error or returns the records. So it must never accept
;; a stream the JavaScript decoder rejects, nor decode one differently.
;; The checks that make that hold are marked "JS:" with the error they
;; stand for. test/rangeChunk.test.ts fails without each, except two that
;; only a stream crafted bit by bit could reach, and that are kept so such
;; a stream can't be accepted: a rank of 32 bits (whose mantissa would
;; use probabilities past the table and wrap round to a valid rank) and
;; an empty node stack (which would pop garbage as nodes).
;;
;; Build: npm run build:wasm -w reader (regenerates src/rangeDecoderWasm.ts).
(module
  (memory (export "memory") 1)

  ;; The range coder's state, shared by $bit and decode.
  (global $range (mut i32) (i32.const 0))
  (global $code (mut i32) (i32.const 0))
  (global $pos (mut i32) (i32.const 0))
  (global $end (mut i32) (i32.const 0))

  ;; One binary decision with the 12-bit probability (of a 0) at byte
  ;; address $a, which adapts 1/16 of the way towards what was decoded.
  (func $bit (param $a i32) (result i32)
    (local $p i32) (local $bound i32) (local $b i32)
    (local.set $p (i32.load16_u (local.get $a)))
    ;; range >>> 12 is below 2^20 and p below 2^12: no overflow.
    (local.set $bound (i32.mul (i32.shr_u (global.get $range) (i32.const 12)) (local.get $p)))
    (if (i32.lt_u (global.get $code) (local.get $bound))
      (then
        (global.set $range (local.get $bound))
        (i32.store16 (local.get $a) (i32.add (local.get $p)
          (i32.shr_u (i32.sub (i32.const 4096) (local.get $p)) (i32.const 4)))))
      (else
        (global.set $code (i32.sub (global.get $code) (local.get $bound)))
        (global.set $range (i32.sub (global.get $range) (local.get $bound)))
        (i32.store16 (local.get $a) (i32.sub (local.get $p)
          (i32.shr_u (local.get $p) (i32.const 4))))
        (local.set $b (i32.const 1))))
    (block $done
      (loop $normalize
        (br_if $done (i32.ge_u (global.get $range) (i32.const 0x1000000)))
        ;; JS: "range-coded stream runs past end of block". Past the end
        ;; this reads whatever follows the stream, and decode declines at
        ;; the end, as $pos is then past $end. code < range < 2^24 here, so
        ;; code << 8 doesn't overflow.
        (global.set $code (i32.or (i32.shl (global.get $code) (i32.const 8))
          (i32.load8_u (global.get $pos))))
        (global.set $pos (i32.add (global.get $pos) (i32.const 1)))
        (global.set $range (i32.shl (global.get $range) (i32.const 8)))
        (br $normalize)))
    (local.get $b))

  ;; Section 8.7.2's neighbour category of a node at depth $d: 0 without a
  ;; neighbour ($tag -1), else 1, 2 or 3 as the neighbour's record is not
  ;; deeper, one level deeper, or more than one level deeper.
  (func $category (param $tag i32) (param $d i32) (result i32)
    (local $e i32)
    (if (i32.lt_s (local.get $tag) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $e (i32.and (local.get $tag) (i32.const 31)))
    (if (i32.le_u (local.get $e) (local.get $d)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $e) (i32.add (local.get $d) (i32.const 1))) (then (return (i32.const 2))))
    (i32.const 3))

  ;; decode(streamEnd, n, paletteCount, maxDepth, width, out, scratch) -> 1 | 0
  ;;
  ;; Memory from address 0 holds the stream, streamEnd bytes. `out` (a
  ;; multiple of 4) gets n u32 codes, then n palette indices of `width`
  ;; (1, 2 or 4) bytes each, then n u8 depths. `scratch` is 4992 bytes of probabilities,
  ;; 816 of node stack, then the row, column and move-to-front arrays,
  ;; 4 x (2 x 2^maxDepth + paletteCount + 1) bytes. The caller has checked
  ;; Section 8.7.5's bounds on n, that maxDepth is at most 16 and
  ;; paletteCount below 2^26.
  (func (export "decode")
    (param $streamEnd i32) (param $n i32) (param $paletteCount i32)
    (param $maxDepth i32) (param $width i32) (param $out i32) (param $scratch i32)
    (result i32)
    (local $split i32) (local $eqW i32) (local $eqS i32) (local $rankLength i32)
    (local $rankBits i32) (local $stack i32) (local $row i32) (local $col i32)
    (local $mtf i32) (local $depthsOut i32) (local $indicesOut i32)
    (local $i i32) (local $sp i32) (local $j i32) (local $prev i32) (local $cellCode i32)
    (local $d i32) (local $x i32) (local $y i32) (local $h i32) (local $top i32)
    (local $w i32) (local $s i32) (local $wc i32) (local $wv i32) (local $sv i32)
    (local $c i32) (local $v i32) (local $p i32) (local $cc i32) (local $nb i32)
    (local $value i32) (local $rank i32) (local $t i32) (local $size i32) (local $tag i32)

    ;; Section 8.7.1: a 0 byte, then the first 4 bytes of code.
    ;; JS: "does not start with a 0 byte". (JS's "shorter than 5 bytes"
    ;; needs no check: $pos then starts past $end, as at the end below.)
    (if (i32.load8_u (i32.const 0)) (then (return (i32.const 0))))
    (global.set $code (i32.or (i32.or
      (i32.shl (i32.load8_u (i32.const 1)) (i32.const 24))
      (i32.shl (i32.load8_u (i32.const 2)) (i32.const 16)))
      (i32.or (i32.shl (i32.load8_u (i32.const 3)) (i32.const 8))
        (i32.load8_u (i32.const 4)))))
    ;; JS: "starts with code 0xffffffff" needs no check of its own: from
    ;; that code every decision is a 1, so the first leaf (at the chunk's
    ;; corner, with no neighbours) has a rank of 32 bits, declined below.
    (global.set $range (i32.const -1))
    (global.set $pos (i32.const 5))
    (global.set $end (local.get $streamEnd))

    (local.set $split (local.get $scratch))
    (local.set $eqW (i32.add (local.get $scratch) (i32.const 512)))
    (local.set $eqS (i32.add (local.get $scratch) (i32.const 1600)))
    (local.set $rankLength (i32.add (local.get $scratch) (i32.const 2688)))
    (local.set $rankBits (i32.add (local.get $scratch) (i32.const 2944)))
    (local.set $stack (i32.add (local.get $scratch) (i32.const 4992)))
    (local.set $row (i32.add (local.get $stack) (i32.const 816)))
    (local.set $col (i32.add (local.get $row)
      (i32.shl (i32.const 4) (local.get $maxDepth))))
    (local.set $mtf (i32.add (local.get $col)
      (i32.shl (i32.const 4) (local.get $maxDepth))))
    (local.set $indicesOut (i32.add (local.get $out) (i32.shl (local.get $n) (i32.const 2))))
    (local.set $depthsOut (i32.add (local.get $indicesOut) (i32.mul (local.get $n) (local.get $width))))

    ;; Every probability starts at 2048, every row and column at -1 (no
    ;; record yet), and the move-to-front list at 0..P.
    (local.set $i (i32.const 0))
    (loop $init
      (i32.store16 (i32.add (local.get $scratch) (local.get $i)) (i32.const 2048))
      (local.set $i (i32.add (local.get $i) (i32.const 2)))
      (br_if $init (i32.lt_u (local.get $i) (i32.const 4992))))
    (memory.fill (local.get $row) (i32.const 0xff)
      (i32.shl (i32.const 8) (local.get $maxDepth)))
    (local.set $i (i32.const 0))
    (loop $initMtf
      (i32.store (i32.add (local.get $mtf) (i32.shl (local.get $i) (i32.const 2))) (local.get $i))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $initMtf (i32.le_u (local.get $i) (local.get $paletteCount))))

    ;; The node stack holds (depth, x, y), 12 bytes each; the root first.
    (i64.store (local.get $stack) (i64.const 0))
    (i32.store offset=8 (local.get $stack) (i32.const 0))
    (local.set $sp (i32.const 1))
    (local.set $prev (i32.const -1))

    (block $records
      (loop $node
        (br_if $records (i32.ge_u (local.get $j) (local.get $n)))
        ;; JS: "record_count ... is more than the ... records its
        ;; quadtree has".
        (if (i32.eqz (local.get $sp)) (then (return (i32.const 0))))
        (local.set $sp (i32.sub (local.get $sp) (i32.const 1)))
        (local.set $top (i32.add (local.get $stack) (i32.mul (local.get $sp) (i32.const 12))))
        (local.set $d (i32.load (local.get $top)))
        (local.set $x (i32.load offset=4 (local.get $top)))
        (local.set $y (i32.load offset=8 (local.get $top)))
        (local.set $w (if (result i32) (local.get $x)
          (then (i32.load (i32.add (local.get $row) (i32.shl (local.get $y) (i32.const 2)))))
          (else (i32.const -1))))
        (local.set $s (if (result i32) (local.get $y)
          (then (i32.load (i32.add (local.get $col) (i32.shl (local.get $x) (i32.const 2)))))
          (else (i32.const -1))))
        (local.set $wc (call $category (local.get $w) (local.get $d)))

        ;; Section 8.7.3: split, or a leaf.
        (if (i32.lt_u (local.get $d) (local.get $maxDepth))
          (then
            (if (call $bit (i32.add (local.get $split) (i32.shl
                  (i32.add (i32.add (i32.shl (local.get $d) (i32.const 4))
                    (i32.shl (local.get $wc) (i32.const 2)))
                    (call $category (local.get $s) (local.get $d)))
                  (i32.const 1))))
              (then
                ;; Children pushed in reverse, so the south-west one pops
                ;; first: (x+h, y+h), (x, y+h), (x+h, y), (x, y).
                (local.set $h (i32.shl (i32.const 1)
                  (i32.sub (i32.sub (local.get $maxDepth) (local.get $d)) (i32.const 1))))
                (local.set $d (i32.add (local.get $d) (i32.const 1)))
                (i32.store (local.get $top) (local.get $d))
                (i32.store offset=4 (local.get $top) (i32.add (local.get $x) (local.get $h)))
                (i32.store offset=8 (local.get $top) (i32.add (local.get $y) (local.get $h)))
                (i32.store offset=12 (local.get $top) (local.get $d))
                (i32.store offset=16 (local.get $top) (local.get $x))
                (i32.store offset=20 (local.get $top) (i32.add (local.get $y) (local.get $h)))
                (i32.store offset=24 (local.get $top) (local.get $d))
                (i32.store offset=28 (local.get $top) (i32.add (local.get $x) (local.get $h)))
                (i32.store offset=32 (local.get $top) (local.get $y))
                (i32.store offset=36 (local.get $top) (local.get $d))
                (i32.store offset=40 (local.get $top) (local.get $x))
                (i32.store offset=44 (local.get $top) (local.get $y))
                (local.set $sp (i32.add (local.get $sp) (i32.const 4)))
                (br $node)))))

        ;; Section 8.7.4: the leaf's palette index.
        (local.set $wv (select (i32.const -1) (i32.shr_u (local.get $w) (i32.const 5))
          (i32.lt_s (local.get $w) (i32.const 0))))
        (local.set $sv (select (i32.const -1) (i32.shr_u (local.get $s) (i32.const 5))
          (i32.lt_s (local.get $s) (i32.const 0))))
        (local.set $c (i32.add (i32.shl (i32.add (i32.add (i32.add
            (i32.shl (local.get $d) (i32.const 3))
            (i32.shl (i32.eq (local.get $wv) (local.get $sv)) (i32.const 2)))
            (i32.shl (i32.eq (local.get $prev) (local.get $wv)) (i32.const 1)))
            (i32.eq (local.get $prev) (local.get $sv)))
          (i32.const 2)) (local.get $wc)))
        (local.set $v (i32.const -1))
        (if (i32.ge_s (local.get $wv) (i32.const 0))
          (then
            (if (call $bit (i32.add (local.get $eqW) (i32.shl (local.get $c) (i32.const 1))))
              (then (local.set $v (local.get $wv))))))
        (if (i32.and (i32.lt_s (local.get $v) (i32.const 0))
              (i32.and (i32.ge_s (local.get $sv) (i32.const 0))
                (i32.ne (local.get $sv) (local.get $wv))))
          (then
            (if (call $bit (i32.add (local.get $eqS) (i32.shl (local.get $c) (i32.const 1))))
              (then (local.set $v (local.get $sv))))))
        (local.set $p (i32.const 0))
        (if (i32.lt_s (local.get $v) (i32.const 0))
          (then
            ;; A rank in the move-to-front list, skipping the neighbours'
            ;; indices: Elias gamma of rank + 1.
            (local.set $cc (i32.add
              (select (i32.const 32) (i32.const 0) (i32.ge_s (local.get $wv) (i32.const 0)))
              (select (i32.const 64) (i32.const 0) (i32.ge_s (local.get $sv) (i32.const 0)))))
            (local.set $nb (i32.const 0))
            (block $lengthDone
              (loop $length
                (br_if $lengthDone (i32.eqz (call $bit (i32.add (local.get $rankLength)
                  (i32.shl (i32.add (local.get $cc) (local.get $nb)) (i32.const 1))))))
                (local.set $nb (i32.add (local.get $nb) (i32.const 1)))
                ;; JS: "palette rank is 2^32 or more".
                (if (i32.eq (local.get $nb) (i32.const 32)) (then (return (i32.const 0))))
                (br $length)))
            (local.set $value (i32.const 1))
            (local.set $i (local.get $nb))
            (block $bitsDone
              (loop $bits
                (br_if $bitsDone (i32.eqz (local.get $i)))
                (local.set $i (i32.sub (local.get $i) (i32.const 1)))
                (local.set $value (i32.add (i32.shl (local.get $value) (i32.const 1))
                  (call $bit (i32.add (local.get $rankBits) (i32.shl
                    (i32.add (i32.shl (local.get $nb) (i32.const 5)) (local.get $i))
                    (i32.const 1))))))
                (br $bits)))
            (local.set $rank (i32.sub (local.get $value) (i32.const 1)))
            (block $found
              (loop $scan
                ;; JS: "palette rank ... is past the palette".
                (if (i32.gt_u (local.get $p) (local.get $paletteCount)) (then (return (i32.const 0))))
                (local.set $t (i32.load (i32.add (local.get $mtf) (i32.shl (local.get $p) (i32.const 2)))))
                (if (i32.and (i32.ne (local.get $t) (local.get $wv)) (i32.ne (local.get $t) (local.get $sv)))
                  (then
                    (br_if $found (i32.eqz (local.get $rank)))
                    (local.set $rank (i32.sub (local.get $rank) (i32.const 1)))))
                (local.set $p (i32.add (local.get $p) (i32.const 1)))
                (br $scan)))
            (local.set $v (local.get $t)))
          (else
            (loop $seek
              (if (i32.ne (i32.load (i32.add (local.get $mtf) (i32.shl (local.get $p) (i32.const 2))))
                    (local.get $v))
                (then
                  (local.set $p (i32.add (local.get $p) (i32.const 1)))
                  (br $seek))))))
        (if (local.get $p)
          (then
            (memory.copy (i32.add (local.get $mtf) (i32.const 4)) (local.get $mtf)
              (i32.shl (local.get $p) (i32.const 2)))
            (i32.store (local.get $mtf) (local.get $v))))

        ;; The leaf is now the record west of / south of the next cell to
        ;; be decoded in each of its rows and columns.
        (local.set $size (i32.shl (i32.const 1) (i32.sub (local.get $maxDepth) (local.get $d))))
        (local.set $tag (i32.or (i32.shl (local.get $v) (i32.const 5)) (local.get $d)))
        (local.set $i (i32.const 0))
        (loop $fill
          (i32.store (i32.add (local.get $row) (i32.shl (i32.add (local.get $y) (local.get $i)) (i32.const 2)))
            (local.get $tag))
          (i32.store (i32.add (local.get $col) (i32.shl (i32.add (local.get $x) (local.get $i)) (i32.const 2)))
            (local.get $tag))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $fill (i32.lt_u (local.get $i) (local.get $size))))

        (i32.store (i32.add (local.get $out) (i32.shl (local.get $j) (i32.const 2))) (local.get $cellCode))
        (i32.store8 (i32.add (local.get $depthsOut) (local.get $j)) (local.get $d))
        (if (i32.eq (local.get $width) (i32.const 1))
          (then (i32.store8 (i32.add (local.get $indicesOut) (local.get $j)) (local.get $v)))
          (else (if (i32.eq (local.get $width) (i32.const 2))
            (then (i32.store16 (i32.add (local.get $indicesOut) (i32.shl (local.get $j) (i32.const 1)))
              (local.get $v)))
            (else (i32.store (i32.add (local.get $indicesOut) (i32.shl (local.get $j) (i32.const 2)))
              (local.get $v))))))
        ;; Wraps to 0 past a depth-0 record at maxDepth 16, which is then
        ;; the only record.
        (local.set $cellCode (i32.add (local.get $cellCode) (i32.mul (local.get $size) (local.get $size))))
        (local.set $prev (local.get $v))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $node)))

    ;; JS: "runs past end of block" ($pos past $end) and "trailing
    ;; bytes" ($pos short of it).
    (i32.eq (global.get $pos) (global.get $end)))
)
