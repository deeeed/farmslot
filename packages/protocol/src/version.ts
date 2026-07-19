// Protocol version — bump when node↔gateway contract changes.
// Node sends this on connect. Gateway records and surfaces mismatches so the
// fleet can be upgraded deliberately; optional method/event fields remain
// backward-compatible unless a caller requires a new node capability.
// Format: semver-ish, increment when methods/events/frame format changes.
export const PROTOCOL_VERSION = '0.10.0';
