# Agent Runtime

`@farmslot/agent-runtime` is the reusable task lifecycle layer for Farmslot-compatible agent runs. It can be used by full Farmslot dispatch, a project harness, or a skills-only workflow without Command Center, gateway, pools, or slots.

## Boundary

| Package                    | Owns                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@farmslot/protocol`       | Pure contracts, types, validators, and shared constants.                                                                                                  |
| `@farmslot/recipe-harness` | Recipe graph execution and recipe artifact package writing.                                                                                               |
| `@farmslot/agent-runtime`  | Task-local marking, `SIGNAL.json`, checklist timing, worker terminal contract resolution, closeout artifact checks, and recipe-quality artifact building. |
| `@farmslot/skills`         | Agent instructions and installer behavior; legacy runtime paths are shims.                                                                                |

## Task Directory

A runtime-compatible task directory contains:

- `CHECKLIST.md` with `- [ ]` checklist items (the execution checklist) beside `TASK.md`, the task document that holds the ticket and acceptance criteria and is never enumerated (see [Task directory contract](task-directory-contract.md));
- `artifacts/` for reports, learnings, recipe outputs, and evidence;
- `SIGNAL.json`, written by `mark` only;
- optional `inputs/worker-terminal-contract.json` for project-specific terminal requirements;
- `mark`, a task-local executable shim installed by the gateway or `farmslot-agent install-mark`.

Agents should use the task-local shim:

```bash
./mark start
./mark 1
./mark complete --mark-last
```

Do not hand-write `SIGNAL.json`. The runtime preserves pass-through fields, records checklist timing, verifies terminal artifacts, and writes the terminal status atomically.

## CLI

```bash
farmslot-agent install-mark <task-dir> --task TASK.md --signal SIGNAL.json
farmslot-agent mark <task-md> <signal-json> complete --mark-last
farmslot-agent artifact-check <task-dir> --require-recipe-quality-if-recipe
farmslot-agent recipe-quality build --input recipe-quality-input.json --output artifacts/recipe-quality.json
farmslot-agent contract resolve --flow fix-bug
```

`artifact-check` validates task closeout files. When recipe artifacts exist, `recipe-quality.json` must satisfy the shared `RecipeQualityArtifact` validator from `@farmslot/protocol`.

`recipe-quality build` lets an agent provide the fields it knows after review — verdict, reasons, findings, suggested deltas, and proof metadata — and receive a complete `artifacts/recipe-quality.json` that passes the protocol validator. Use an input JSON file for nested findings/dimensions and repeated CLI flags for simple cases:

```bash
farmslot-agent recipe-quality build \
  --verdict warn \
  --reason 'Main claim is covered, teardown proof is missing.' \
  --delta 'Add a teardown assertion node.' \
  --proof-mode mixed \
  --output artifacts/recipe-quality.json
```

The builder preserves additive metadata under `extra` while protecting the required protocol fields from being overwritten. Use `--input -` to read compact JSON from stdin. CLI flags override file-provided scalar and array fields; `trainingFields` merge field-by-field so flags can refine proof metadata without dropping project or flow metadata.

## Compatibility

The previous script paths in `@farmslot/skills` and `scripts/quality/` remain compatibility shims for one migration window. New templates should point to `packages/agent-runtime/scripts/*` in the Farmslot monorepo or use `farmslot-agent` when installed as a package.

## Native session host

`@farmslot/agent-runtime/native` exports `NativeSessionClient`. The gateway runner
layer validates registry capabilities and model policy, then calls this client.
Execution nodes can use the same runtime without importing gateway code.

The client starts a detached supervisor and host on demand. The host owns native
stdin; the supervisor stops wrapper groups and observed descendants after host failure.
The native launch wrapper waits for durable PID registration before executing the
installed binary. Closing a session waits for that cleanup to finish.
A gateway or browser disconnect only ends its RPC connection.

Set `FARMSLOT_NATIVE_STATE_DIR` to a stable private directory for each configured
execution profile. The default is `native-sessions` beneath `FARMSLOT_HOME`, or
`~/.farmslot/native-sessions` when no home override is configured. State directories
require mode 0700 and files use 0600. A hashed socket path under `/tmp` fits macOS
limits. IPC uses a private random bearer token, distinct from provider credentials.
Native authentication environment and configuration stay inherited locally;
the runtime does not serialize them or send them over IPC. Account labels under
one OS user do not provide tenant isolation.

Session journals append events and changed metadata/receipts, fsyncing command
intent before submission. Receipts distinguish pending, unknown, accepted, failed
and completed. `submitted` records a submission attempt; only `accepted` records
native acknowledgement. A lost reply or unknown receipt never triggers a resend.
`read` accepts `after` and `limit`, returns a cursor and `hasMore`, and exposes the
latest 100 receipts. Older IDs remain deduplicated across process generations;
a missing receipt in a page does not mean the command was never submitted. Consume each page once and
persist its returned cursor. Pending interactions are separate from the event
page. Respond with `request.id`; `nativeId` is evidence, not an input token.

After runner or host failure, reads expose failure and recovery instructions.
Explicit `create` with the recorded `resumeSessionId` retains the Farmslot session
ID and command history, and starts a new generation only after confirmed cleanup
of the previous generation. It preserves the working directory and native account configuration.
It never starts a blank conversation as a recovery fallback. Unknown acceptance
remains unknown, including after resume. Stale approval IDs cannot target the new
generation. An interrupt reply acknowledges native control; the ordered terminal
turn event supplies the actual interrupted/completed outcome.

The host uses source entry points with the workspace TypeScript loader during
development, and packaged `dist/native` entry points after `yarn workspace
@farmslot/agent-runtime build`. Ship the entire native output directory. Existing
hosts retain their loaded code until stopped. Finish/close sessions before an
operator stops the supervisor for an upgrade; restarting the gateway alone keeps
those sessions on the existing host.

A partial ownership claim or a surviving process whose death cannot be verified
blocks automatic takeover. Inspect `host.log`, the private lock/worker records,
and the recorded process groups before removing a stale claim. Never remove a
lock while its supervisor or host is alive. PID reuse is treated conservatively;
the runtime does not kill an unrelated live group to force recovery. The supervisor and each runner track OS descendant identity and retain detached
children for cleanup. They stop observed owners before the final process scan and
verify process start metadata before each signal. Processes that fully daemonize
and reparent between scans cannot be attributed reliably; full OS containment and
node-loss survival remain outside this phase. Journals currently remain on disk for the
session lifetime and load into host memory; archival/compaction is not implemented.

See the staged live proof in the runner validation operations guide. Local
regressions run with `node --import tsx --test
packages/agent-runtime/src/native/durability.test.ts`. The host test needs permission
to bind a local Unix socket. The same regression can run from the built output
with `node --test packages/agent-runtime/dist/native/durability.test.js`.
