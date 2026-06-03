// H.264 decoder wrapper — decodes Annex B NAL units via WebCodecs VideoDecoder

const NAL_TYPE_SPS = 7;
const NAL_TYPE_PPS = 8;

let instanceSeq = 0;

export class H264Decoder {
  private _decoder: VideoDecoder | null = null;
  private _onFrame: (frame: VideoFrame) => void;
  private _onError: (err: Error) => void;
  private _sps: Uint8Array | null = null;
  private _pps: Uint8Array | null = null;
  private _configured = false;
  private _instanceId = ++instanceSeq;
  private _closed = false;

  constructor(onFrame: (frame: VideoFrame) => void, onError: (err: Error) => void) {
    this._onFrame = onFrame;
    this._onError = onError;
    this._log('created');
  }

  static isSupported(): boolean {
    return typeof VideoDecoder !== 'undefined';
  }

  decode(data: Uint8Array, timestamp: number, keyFrame: boolean): void {
    if (this._closed) return;

    // Split into NAL units and process
    const nalUnits = splitNALUnits(data);
    for (const nal of nalUnits) {
      if (nal.length === 0) continue;
      const nalType = nal[0] & 0x1f;

      if (nalType === NAL_TYPE_SPS) {
        this._sps = nal;
        this._tryConfigureSps();
      } else if (nalType === NAL_TYPE_PPS) {
        this._pps = nal;
        this._tryConfigureSps();
      }
    }

    if (!this._configured || !this._decoder || this._decoder.state === 'closed') return;

    // Filter out SPS/PPS NALUs (already in description) and convert remaining
    // Annex B NALUs to length-prefixed format (avcC) for the decoder.
    const frameNals = nalUnits.filter((nal) => {
      if (nal.length === 0) return false;
      const t = nal[0] & 0x1f;
      return t !== NAL_TYPE_SPS && t !== NAL_TYPE_PPS;
    });
    if (frameNals.length === 0) return;

    const avcData = nalsToLengthPrefixed(frameNals);
    const chunk = new EncodedVideoChunk({
      type: keyFrame ? 'key' : 'delta',
      timestamp,
      data: avcData,
    });

    try {
      this._decoder.decode(chunk);
    } catch (err) {
      this._onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._log('close');
    if (this._decoder && this._decoder.state !== 'closed') {
      try {
        this._decoder.close();
      } catch {
        /* ignore */
      }
    }
    this._decoder = null;
  }

  private _tryConfigureSps(): void {
    if (!this._sps || !this._pps || this._configured) return;

    // Build AVCDecoderConfigurationRecord (avcC format) — WebCodecs requires this,
    // NOT Annex B, for the description field.
    const sps = this._sps;
    const pps = this._pps;
    const desc = new Uint8Array(5 + 1 + 2 + sps.length + 1 + 2 + pps.length);
    let offset = 0;
    desc[offset++] = 1; // configurationVersion
    desc[offset++] = sps[1]; // AVCProfileIndication
    desc[offset++] = sps[2]; // profile_compatibility
    desc[offset++] = sps[3]; // AVCLevelIndication
    desc[offset++] = 0xff; // lengthSizeMinusOne = 3 (4-byte NAL length) | reserved 6 bits
    desc[offset++] = 0xe1; // numOfSequenceParameterSets = 1 | reserved 3 bits
    desc[offset++] = (sps.length >> 8) & 0xff; // SPS length (uint16 BE)
    desc[offset++] = sps.length & 0xff;
    desc.set(sps, offset);
    offset += sps.length;
    desc[offset++] = 1; // numOfPictureParameterSets = 1
    desc[offset++] = (pps.length >> 8) & 0xff; // PPS length (uint16 BE)
    desc[offset++] = pps.length & 0xff;
    desc.set(pps, offset);

    // Parse resolution from SPS
    const { width, height } = parseSPSDimensions(sps);

    // Build codec string from SPS: avc1.XXYYZZ where XX=profile, YY=compat, ZZ=level
    const codec = `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;

    this._log('configure', `${width}x${height} codec=${codec}`);

    this._decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (this._closed) {
          frame.close();
          return;
        }
        this._onFrame(frame);
      },
      error: (err: DOMException) => {
        this._log('decoder-error', err.message);
        this._onError(new Error(`VideoDecoder error: ${err.message}`));
      },
    });

    this._decoder.configure({
      codec,
      codedWidth: width,
      codedHeight: height,
      description: desc,
      optimizeForLatency: true,
    });

    this._configured = true;
  }

  private _log(action: string, detail?: string) {
    const parts = [`[h264-decoder #${this._instanceId}] ${action}`];
    if (detail) parts.push(detail);
    console.log(parts.join(' '));
  }
}

// Convert an array of raw NAL units to 4-byte length-prefixed format (avcC)
function nalsToLengthPrefixed(nals: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const nal of nals) totalLen += 4 + nal.length;
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const nal of nals) {
    out[offset++] = (nal.length >> 24) & 0xff;
    out[offset++] = (nal.length >> 16) & 0xff;
    out[offset++] = (nal.length >> 8) & 0xff;
    out[offset++] = nal.length & 0xff;
    out.set(nal, offset);
    offset += nal.length;
  }
  return out;
}

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

