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

## Covered commands

`fleet`, `slot`, `run`, `runs`, `dispatch`, `backlog`, `pair`, `doctor`, and
the `internal` plumbing verbs emit the envelope (for `pair` the QR payload
lives under `data.payload`). `internal` raw/`--shell` modes are the one
exception by design: their stdout is a raw data channel for scripts, so
failures go to stderr with a non-zero exit instead of a stdout envelope.

Implementation: `packages/cli/src/envelope.ts` (`createEmitter`). Contract
tests: `packages/cli/src/envelope.test.ts`.
