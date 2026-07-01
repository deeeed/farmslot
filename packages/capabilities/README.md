# @farmslot/capabilities

Machine-local capability primitives shared by the **node** (`services/node`) and the
**gateway** (`services/gateway`). Introduced by [ADR-046](../../docs/adr/046-mandatory-local-node.md).

The node owns machine-local capabilities; the gateway keeps a degraded **local fallback**
for a machine that has no connected node. To provide that fallback without duplicating
logic, the primitive lives here once and both services import it — node as primary owner,
gateway as fallback caller.

## Modules

| Import                                                                            | What it is                                                                                                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@farmslot/capabilities/fs-watch` — `watchFile()`                                 | Native `fs.watch` with the "watch the parent directory until the file appears" fallback and tilde expansion. Returns a stop handle. |
| `@farmslot/capabilities/screen-frame` — `encodeNodeFrame()` / `decodeNodeFrame()` | The node→gateway capture-frame binary envelope codec (`0xAF` magic). Node encodes, gateway decodes.                                 |
| `@farmslot/capabilities/screen-h264` — `createH264FrameSplitter()`                | Splits a raw `adb screenrecord --output-format=h264` byte stream into individual video frames.                                      |

## Scope

Node-only runtime code (`node:fs`, `node:child_process`). Depends on `@farmslot/protocol`
for shared constants but keeps `Buffer`-based helpers out of the UI-shared protocol bundle.
Not every node capability belongs here — see ADR-046 for what does and does not get a
gateway fallback (e.g. macOS capture stays node-only; `execLocal` stays gateway-side).
