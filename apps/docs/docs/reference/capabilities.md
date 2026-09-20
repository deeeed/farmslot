---
title: Capabilities
---

# Capabilities

`@farmslot/capabilities` holds the machine-local primitives that both the Farmslot **node** (`services/node`) and the **gateway** (`services/gateway`) run. The node is the primary owner of machine-local capabilities; the gateway keeps a degraded local fallback for a machine with no connected node. Each primitive lives here once so neither side duplicates it ([ADR-046: Mandatory co-located local node](https://github.com/deeeed/farmslot/blob/main/docs/adr/046-mandatory-local-node.md)).

The package ships TypeScript source and is consumed through `tsx`; it depends only on `@farmslot/protocol` for shared constants.

## Install

```bash
yarn add @farmslot/capabilities @farmslot/protocol
```

## Exports

| Import                                                     | What it is                                                                                                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs-watch` — `watchFile()`                                 | Native parent-directory `fs.watch` that survives atomic file replacement, filters to the target filename, deduplicates content, and expands tildes. Returns a stop handle. |
| `screen-frame` — `encodeNodeFrame()` / `decodeNodeFrame()` | The node-to-gateway capture-frame binary envelope codec (`0xAF` magic). Node encodes, gateway decodes.                                                                     |
| `screen-h264` — `createH264FrameSplitter()`                | Splits a raw `adb screenrecord --output-format=h264` byte stream into individual video frames.                                                                             |

```ts
import { watchFile } from '@farmslot/capabilities/fs-watch';
import { encodeNodeFrame, decodeNodeFrame } from '@farmslot/capabilities/screen-frame';
import { createH264FrameSplitter } from '@farmslot/capabilities/screen-h264';
```

## Rules for contributors

1. Node-only runtime (`node:fs`, `node:child_process`); never DOM, gateway or node internals.
2. Shared constants come from `@farmslot/protocol`; `Buffer` helpers stay out of the UI-shared protocol bundle.
3. A primitive belongs here only when both the node (primary) and the gateway (fallback) use it.
4. Instance-scoped handles only; no module-level singletons.

See also: [Agent runtime](agent-runtime.md) and [Task directory contract](task-directory-contract.md).
