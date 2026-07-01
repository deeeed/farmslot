// @farmslot/capabilities — machine-local capability primitives shared by the node
// (primary owner) and the gateway (local fallback when no node). ADR-046.

export { expandTilde, type FileWatchHandle, watchFile } from './fs-watch.js';
export {
  type DecodedNodeFrame,
  decodeNodeFrame,
  encodeNodeFrame,
  NODE_FRAME_MAGIC,
} from './screen-frame.js';
export {
  createH264FrameSplitter,
  type H264FrameHandler,
  type H264FrameSplitter,
} from './screen-h264.js';
