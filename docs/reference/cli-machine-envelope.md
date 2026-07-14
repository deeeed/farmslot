# CLI Machine Envelope

The `farmslot` CLI is dual-mode: one command core, two renderers. This document
defines the machine contract for scripts and agents.

## Mode selection

| Mode    | Trigger                                                | Output                              |
| ------- | ------------------------------------------------------ | ----------------------------------- |
| Machine | `--json` flag, or stdout is not a TTY (piped/scripted) | Exactly one JSON envelope on stdout |
| Human   | interactive TTY without `--json`                       | Formatted tables/text               |

Progress and spinners are written to stderr only, and only when stderr is a
TTY — stdout stays pure in machine mode.

## Envelope shape

```ts
{
  schemaVersion: 1,
  command: string,       // dotted command path, e.g. "slot.prepare"
  status: "ok" | "error",
  exitCode: number,      // matches the process exit code
  data?: unknown,        // status "ok": the RPC/domain result, unwrapped
  error?: {
    code: string,        // stable machine code, e.g. SLOT_NOT_FOUND
    message: string,
    userAction: string,  // exact next command(s) for THIS situation
    details?: unknown    // e.g. { availableSlotIds: [...] }
  }
}
```

## Teach-the-escape rule

Every error envelope MUST carry `userAction` naming the exact next command(s)
that resolve this specific failure — never a generic "check your setup". Error
codes and `userAction` originate at the source (gateway `GatewayMethodError`,
carried through the RPC frame) and fall back to CLI-side guidance (e.g. a
refused connection suggests `farmslot up` / `--url` / `farmslot doctor`).

Human mode renders the same information as an `Error:` line followed by
`Next: <userAction>`.

## Exit codes

- `status: "ok"` → process exits `0` (exception: `doctor` reports `ok` data with
  `exitCode: 1` when checks fail — the diagnosis succeeded, the verdict did not).
- `status: "error"` → process exits non-zero, matching `exitCode`.
- Unknown commands exit non-zero.

## Instant-feedback rule (human mode)

Every human-mode invocation MUST acknowledge within ~200ms — a spinner, the
first stream line, or an explicit pending state. No command sits silent until it
completes. This keeps the terminal responsive: the operator always knows the CLI
received the command and is working.

| First-feedback class | When to use                                           | Helper                                     |
| -------------------- | ----------------------------------------------------- | ------------------------------------------ |
| instant              | pure-local work; a header printed before any RPC      | (synchronous `output.write`)               |
| spinner              | one-shot RPCs (`client.call`)                         | `withProgress(label, work, !machine)`      |
| streams              | long ops emitting `script.output` (prepare/release/…) | `withStreamProgress(label, run, !machine)` |

- **One-shot RPCs**: wrap the human-branch `client.call` in `withProgress` so a
  spinner shows within ~80ms. Gate it on `!emit.machine` (or `!output.json`) —
  never spin in machine mode.
- **Streaming ops**: `withStreamProgress` shows the label immediately, then
  clears it the instant the first `script.output` byte arrives and streams the
  rest. This closes the silent gap before the gateway's first stream line.
- **TUI actions**: set an immediate pending notice on keypress (e.g.
  `dispatching MANUAL-000014…`) before awaiting the RPC, and show
  `connecting to <url>…` until the first `fleet.status` snapshot lands.

Spinners and pending output go to **stderr only**, so machine-mode stdout stays
a single pure envelope. Sub-200ms responses need no visible spinner — the frame
interval simply never fires before the call resolves.

**Exemptions:** machine mode (`--json` / non-TTY stdout — one envelope is the
contract) and the raw plumbing escape hatches (`internal` raw/`--shell` modes
and `rpc`), whose stdout is a raw data channel for scripts.

Implementation: `packages/cli/src/progress.ts` (`withProgress`,
`withStreamProgress`). Tests: `packages/cli/src/progress.test.ts`.

## `run get` envelope shape

`run get [--json]` returns `{ run: Run }` under `data`; `run.status` is a
required `RunStatus` (never null). A stray "`.data.run.status` is null" reading
comes from indexing a **`run list`** envelope (whose payload is `data.runs[]`,
so `data.run` is `undefined`) — read `data.runs[i].status` for lists and
`data.run.status` for a single `run get`.

## Covered commands

`fleet`, `slot`, `run`, `runs`, `dispatch`, `backlog`, `pair`, `doctor`, and
the `internal` plumbing verbs emit the envelope (for `pair` the QR payload
lives under `data.payload`). `internal` raw/`--shell` modes are the one
exception by design: their stdout is a raw data channel for scripts, so
failures go to stderr with a non-zero exit instead of a stdout envelope.

Implementation: `packages/cli/src/envelope.ts` (`createEmitter`). Contract
tests: `packages/cli/src/envelope.test.ts`.
