# Changelog

All notable changes to `@farmslot/capabilities` are tracked here.

## Unreleased

## 0.1.1 - 2026-08-21

- Keep `fs-watch` attached across atomic file replacements so remote checklist progress
  continues after the first marked step.

## 0.1.0 - 2026-07-01

- Initial package (ADR-046): machine-local capability primitives shared by the node
  (primary owner) and the gateway (local fallback when no node).
- `fs-watch` — `watchFile()` native file-change watch primitive.
- `screen-frame` — `encodeNodeFrame()` / `decodeNodeFrame()` node→gateway capture-frame
  envelope codec.
- `screen-h264` — `createH264FrameSplitter()` raw H.264 stream frame splitter.
