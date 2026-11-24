# Run traces

Design specification for [ADR-039 Amendment 9](../adr/039-run-portable-bundles.md#amendment-9-2026-11-24-run-traces-as-private-training-data).
**Status:** Proposed. Nothing here is implemented until the amendment is accepted.

A run trace is a run's agent transcripts plus its outcome labels, kept so that
past runs can train and compare models. It reuses the episode
([Run episodes](run-episodes.md)) as its index and the ADR-056 session archive as
its transcript store.

## Transcript capture

| Moment                                                                          | Contexts archived                             |
| ------------------------------------------------------------------------------- | --------------------------------------------- |
| Worker completion (signal `complete`, `no-change` or `blocked`)                 | the worker context                            |
| A review round settles                                                          | that round's reviewer context(s)              |
| A review fix settles                                                            | the review-fix context                        |
| Before a replay relaunches a step, or an operator completion replaces a context | every context the step or completion replaces |
| Slot release (unchanged backstop)                                               | every context still unarchived                |

- The copy is ADR-056's: from the node that ran the context, runner-native bytes,
  `sha256` and size recorded on the agent context, `missing` or `unsupported` with
  a reason. Capture never fails or delays a transition; the copy runs after the
  transition commits.
- A context archived once is not copied again unless its source changed (size or
  mtime), so slot release finds most work done.
- The 32 MiB per-transcript limit stays. A transcript over it is recorded
  `missing` with its size, so the corpus shows what was dropped.

## Labels

Additive fields under `labels` in `farmslot-episode-v1`. Values are copied from
the run record and from manifests episode capture already reads; capture never
opens or re-hashes an artifact. A value that is not known is `null`, never guessed.

| Field                   | Content                                                           | Source                                             |
| ----------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `labels.roles[]`        | `role, contextId, runner, model, effort`                          | agent contexts, run metrics                        |
| `labels.cost`           | `usd, inputTokens, outputTokens, totalTokens, source`             | run metrics (`costEstimate`, session token counts) |
| `labels.acceptance[]`   | `criterionId, verdict, source`                                    | acceptance status manifest already referenced      |
| `labels.reviewRounds[]` | `round, contextId, reviewer {runner, model}, verdict, issueCount` | review results already referenced                  |
| `labels.gate`           | `outcome, decidedAt, decision`                                    | resolved gate decisions                            |
| `labels.git`            | `startRef, dispatchHead, finalHead, prHead, mergeSha`             | run record and PR integration                      |
| `labels.grades`         | count of external grades at capture time                          | grade sidecar                                      |

## External grades

`run.grade.external.record { runId, source, scale, verdict, note?, gradedBy }`
appends one line to `<runs dir>/grades/<run-id>.jsonl`:

```json
{
  "source": "sparks-eval-phase2",
  "scale": ["match", "partial", "wrong"],
  "verdict": "partial",
  "note": "…",
  "gradedBy": "sparks",
  "gradedAt": "2026-11-24T10:00:00Z"
}
```

- `verdict` must be one of `scale`. Lines are append-only; a correction is a new
  line, and the latest line per `source` wins at export.
- The existing `grade` (difficulty) and `humanGrade` (recipe semantics) fields on
  the run are unchanged and exported as they are.

## Export

`farmslot runs traces export --out <dir> [--project <name>] [--flow <type>] [--since <date>] [--until <date>] [--family <id>] [--has-grade]`
calls `run.traces.export` and writes:

```text
<dir>/
  index.jsonl                 one row per run: runId, project, flow, status, outcome, grade verdicts, transcript counts, bytes
  runs/<run-id>/
    labels.json               identity, episode labels, grades, run-level grade fields
    transcripts/<contextId>.jsonl
    redaction.json            what was replaced, by rule and count (never the values)
  README.md                   filter, Farmslot version, redaction rules, counts
```

- `labels.json` = episode identity (`runId, project, flowType, status, input.ticket`)
  - `labels` + external grades + `grade` and `humanGrade`.
- Transcripts come from `session-archives`, or from the run archive after
  Amendments 3 and 7 archival. Each copy's bytes are checked against the recorded
  `sha256` before export; a mismatch is listed in `index.jsonl` and the transcript
  is skipped.
- A project with `traces.capture: false` is skipped and counted in `README.md`.
- Export is read-only against all stores, writes only `<dir>`, and refuses a
  non-empty `<dir>`.

### Formats

| Runner                           | Written as                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------- |
| Claude Code, Codex, Pi           | native JSONL, unchanged except redaction (the Hub viewer reads these)         |
| Grok                             | Session Trace Simple Format (STS-Format), converted from `chat_history.jsonl` |
| Cursor, OpenCode, scripted, none | no transcript; `labels.json` records `unsupported`                            |

STS-Format: a header line `{"type":"session","harness":"farmslot-<runner>","id":<runnerSessionId>,"name":<run summary>}`,
then one `{"type":"message","message":{role, content, reasoningContent?, toolCalls?, toolCallId?, timestamp?, model?}}`
per turn. Records a converter cannot map are skipped and counted in
`redaction.json` as `unmapped`.

### Redaction

Applied to the exported copies only, in this order:

1. The publication secret scan (`host-services/secret-scan`): each finding is
   replaced with `[REDACTED:<rule>]`.
2. Home directories (`/Users/<name>`, `/home/<name>`) become `~`.
3. Machine names from the pool become `<machine>`.

A transcript that the scanner cannot read is left out, not exported raw.

## Privacy

Traces hold private code, testnet account data and LiteLLM traffic, which is
employer-owned. They stay private and local. Farmslot has no upload command or
RPC; publishing an export is a manual decision taken outside Farmslot.

## Cost

Measured on the dev gateway, 2026-11-24:

| Item                   | Today                                           |
| ---------------------- | ----------------------------------------------- |
| Transcripts per run    | median 7.7 MB, p90 42 MB, max 154 MB (159 runs) |
| Episode                | median 2.7 KB, max 724 KB (1083 episodes)       |
| Gzip on 40 transcripts | 2.5x, so transcripts stay uncompressed          |

Earlier capture adds the missing reviewer transcripts, at about the same
per-context size. The copy happens once per context, after the transition
commits. Inline labels add a few kilobytes per episode. Export runs offline.
