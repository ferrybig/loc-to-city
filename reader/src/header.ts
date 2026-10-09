import { readVarint, IncompleteBufferError } from "./varint.ts";

// "CGEODATA"
const SIGNATURE = Uint8Array.from([0x43, 0x47, 0x45, 0x4f, 0x44, 0x41, 0x54, 0x41]);

export interface CGeoDataHeader {
  version: number;
  attribution: string;
  widthExp: number;
  heightExp: number;
  maxDepth: number;
  keyframeExp: number;
  /** W = 2^widthExp */
  width: number;
  /** H = 2^heightExp */
  height: number;
  /** Byte length of the header, i.e. where the directory begins. */
  headerLength: number;
}

/** Parses Section 5's header from a buffer that starts at the file's first
 * byte. Throws IncompleteBufferError if `buf` is too short to tell (the
 * caller should retry with more bytes), or a plain Error for a genuine
 * format problem. */
export function parseHeader(buf: Uint8Array): CGeoDataHeader {
  if (buf.length < SIGNATURE.length) {
    throw new IncompleteBufferError("buffer too short for the CGEODATA signature");
  }
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buf[i] !== SIGNATURE[i]) {
      throw new Error("not a CGEODATA file: signature mismatch");
    }
  }
  let offset = SIGNATURE.length;

  const version = readVarint(buf, offset);
  offset += version.bytesRead;
  if (version.value !== 0) {
    throw new Error(`unsupported CGEODATA version ${version.value}`);
  }

  const attrLen = readVarint(buf, offset);
  offset += attrLen.bytesRead;
  const attrEnd = offset + attrLen.value;
  if (attrEnd + 4 > buf.length) {
    throw new IncompleteBufferError("buffer too short for attribution + fixed header fields");
  }
  const attribution = Buffer.from(buf.subarray(offset, attrEnd)).toString("utf8");
  offset = attrEnd;

  const widthExp = buf[offset]!;
  const heightExp = buf[offset + 1]!;
  const maxDepth = buf[offset + 2]!;
  const keyframeExp = buf[offset + 3]!;
  offset += 4;

  if (maxDepth > 26) {
    throw new Error(`max_depth ${maxDepth} exceeds the maximum of 26`);
  }
  if (widthExp > 15) {
    throw new Error(`width_exp ${widthExp} exceeds the maximum of 15`);
  }
  if (heightExp > 15) {
    throw new Error(`height_exp ${heightExp} exceeds the maximum of 15`);
  }
  // The only other u8 of the header, and the only one that was left
  // unchecked: a place count is below 2^53 (Section 3.2), so a block of
  // 2^53 names or more can never be anything but malformed -- and an
  // unchecked value renders as nonsense ("keyframe 255 (5.8e+76 names per
  // block)" from `cgeodata info`).
  if (keyframeExp > 52) {
    throw new Error(`keyframe_exp ${keyframeExp} exceeds the maximum of 52`);
  }

  return {
    version: version.value,
    attribution,
    widthExp,
    heightExp,
    maxDepth,
    keyframeExp,
    width: 2 ** widthExp,
    height: 2 ** heightExp,
    headerLength: offset,
  };
}
