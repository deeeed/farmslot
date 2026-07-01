// @farmslot/capabilities — machine-local capability primitives shared by the node
// (primary owner) and the gateway (local fallback when no node). ADR-046.

export { expandTilde, type FileWatchHandle, watchFile } from './fs-watch.js';
