# Run traces

Design specification for [ADR-039 Amendment 10](../adr/039-run-portable-bundles.md#amendment-10-2026-11-24-run-traces-as-private-training-data).
**Status:** Accepted by Arthur, 2026-11-24. Implemented.

A run trace is a run's agent transcripts plus its outcome labels, kept so that past
runs can train and compare models. It reuses the episode ([Run episodes](run-episodes.md))
as its index and the ADR-056 session archive as its transcript store. The external
format is the [Hugging Face agent traces](https://huggingface.co/docs/hub/en/agent-traces)
viewer and its [Session Trace Simple Format](https://huggingface.co/docs/hub/en/session-traces-format).

The design was checked against a prototype export of 22 graded runs (Part B, local
only). In that set, 5 of 22 worker sessions and 18 of 22 reviewer sessions existed
only on the node that ran them.

## Transcript capture

| Moment                                                                          | Sessions archived                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Worker completion (signal `complete`, `no-change` or `blocked`)                 | the worker session                                              |
| A review round settles                                                          | that round's reviewer session(s)                                |
| A review fix settles                                                            | the review-fix session                                          |
| Before a replay relaunches a step, or an operator completion replaces a session | every session the step or completion replaces                   |
| Slot release (backstop)                                                         | every session not yet `captured`, including `missing` ones      |
| `farmslot runs bundle retain <runId>`                                           | every session not yet `captured`, while its node still holds it |

- **Keying.** An archive lives at
  `session-archives/<run>/<contextId>/<sessionKey>/transcript.jsonl`, where
  `sessionKey` is the runner session id, or the attempt index when there is none. A
  context reused across rounds (`review-fix`) keeps every round. A review-fix ref
  records `answersRound`, the review round it fixes.
- **Ref.** `{status, sessionKey, runner, originalPath, sourceSize, sourceMtimeMs,
sha256, sizeBytes, capturedAt, answersRound?, reason?}`. A source whose size and
  mtime match a `captured` ref is not copied again; slot release stats it once to
  check.
- **Ref lists and the single ref.** Agent contexts gain `runnerSessionArchives[]`
  and run metrics gain `metrics.runnerSessionArchives[]` (the worker), one ref per
  session in capture order. The existing single refs (`runnerSessionArchive` on a
  context, `metrics.runnerSessionArchive` for the worker) stay, and each always
  points at that context's latest captured session. History
  (`methods/worker-session-history.ts`) and usage (`runtime/session-usage.ts`,
  `runners/claude-usage-sessions.ts`) keep reading one session through the single
  ref, so usage still counts the latest session per context, as today; summing
  every session is not part of this change.
- **Archive path resolution.** The archive read helpers in
  `runners/session-archive.ts` (`readRunnerSessionArchiveLines`,
  `verifiedRunnerSessionArchivePath`) build the path from the ref's `sessionKey`,
  `<contextId>/<sessionKey>/transcript.jsonl`, and fall back to the legacy
  `<contextId>/transcript.jsonl` when the ref has no `sessionKey` or its key is
  `legacy`. History and usage go through these helpers, so they follow the new
  layout without changes of their own.
- **Legacy archives.** An archive written before this change, at
  `session-archives/<run>/<contextId>/transcript.jsonl` with only a single ref, reads
  as a one-element list whose `sessionKey` is `legacy`. That key exists only in
  this list view; it is never written to a ref. Nothing is moved or rewritten.
- **Readers that change.** The episode writer (`run-completion/run-episode.ts`)
  lists every session in `trajectory.agents` and [Run episodes](run-episodes.md)
  documents the per-session shape; the archive read helpers in
  `runners/session-archive.ts` resolve the path from the ref (above); the run store
  and agent contexts (`runs/store.ts`, `agents/contexts.ts`) patch the list; list
  rows (`protocol/runs/list-row.ts`, `list-trim.ts`) trim the list as they trim the
  single ref; the portable bundle (`protocol/runs/portable-bundle.ts`) strips the
  list's local paths as it strips the single ref's; the review QA migration
  (`run-engine/review-qa-migration.ts`) carries the list with the ref.
- **Atomic write.** The copy goes to a temporary file in the session directory and
  is renamed into place. A failed copy deletes only its temporary file, never a
  previously captured transcript.
- **One capture per run at a time.** Captures for a run run one after another.
  Slot release joins a pending capture instead of starting a second one. A ref is
  written with a patch of that context's archive list alone, never by rewriting the
  run's whole metrics object.
- **Replay.** The old session's path is saved on its context when the session
  ends. Before a replay relaunches the step, that path is captured synchronously.
  The 30-second bound includes waiting for the run's in-flight capture to finish;
  if the queue has not drained or the copy has not finished by then, the session
  is recorded `missing` (reason `capture-timeout`) and the replay goes on. Slot
  release retries it while the file still exists.
- **Elsewhere, after the commit.** Other captures run after the transition
  commits; a failure records `missing` with a reason and never blocks or reverts
  the transition.
- **Node unreachable.** The capture records `missing` with the error. Slot release
  and `bundle retain` retry it. A later slot reset leaves it `missing`, with the
  first reason and the time of the last attempt.
- **Limits.** The 32 MiB per-transcript limit stays. A larger transcript is
  recorded `missing` with its size, so the dataset shows what was dropped.
- **Runners.** Claude Code, Codex, Grok and Pi archive JSONL. Cursor, OpenCode,
  scripted, none and `claude-acp` record `unsupported`.

## Labels

Additive fields under `labels` in `farmslot-episode-v1`, beside the existing
reference lists (`reviews[]`, `evidence[]` and the rest stay as they are). Every
value comes from a run-record field; capture opens no task artifact. A field that
is absent means the episode was captured before it existed. A value that is
`null` is not known. Fields marked _new run field_ do not exist on the run today;
the implementing PR adds them, and until then the label is `null`.

| Field                   | Content                                                                                                          | Source                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labels.task`           | `lane, variant, familyId, mode, completionPolicy, templateId, templateSha256, note, launchPlanId, candidateId`   | run record: `executionTemplate.id` and `.sha256`, `taskNote` (the operator task note text), `launchPlanId` and `launchCandidateId` (the launch-plan candidate)                                                 |
| `labels.roles[]`        | `role, contextId, runner, model, effort, sessions[] {sessionKey, status, answersRound?}`                         | agent contexts                                                                                                                                                                                                 |
| `labels.cost[]`         | per context: `contextId, role, inputTokens, outputTokens, cacheReadTokens, totalTokens, usd, usdSource`          | worker: run metrics (`costEstimate` is the worker session's USD cost, plus the session token counts); reviewers: each review attempt's `usage`; `usdSource` is `recorded` or `null` when no price was recorded |
| `labels.acceptance`     | `source (registered, derived or none), criteria[] {id, text, verdict}`                                           | the acceptance ledger snapshot on the run: the gate's `acceptanceStatus`, else a completion snapshot (_new run field_)                                                                                         |
| `labels.reviewRounds[]` | `round, contextId, sessionKey, reviewer {runner, model}, verdict, unresolvedCount, fix {contextId, sessionKey}?` | review loops and their attempts (`loopNumber`, `verdict`, `unresolvedCount`)                                                                                                                                   |
| `labels.gate`           | `outcome, decision, decidedAt`                                                                                   | the latest resolved `engine_human_gate` decision, with the run's outcome                                                                                                                                       |
| `labels.attempts[]`     | `kind (dispatch, replay, recovery, infra-failure, operator), step, at, error?, recovery?`                        | step history and recovery records; replays and infra failures that leave no record today get an append-only attempt log (_new run field_)                                                                      |
| `labels.infraOnly`      | true when the run ended on infra failures alone, with no agent outcome                                           | derived from `attempts` and the outcome                                                                                                                                                                        |
| `labels.output`         | `diffSha256, source (committed, working-tree or parked-ref), ref, path`                                          | _new run field_, written at finalize and at release (a parked ref when release parks unpushed work); `path` names the retained diff (below)                                                                    |
| `labels.git`            | `startRef, dispatchHead, finalHead, prHead, mergeSha`                                                            | `startRef` and `dispatchHead` as today; the other three are _new run fields_                                                                                                                                   |

**The graded diff is retained.** When finalize or release records `labels.output`,
the gateway also writes the diff it graded, against `dispatchHead`, as
`outputs/<run-id>/graded.diff` in the episode store, replaced by rename, with the
sha256 it records. Retained bundles are content-addressed and immutable, so the
diff sits beside the episode instead, and is kept as long as the episode:

- **Committed** or **parked-ref** output: `git diff <dispatchHead> <ref>`.
- **Working-tree** output: the tree is staged into a temporary index, then
  `git diff --cached <dispatchHead>` reads it, so new untracked files are included
  and the slot's own index is not touched. The temporary index starts as a copy of
  the slot's index, so Git's stat cache hashes only changed files, at a fresh path
  (a file that exists but is empty is not a valid index); then
  `GIT_INDEX_FILE=<that path> git add -A`, which honours `.gitignore`.

`labels.output.path` names that file, relative to the episode store. A diff larger
than 32 MiB is recorded with its sha256 and size and no bytes. Finalize records
the published commit; release records an unpublished working tree before the slot
resets. A run with no ready-gate acceptance gets its completion snapshot from the
ledger in its retained task directory, at release or `bundle retain`.

Writing a new run field updates the run. The retention pass recaptures every
episode whose run changed since its last pass, so a merge recorded after the run
ended reaches the episode within an hour.

Episodes captured before this change gain label values through a bulk recapture.
`farmslot runs episodes recapture --since <date> [--until <date>]` calls the gateway
method `run.episode.recapture { since, until? }`, which returns the number of runs
queued and writes each episode through the same writer the retention pass uses. That
writer writes one run's episode at a time and replaces the file by rename, so a
retention recapture of the same run at the same moment writes the same content
again rather than racing it.

## External grades

`run.grade.external.record { runId, source, grader, scale, verdict, rubric?, reason?, gradedAt? }`
appends one line to `grades/<run-id>.jsonl` in the episode store
(`currentFarmPaths('gateway').state.episodes`, or `<runs dir>/episodes` in the legacy
layout). The gateway adds `recordedBy` (the calling principal) and `recordedAt`:

```json
{
  "source": "sparks-eval-phase2",
  "grader": "sparks",
  "scale": ["match", "core", "partial", "worse", "wrong"],
  "verdict": "partial",
  "rubric": [{ "point": "Default panel is the order book", "verdict": "met" }],
  "reason": "…",
  "gradedAt": "2026-11-24T10:00:00Z",
  "recordedBy": "farm-automation",
  "recordedAt": "2026-11-24T10:05:00Z"
}
```

- `source` names the evaluation that produced the grade (a dataset or phase id).
  `grader` names who or what judged: a person, a model id or a script. `gradedAt`
  is when the judgement was made (default: `recordedAt`). `recordedBy` is the
  principal that recorded it, which may differ from the grader.

- `verdict` must be one of `scale`. Several graders may grade one run. Lines are
  append-only; a correction is a new line, and export takes the latest line per
  `(source, grader)`.
- Recording a grade does not rewrite the episode; export reads the sidecar.
- The run's existing `grade` (difficulty) and `humanGrade` (recipe semantics) are
  unchanged and exported as they are.

## Interviews (optional)

`run.interview.record { runId, kind, text }` stores a post-run interview, such as
an ask-why `why.md`, as `interviews/<run-id>/<n>-<kind>.md` in the episode store.

- `kind` is one of `why`, `debrief` or `note`; any other value is refused, so it
  never reaches a path unchecked.
- `<n>` is the next three-digit number for the run, shared by every kind. It is
  reserved by exclusively creating a hidden `.<n>` marker, retrying with the next
  number when one exists, so concurrent records never take the same number or
  overwrite each other. Export skips the markers.
- Interviews are optional, append-only and exported beside the labels. Like
  episodes and grade files, they are kept forever with the run record.

## Opt-out

`traces.enabled: false` in `project.json` opts a project out of training traces:

- Capture keeps ADR-056's slot-release snapshot for History only.
- Inline labels are still written, because they are part of the episode.
- The grade and interview RPCs still accept records.
- Export skips the project's runs. It reads the flag at export time, so a project
  that opts in later exports runs whose transcripts were captured only at release.

Run retention is not changed by the opt-out.

## Export

`farmslot runs traces export --out <dir> [--project <name>] [--flow <type>] [--since <date>] [--until <date>] [--family <id>] [--has-grade] [--update]`
runs in the CLI process, offline from the gateway, on the gateway's host: it reads
the gateway's stores directly, resolved through `farmslot paths --json` for the
gateway role (ADR-039 Amendment 6), and refuses on a host where those stores are
absent. It reads them read-only and writes only `<dir>`. `--has-grade` keeps runs
with at least one external grade line; a run's `humanGrade` is exported but does
not count.

```text
<dir>/
  index.jsonl                 one row per run: runId, project, flow, status, outcome, infraOnly, grade verdicts, transcripts present/missing, bytes
  runs/<run-id>/
    labels.json               identity, episode labels, external grades, grade, humanGrade
    transcripts/<contextId>-<sessionKey>.jsonl
    task.md                   TASK.md, when its bytes are retained
    output.diff               the graded diff, when its bytes are retained
    interviews/*.md
    redaction.json            counts per rule, never the values
  README.md                   filter, Farmslot version, redaction rules, counts, runs skipped and why
```

- Transcripts are read from `session-archives`, or from the run archive through
  `<archive-root>/<run-id>/manifest.json` after archival. `task.md` comes from the
  run's retained bundle, read without opening or repairing the bundle store, and
  `output.diff` from the episode store. Each copy is checked against its recorded
  `sha256`; a mismatch is listed in `labels.json` and the file is skipped.
- A missing transcript (node offline, slot reset, size limit) is reported in
  `index.jsonl` and `README.md` with its reason. Export never fails for it.
  Without `--update`, export refuses a non-empty `<dir>`.
- `--update` on an existing export, for each run that matches the filter: adds
  transcripts captured since (for example after the node returns and
  `bundle retain` recaptures them), and rewrites that run's `labels.json` (new
  grades and label values) and `redaction.json`. It then rewrites `index.jsonl` and
  `README.md` for the whole export. It never deletes an exported file, so a run that
  no longer matches the filter keeps its folder and stays in the index.
- Export never invents a transcript or a label value. Cost is the one derived value:
  tokens are always exported, and when `usd` is `null`, export prices the tokens
  from the model price table it ships with and marks `usdSource: "export-table"`;
  a model without a price stays `null`.
- Filters are applied to episodes in the CLI process. The gateway does no work.

### Formats

| Runner                                         | Written as                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| Claude Code, Codex, Pi                         | native JSONL, unchanged except redaction (the Hub viewer reads these) |
| Grok                                           | Session Trace Simple Format, converted from `chat_history.jsonl`      |
| Cursor, OpenCode, scripted, none, `claude-acp` | no transcript; `labels.json` records `unsupported`                    |

Session Trace Simple Format: a header line
`{"type":"session","harness":"farmslot-<runner>","id":<runnerSessionId>,"name":<run id>}`,
then one `{"type":"message","message":{role, content, reasoningContent?, toolCalls?, toolCallId?, timestamp?, model?}}`
per turn, with `role` one of `user`, `assistant`, `system` or `tool`. The header
name is the run id, not a summary, so it carries no task text. Records a
converter cannot map are skipped and counted in `redaction.json` as `unmapped`.

### Redaction

The publication secret scan only detects (it reports a kind and a fingerprint, with
no position), so export uses its own replacing scrubber. It runs line by line, so
JSONL stays valid, and applies to every file export writes: transcripts,
`labels.json`, `task.md`, `output.diff`, interviews, `index.jsonl`, `README.md`
and file names. Rules, in order:

1. The exact values of the farm's configured secrets on the gateway host: provider
   environment values, gateway and node tokens, and LiteLLM keys, read from the
   gateway's configuration through the same paths.
2. The publication scan's patterns, made replacing.
3. Private keys: a hex string of 64 or more characters (with or without `0x`)
   that is labelled as a key, meaning a key-like name (`privateKey`, `private_key`,
   `secret`, `seed`, `mnemonic`) on the same line or assigned the value. Bare hex is
   kept, because it is usually a digest. Digests Farmslot writes itself (`sha256`,
   `diffSha256`, the SHA and head fields in `labels.git`, and `sha256:` references)
   are never redacted.
4. E-mail addresses and DSNs, such as Sentry DSNs.
5. Secret variable names, matched case-sensitively in `SCREAMING_SNAKE_CASE` with
   a secret-like suffix (`_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD`). Their values
   are replaced; code identifiers such as `tokenAmount` are left alone.
6. Usernames: the local user and every pool host's SSH user, in text and in file
   names (session directory names encode them).
7. Home directories (`/Users/<name>`, `/home/<name>`), which become `~`.
8. Machine names from the pool, which become `<machine>`.

Each rule replaces a match in file contents with `[REDACTED:<rule>]`, and in file
names with `REDACTED-<rule>` (no brackets or colon, which file systems handle
badly), and counts it in `redaction.json`. A file the scrubber cannot read is left
out, never exported raw.

Redaction is a best-effort backstop, not a guarantee. An export is for the local
machine only; sharing it, even internally, needs a human review first.

## Privacy

Traces hold private code, testnet account data and LiteLLM traffic, which is
employer-owned. They stay private and local. Farmslot has no upload command or
RPC; publishing an export is a manual decision taken outside Farmslot.

## Cost

Measured on the dev gateway, 2026-11-24:

| Item                | Today                                                |
| ------------------- | ---------------------------------------------------- |
| Transcripts per run | median 7.7 MB, p90 42 MB, max 154 MB (159 runs)      |
| Episode             | median 2.7 KB, max 724 KB (1083 episodes)            |
| Prototype export    | 22 runs, 66 MB, 3–9 MB per run with a worker session |

- **Per capture:** three node calls (exists, stat, copy) plus a local read and
  sha256 of the copy. Slot release adds one stat per already-captured session.
  Earlier capture adds the missing reviewer and earlier-round sessions, at about
  the same size per session.
- **Uncompressed at rest:** transcripts stay raw JSONL, because the Hub viewer and
  the History readers read it directly. Gzip reached 2.5x on a 40-transcript sample.
- **Graded diff:** one batched Git command per finalize and per release that records
  the output (on the slot's node for a remote slot, one node call), plus a local
  write of the diff beside the episode.
- **Labels:** a few kilobytes per episode.
- **Export:** runs outside the gateway, so it costs the gateway nothing.
