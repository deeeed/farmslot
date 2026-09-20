# Changelog

All notable changes to `@farmslot/capabilities` are tracked here.

## Unreleased

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.1.2 - 2026-09-20

- Publishable manifest: MIT license file and metadata, an explicit `files` list (source only, no tests) and public access, so the package ships through the shared npm release group.

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