// Split Annex B byte stream into individual NAL units (without start codes)
function splitNALUnits(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let start = -1;

  for (let i = 0; i < data.length - 2; i++) {
    // Check for 3-byte start code 00 00 01
    const is3byte = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    // Check for 4-byte start code 00 00 00 01
    const is4byte =
      i < data.length - 3 &&
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 0 &&
      data[i + 3] === 1;

    if (is4byte || is3byte) {
      if (start >= 0) {
        units.push(data.subarray(start, i));
      }
      const offset = is4byte ? 4 : 3;
      start = i + offset;
      i += offset - 1; // -1 because loop increments
    }
  }

  if (start >= 0 && start < data.length) {
    units.push(data.subarray(start));
  }

  return units;
}

// Minimal SPS dimension parser — handles common Baseline/Main profiles
function parseSPSDimensions(sps: Uint8Array): { width: number; height: number } {
  // Default fallback
  let width = 360;
  let height = 780;

  try {
    const reader = new BitReader(sps);
    reader.readBits(8); // nal header
    const profileIdc = reader.readBits(8);
    reader.readBits(8); // constraint flags
    reader.readBits(8); // level idc
    reader.readUEG(); // seq_parameter_set_id

    if (
      profileIdc === 100 ||
      profileIdc === 110 ||
      profileIdc === 122 ||
      profileIdc === 244 ||
      profileIdc === 44 ||
      profileIdc === 83 ||
      profileIdc === 86 ||
      profileIdc === 118 ||
      profileIdc === 128
    ) {
      const chromaFormatIdc = reader.readUEG();
      if (chromaFormatIdc === 3) reader.readBits(1); // separate_colour_plane_flag
      reader.readUEG(); // bit_depth_luma_minus8
      reader.readUEG(); // bit_depth_chroma_minus8
      reader.readBits(1); // qpprime_y_zero_transform_bypass_flag
      const seqScalingMatrixPresent = reader.readBits(1);
      if (seqScalingMatrixPresent) {
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          if (reader.readBits(1)) {
            // scaling_list_present
            skipScalingList(reader, i < 6 ? 16 : 64);
          }
        }
      }
    }

    reader.readUEG(); // log2_max_frame_num_minus4
    const picOrderCntType = reader.readUEG();
    if (picOrderCntType === 0) {
      reader.readUEG(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      reader.readBits(1); // delta_pic_order_always_zero_flag
      reader.readSEG(); // offset_for_non_ref_pic
      reader.readSEG(); // offset_for_top_to_bottom_field
      const numRefFrames = reader.readUEG();
      for (let i = 0; i < numRefFrames; i++) reader.readSEG();
    }

    reader.readUEG(); // max_num_ref_frames
    reader.readBits(1); // gaps_in_frame_num_allowed

    const picWidthMbs = reader.readUEG() + 1;
    const picHeightMapUnits = reader.readUEG() + 1;
    const frameMbsOnly = reader.readBits(1);

    width = picWidthMbs * 16;
    height = (2 - frameMbsOnly) * picHeightMapUnits * 16;

    if (!frameMbsOnly) reader.readBits(1); // mb_adaptive_frame_field

    reader.readBits(1); // direct_8x8_inference

    const frameCropping = reader.readBits(1);
    if (frameCropping) {
      const cropLeft = reader.readUEG();
      const cropRight = reader.readUEG();
      const cropTop = reader.readUEG();
      const cropBottom = reader.readUEG();
      width -= (cropLeft + cropRight) * 2;
      height -= (cropTop + cropBottom) * 2;
    }
  } catch {
    // SPS parsing is best-effort — return whatever we have
  }

  return { width, height };
}

function skipScalingList(reader: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let j = 0; j < size; j++) {
    if (nextScale !== 0) {
      const delta = reader.readSEG();
      nextScale = (lastScale + delta + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

class BitReader {
  private _data: Uint8Array;
  private _byteOffset = 0;
  private _bitOffset = 0;

  constructor(data: Uint8Array) {
    this._data = data;
  }

  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      if (this._byteOffset >= this._data.length) return value;
      value = (value << 1) | ((this._data[this._byteOffset] >> (7 - this._bitOffset)) & 1);
      this._bitOffset++;
      if (this._bitOffset === 8) {
        this._bitOffset = 0;
        this._byteOffset++;
      }
    }
    return value;
  }

  readUEG(): number {
    let zeros = 0;
    while (this.readBits(1) === 0 && zeros < 31) zeros++;
    return zeros > 0 ? (1 << zeros) - 1 + this.readBits(zeros) : 0;
  }

  readSEG(): number {
    const val = this.readUEG();
    return val & 1 ? (val + 1) >> 1 : -(val >> 1);
  }
}
