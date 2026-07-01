# @farmslot/capabilities

Machine-local capability primitives shared by the **node** (`services/node`) and the
**gateway** (`services/gateway`).

The node owns machine-local capabilities; the gateway keeps a degraded **local fallback**
for a machine that has no connected node. To provide that fallback without duplicating
logic, the primitive lives here once and both services import it — node as primary owner,
gateway as fallback caller.

## Canonical documents

- [ADR-046: Mandatory co-located local node](../../docs/adr/046-mandatory-local-node.md) — why this package exists, what does and does not get a gateway fallback, and the future direction (node as a thin transport over this library).

## Install

```bash
yarn add @farmslot/capabilities @farmslot/protocol
```

## Main exports

```ts
import { watchFile } from '@farmslot/capabilities/fs-watch';
import { encodeNodeFrame, decodeNodeFrame } from '@farmslot/capabilities/screen-frame';
import { createH264FrameSplitter } from '@farmslot/capabilities/screen-h264';
```

| Import                                                     | What it is                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `fs-watch` — `watchFile()`                                 | Native `fs.watch` with the "watch the parent directory until the file appears" fallback and tilde expansion. Returns a stop handle. |
| `screen-frame` — `encodeNodeFrame()` / `decodeNodeFrame()` | The node→gateway capture-frame binary envelope codec (`0xAF` magic). Node encodes, gateway decodes.                                 |
| `screen-h264` — `createH264FrameSplitter()`                | Splits a raw `adb screenrecord --output-format=h264` byte stream into individual video frames.                                      |

## Source layout

| Path                  | Owns                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| `src/index.ts`        | Public package export surface.                                                     |
| `src/fs-watch.ts`     | `watchFile()` — native file-change watch primitive.                                |
| `src/screen-frame.ts` | `encodeNodeFrame()` / `decodeNodeFrame()` — the node→gateway frame envelope codec. |
| `src/screen-h264.ts`  | `createH264FrameSplitter()` — raw H.264 elementary-stream frame splitter.          |

## Maintenance rules

1. **Node-only runtime.** Uses `node:fs` / `node:child_process`; never import DOM or gateway/node-internal modules here.
2. **Protocol types only.** Shared constants (e.g. the frame magic) come from `@farmslot/protocol`; keep `Buffer`-based helpers out of the UI-shared protocol bundle.
3. **One implementation, two callers.** A primitive belongs here only when both the node (primary) and the gateway (local fallback) genuinely use it — not as a util grab-bag.
4. **No hidden shared state.** Each primitive is instance-scoped (a handle/splitter per caller); do not add module-level singletons that leak across callers.

## Local quality

```bash
yarn workspace @farmslot/capabilities quality
```
