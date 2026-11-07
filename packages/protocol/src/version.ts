// Published protocol release plus an explicit oldest-supported peer.
// Different release numbers are harmless when both declared bounds are met;
// optional methods/events still require their existing feature capabilities.
export const PROTOCOL_VERSION = '0.79.0';
/** Node-facing additions since this release remain additive or capability-gated. */
export const MINIMUM_PROTOCOL_VERSION = '0.76.0';
