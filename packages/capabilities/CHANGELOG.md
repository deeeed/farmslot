# Changelog

All notable changes to `@farmslot/capabilities` are tracked here.

## Unreleased

- Observe opened workspace names, bytes and linked-worktree Git metadata through one owned filesystem source.

- Report unavailable file observation watches rather than silently admitting missing parents or failed watchers.

- Report optional file-deletion and read-error observations, recover identical contents after an unavailable state, and discard late reads after replacement or stop.

- Active-development baseline; add user-facing changes here before release or package publication.

## 0.6.1 - 2026-10-21

- Align with `@farmslot/protocol` 0.61.0.

## 0.6.0 - 2026-10-20

- Align with `@farmslot/protocol` 0.60.0.

## 0.5.0 - 2026-10-19

- Align with `@farmslot/protocol` 0.59.0.

## 0.4.0 - 2026-10-19

- Align with `@farmslot/protocol` 0.58.0.

## 0.3.0 - 2026-10-19

- Align with `@farmslot/protocol` 0.57.0.

## 0.2.0 - 2026-10-19

- Align with `@farmslot/protocol` 0.56.0.

## 0.1.15 - 2026-10-18

- Align with `@farmslot/protocol` 0.55.0.

## 0.1.14 - 2026-10-17

- Align the worker dependency set with Send back repairs and Protocol 0.54.0.

## 0.1.13 - 2026-10-16

- Align the worker dependency set with Protocol 0.50.0 and the qualified one-tap visual review readers.

## 0.1.12 - 2026-10-16

- Align the worker dependency set with Protocol 0.49.0 person-device sessions.

## 0.1.11 - 2026-10-15

- Use the operator-wait runtime and protocol dependency set.

## 0.1.10 - 2026-10-15

- Align the published dependency set with protocol 0.47.0 initial resource proof modes.

## 0.1.9 - 2026-10-15

- Align the published dependency closure with protocol 0.46.0 and the merged runtime fixes.

## 0.1.8 - 2026-10-15

- Align the installed dependency closure with protocol 0.45.0 and retained-run stack attachment.

## 0.1.7 - 2026-10-14

- Align public dependencies with protocol 0.43.1 and its optional HUD conformance guard.

## 0.1.6 - 2026-10-10

- Publish with protocol 0.36.0 so consumers share one dependency copy. No code change.

## 0.1.5 - 2026-10-10

- Publish with protocol 0.35.2 so consumers share one protocol copy. No code change.

## 0.1.4 - 2026-10-09

- Publish with protocol 0.35.1 so consumers share one protocol copy. No code change.

## 0.1.3 - 2026-10-09

- Publish with protocol 0.35.0 so consumers share one protocol copy. No code change.

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
