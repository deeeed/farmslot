# ADR-032: Event-Driven Runner Observability via Hooks and Signal Files

**Status:** Accepted
**Date:** 2026-05-21
**Relates to:** [ADR-023](023-runner-agnostic-tui-execution.md), [ADR-024](024-run-lanes-and-run-family-model.md), [ADR-027](027-unified-gateway-state.md), [ADR-031](031-deterministic-first-auto-recovery.md)

> **Critic-pass revisions (2026-05-21).** Independent review flagged 1 blocker (`$TMUX_PANE` availability inside Claude's hook child process, empirically unverified — deferred to Phase 1's first task), 7 majors (promptDigest spec, degraded-mode signal location, exit-criteria measurability, Phase 3 scope, OMC read failure modes, `confidence` field semantics, null-provider contract), and minor cleanups. Folded inline below. **Drift cadence evidence (2026-05-21, corrected).** `paneShowsBusyComposer` was introduced in PR #41 (2026-05-01) and had zero patches over 20 days — but Claude itself had not been upgraded during that window. The 2026-05-21 regression coincided with the operator's **first Claude version upgrade after the regex shipped**, suggesting the meaningful drift rate is "1 break per Claude version upgrade" rather than "1 break per 20 calendar days". Re-reading the data with that lens: 100 % regression rate on the first observed version transition. The structural argument is empirically supported — the regex set tracks a moving target (Claude TUI rendering across versions) which it cannot follow without a patch per upgrade. ADR remains Proposed; the version-transition framing strengthens the case for Phase 1 prototyping when capacity allows.

> **Verification complete** (2026-05-21). The **Hooks Contract** section is grounded in [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks), [.../statusline](https://code.claude.com/docs/en/statusline), and [.../settings](https://code.claude.com/docs/en/settings). Three architectural corrections from initial draft are noted inline. Two questions remain empirical (plan-mode hook suppression; `PostToolUse` exactly-once-vs-at-least-once).

## Context

Tmux `send-keys` is — and will remain — the only input channel into a runner TUI (ADR-023). The output side has so far been symmetric: gateway code reads pane state with `capture-pane` and regexes the result to answer "is the worker busy?", "did my prompt land?", "what is the context-% utilization?". This works most of the time and fails in three repeatable ways:

1. **Regex set is incomplete.** `paneShowsBusyComposer` at `services/gateway/src/runners.ts:614-620` matches only three needles (`tab to queue message`, `Working (`, `background terminal running`). Claude's `· Composing…` spinner is not in the set. On 2026-05-21 a nudge to `mm-3:1` timed out at 30 s because the slot was mid-compose: `paneShowsBusyComposer` returned `false`, the gateway fell through to `submitRunnerInstruction('send')`, Claude's TUI buffered the Enter while still composing, and the post-send `runnerPaneHasPendingInstruction` poll (`runners.ts:710-752`) saw the instruction sitting at the composer for two polls before giving up. `nudge.ts:330` threw `NudgeTimeoutError`.
2. **Overlay drift.** OMC HUD, custom statuslines, and operator-installed plugins paint extra glyphs into the very rows the regex relies on. Two valid `ctx:N%` markers can appear on one capture, the canonical `❯` prompt is shadowed by a HUD bar, and ANSI sequences drift between Claude minor versions.
3. **No structural source of truth.** "Is the worker idle right now?" today requires interpreting a screenshot. Claude Code already emits structured events for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, plus a statusline JSON channel — none of which Farmslot consumes.

The cost is asymmetric. Pane scraping fails open by sending duplicate keystrokes into a buffered composer (corrupting the worker prompt) or fails closed by aborting nudges that would have worked. Both surfaces hit the operator. Adding more regexes is the same anti-pattern that produced ADR-027 — bespoke patches that survive until the next version drift.

## Decision

Adopt **event-driven runner observability** as the primary signal path, with pane scraping retained as a diagnostic fallback. Three new disk surfaces, all under the slot's existing runtime dir (`{{runtime_dir}}/.observability/`), feed a typed `RunnerObservability` provider registered next to `RunnerStatusProvider` in `runners.ts`.

### Hooks Contract

**Architectural correction (important).** Claude Code does NOT natively write `hooks.jsonl` or `statusline.json` for external watchers. The statusline contract is stdin/stdout only — Claude invokes the configured command and renders its stdout. The hook contract is also stdin/exit-code based — Claude invokes the configured command per event and reads stdout/exit. Farmslot's **hook scripts** (declared in the slot-scoped `settings.json`) own the writes to disk. **We own the schema, versioning, multi-pane tagging, rotation policy** — Claude is the trigger, not the producer.

**Hook events Farmslot uses** (from the 29 documented; full surface in doc-specialist report):

| Event                        | Firing moment                                           | Sync?                               | Payload keys we read                                                   | Use                                                                           |
| ---------------------------- | ------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `SessionStart`               | Session begins or resumes                               | Sync (non-blocking)                 | `session_id`, `source` (`startup`/`resume`/`clear`/`compact`), `model` | Initial presence + model truth                                                |
| `UserPromptSubmit`           | After user prompt, before Claude processes              | Sync, **blocks turn, 30 s timeout** | `session_id`, `cwd`                                                    | Confirm send-keys landed (`promptAccepted()`)                                 |
| `UserPromptExpansion`        | Slash-command/MCP prompt expands before reaching Claude | Sync, blocks                        | `command_name`, `expansion_type`                                       | Detect `/goal`-style commands in-flight (critical for the mm-3 regression)    |
| `PreToolUse`                 | Before any tool call executes                           | Sync, **blocks tool call**          | `tool_name`, `tool_use_id`, `tool_input`                               | `activeTool` reading                                                          |
| `PostToolUse`                | After tool call succeeds                                | Sync (non-blocking)                 | `tool_name`, `tool_use_id`                                             | Close tool-active window                                                      |
| `PostToolUseFailure`         | After tool call fails                                   | Sync (non-blocking)                 | `tool_name`, `tool_use_id`                                             | Close tool-active window + failure signal                                     |
| `Stop`                       | Claude finishes responding                              | Sync, **prevents stop if non-zero** | `response` text                                                        | Turn-complete signal (`lastTurnCompletedAt`)                                  |
| `SubagentStop`               | Subagent finishes                                       | Sync, **blocks subagent stop**      | `agent_type`, `agent_id`, `output`                                     | Subagent-complete signal                                                      |
| `PreCompact` / `PostCompact` | Around context compaction                               | Sync / non-blocking                 | `source` (`manual`/`auto`)                                             | Suppress activity readings during compaction so we don't mis-classify as idle |

**Common stdin payload** every event receives: `session_id`, `transcript_path`, `cwd`, `permission_mode` (`default`/`plan`/`acceptEdits`/`auto`/`dontAsk`/`bypassPermissions`), `hook_event_name`, `effort.level`.

**Settings scope.** Farmslot ships `.claude/settings.json` at the **project scope** (committed inside the slot's worker repo, NOT user-global at `~/.claude/`). Precedence is: managed > local > project > user — our project-scoped fixture is overridable by operator-edited local `settings.local.json` but not by stale user settings. Permission rules merge across scopes; most scalar settings override (highest wins).

**Hook script body** (slot fixture writes this; receives event JSON on stdin):

```bash
#!/usr/bin/env bash
# Bounded I/O — hook must finish well under 30 s UserPromptSubmit ceiling.
# flock prevents interleaved writes when parallel hooks fire on PostToolBatch.
LOG="${FARMSLOT_OBS_DIR:?missing}/hooks.jsonl"
exec 9>"${LOG}.lock"
flock -w 0.1 9 || exit 0   # absent fallback: gateway detects "no events" and degrades to pane
# Tag every event with the tmux pane id so split-window panes can be de-multiplexed.
jq -c --arg pane "${TMUX_PANE:-}" '. + {tmux_pane: $pane, observed_at: now}' >> "$LOG"
```

**Statusline command** (sibling fixture; receives full status JSON via stdin, writes atomically):

```bash
#!/usr/bin/env bash
LOG="${FARMSLOT_OBS_DIR:?missing}/statusline.json"
TMP="${LOG}.tmp.$$"
jq -c '{ctxPct: .context_window.used_percentage, model: .model.id, busy: (.context_window.current_usage != null), mtime: now, raw: .}' > "$TMP" && mv -f "$TMP" "$LOG"
# Render visible statusline back on stdout — Claude shows it.
echo "ctx:$(jq -r '.context_window.used_percentage // "?"' < "$TMP")%"
```

Statusline refreshes on: assistant message complete, `/compact`, permission-mode change, vim-mode toggle. Debounced 300 ms. Optional `refreshInterval` adds a timer-based refresh — leave unset for event-only.

**Hard limits (verified, not assumed):**

- `UserPromptSubmit` hook timeout: **30 s** (overrides default 600 s for command hooks).
- Hook stdout cap: **10 000 chars** — excess saved to file with preview in transcript.
- Default hook is **sync and blocking**; use `"async": true` for fire-and-forget, `"asyncRewake": true` if exit-2 should re-wake Claude.
- `disableAllHooks: true` is the only kill switch and also disables statusline.

**Open questions (empirical only — docs do not specify):**

1. Plan-mode hook suppression: `permission_mode: "plan"` is visible in payload but no docs say hooks skip. Verify on first slot bring-up.
2. `PostToolUse` exactly-once vs at-least-once on API retries: unspecified. Schema treats as at-least-once — observability watcher de-dups by `tool_use_id`.

Full matrix (29 hook events, full payload fields, full statusline JSON contract) lives in the doc-specialist research output. Not re-quoted here — this ADR cites only the subset Farmslot consumes. Adding a new event reading: extend the matrix above and update the relevant `RunnerObservability` method.

### Signal sources, by question

All "Hook JSONL" rows below are written by **Farmslot-owned hook scripts** declared in the slot's `.claude/settings.json` fixture; Claude triggers the script on the named event, the script appends one JSON line per event. We own the schema.

| Question                                             | Authoritative source (Farmslot-emitted unless noted)                                                                                                                                                                          | Fallback                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Is the worker idle (ready to accept tmux send-keys)? | Hook JSONL emit on whole-turn `Stop`; when a runner emits a structured `Notification.notification_type === "idle_prompt"`, Farmslot accepts it as an optional equivalent signal. `SubagentStop` does not end the parent turn. | `paneShowsBusyComposer`           |
| Is the worker busy / composing / running a tool?     | Hook JSONL emit on `UserPromptSubmit` / `PreToolUse` without matching `PostToolUse`; statusline JSON `busy:true` (Farmslot script writes both)                                                                                | pane regex set                    |
| Did my last submitted prompt actually land?          | Hook JSONL `UserPromptSubmit` event with `runnerPromptDigest` matching the value the gateway wrote to a per-send sentinel file (see "Prompt digest contract" below)                                                           | `runnerPaneHasPendingInstruction` |
| Is the current model turn complete?                  | Hook JSONL `Stop` event timestamp greater than the matching `UserPromptSubmit`                                                                                                                                                | pane heuristics                   |
| What is context-% utilization?                       | Statusline JSON `ctxPct` (Farmslot statusline command writes this)                                                                                                                                                            | `parseClaudeCtxPctFromPane`       |
| Is a tool active? Which one?                         | Hook JSONL: most recent `PreToolUse` without matching `PostToolUse`                                                                                                                                                           | none                              |
| Did the worker reach a task milestone?               | Extended `SIGNAL.json` (`phase: 'busy'` / `'idle'` / `'done'`) written by **worker** task template — separate from runner-process events                                                                                      | existing `SIGNAL.json` shape      |

Transient activity and retained-session delivery use different clocks. Busy/idle monitoring still
requires fresh hooks, but a whole-turn `Stop` is durable for its exact `session_id` until a later
event in that session supersedes it. A retained-session handoff never infers safety from Claude TUI
text: the runner capability resumes the persisted session with the new prompt in argv, then requires
a matching `UserPromptSubmit` digest before the handoff succeeds. Unknown or active session state
holds for operator attention instead of replacing the live process. The hook writer atomically
materializes the last event for each session and pane. A handoff requires both snapshots to match
the persisted session id, transcript path, and live pane, so this decision never depends on a
historical log tail or age window.

### Addendum: checklist timing stays task-owned (2026-06-25)

`SIGNAL.json` may carry compact, optional checklist timing metadata because a
checklist item being marked complete is task-template truth, not runner-process
truth. The canonical reader-facing contract now lives in the Docusaurus
[Worker signal protocol](../../apps/docs/docs/reference/worker-signal-protocol.md).

The extension is intentionally low-volume: `checklistTiming.events[]` records
the zero-based checklist index, copied label, and checked-at timestamp for items
the worker marked complete. Gateway analytics can derive per-step duration from
that event order without parsing terminal output.

This does **not** move runner/tool observability into `SIGNAL.json`. Tool names,
turn boundaries, token usage, command timings, and high-volume command/tool
events remain owned by Farmslot hook/statusline streams under
`{{runtime_dir}}/.observability/` and the node/gateway worker inventory path.
If future analytics needs raw or near-raw command usage, it must use a separate
append-only observability stream and aggregate that stream into analytics
records rather than expanding `SIGNAL.json` into a log sink.

### Prompt digest contract

`runnerPromptDigest = sha1(instructionNeedle(prompt)).slice(0, 16)` where `instructionNeedle` lives at `services/gateway/src/runners.ts:700-702`. Renamed from `promptHash` because that identifier is already in use at `apps/command-center/ui/src/components/evals/eval-cockpit-model.ts:73,240` for eval-template identity — different domain, different lifecycle.

Correlation flow:

1. Before send-keys, gateway writes `{{runtime_dir}}/.observability/sent/<digest>.json` with `{sentAt: number, prompt: needle}`.
2. Hook script on `UserPromptSubmit` reads the gateway-written sentinel matching the prompt (matched by needle prefix), and re-emits `{event: 'UserPromptSubmit', runnerPromptDigest, sentAt, observedAt}` into `hooks.jsonl`.
3. `RunnerObservability.promptAccepted(digest, sinceMs)` checks `hooks.jsonl` for an emit with that digest after `sinceMs`.

If the sentinel file is missing (e.g. the gateway crashed mid-send), the hook still emits the event without `sentAt`, but it is not authoritative for a gateway delivery decision.

Hook files and statusline JSON are written by **Farmslot's hook scripts** (shipped via the slot's `.claude/settings.json` fixture) — triggered by the runner, but with schema, format, and rotation owned by us. They reflect runner-process truth (turn boundaries, tool calls, token usage) because the runner invokes the hooks at those exact moments. `SIGNAL.json` is written by the **worker** (the LLM via its task template) and reflects task-template truth (recipe pass, report.md written, etc.). Keeping them separated preserves the existing ADR-024 family-observability ledger model — the worker still owns task semantics; runner-process semantics now have their own channel.

### Files on disk

```
{{runtime_dir}}/.observability/
  hooks.jsonl              # append-only, one JSON event per line, rotates at 5 MB
  sessions/<encoded-id>.json # atomic last-event snapshot for exact-session delivery decisions
  panes/<encoded-pane>.json  # atomic last-event snapshot for live pane/session binding
  statusline.json          # last-write-wins; ctxPct, model, mode, busy, mtime
  presence.json            # gateway-written: last-known runner PID, launched-at
SIGNAL.json (existing)     # extended with phase: busy|idle|done
```

`hooks.jsonl` rotates when it exceeds 5 MB (rename → `.1`, truncate). `statusline.json` is
atomically replaced (write-temp-then-rename) so a reader never observes a half-written object.

### Gateway integration

Node agents own runtime-file monitoring. Each node samples local tmux panes and observability files, then pushes changed snapshots to the gateway; gateway clients receive `tmux.worker.inventory.updated` with the same shape as `tmux.worker.list`. This deliberately stays separate from `worker.signal`: `SIGNAL.json` remains task-template/run semantics, while hook/statusline files are runner-process liveness (`status.source: hook | statusline | task-file | tmux`). Runner-aware readings can set `status.requiresAttention` with an `attentionReason` so Command Center can highlight stopped/waiting workers without parsing runner output. Implementations may expose a repo-root `.observability` compatibility symlink to the canonical runtime-dir observability folder so tmux-pane inventory can read status without loading project config on every sample.

Pane scraping stays in `runners.ts`. It becomes the **diagnostic fallback** path inside `RunnerObservability` impls, returning `{ source: 'pane', confidence: 'low' }` so callers can decide whether to trust it. `sendRunnerInstructionSafely` consults `RunnerObservability.isBusy()` first; only when the observability provider returns `unknown` does it fall back to `paneShowsBusyComposer`.

## Interface Sketch

```typescript
// runners.ts — sibling registry to RunnerStatusProvider.
// All fields are optional-async with null fallback so runners without an impl
// (codex, cursor, opencode today) null-out gracefully and callers null-check.

export type ObservabilitySource = 'hook' | 'statusline' | 'signal' | 'pane' | 'unknown';
export type ObservabilityConfidence = 'high' | 'medium' | 'low';

export interface ObservabilityReading<T> {
  value: T;
  source: ObservabilitySource;
  confidence: ObservabilityConfidence;
  /** ms since epoch of the underlying event/file mtime. */
  observedAt: number;
}

export type RunnerActivity =
  | 'idle' // last whole-turn event was Stop or an idle Notification
  | 'composing' // user-prompt accepted, model thinking, no tool yet
  | 'tool-running' // PreToolUse without matching PostToolUse
  | 'awaiting-input' // permission prompt / approval gate
  | 'unknown';

export interface RunnerObservability {
  /** Authoritative busy/idle answer. Null when no signal available. */
  getActivity(
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    target: string,
  ): Promise<ObservabilityReading<RunnerActivity> | null>;

  /** Did a prompt matching `promptHash` get accepted since `sinceMs`? */
  promptAccepted(
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    target: string,
    promptHash: string,
    sinceMs: number,
  ): Promise<ObservabilityReading<boolean> | null>;

  /** Latest model-turn boundary (Stop event) timestamp. */
  lastTurnCompletedAt(
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    target: string,
  ): Promise<ObservabilityReading<number> | null>;

  /** Context-% — replaces parseClaudeCtxPctFromPane as primary source. */
  getContextPct(
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    target: string,
  ): Promise<ObservabilityReading<number> | null>;

  /** Active tool name, if any. Null when no tool running or no data. */
  activeTool(
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    target: string,
  ): Promise<ObservabilityReading<string> | null>;
}

export const KNOWN_RUNNER_OBSERVABILITY: Record<string, RunnerObservability> = {
  claude: claudeHookObservability, // reads hooks.jsonl + statusline.json, falls back to pane
  // codex, cursor, opencode: absent. getRunnerObservability() returns null.
};

export function getRunnerObservability(runnerId?: string | null): RunnerObservability | null {
  if (!runnerId) return null;
  return KNOWN_RUNNER_OBSERVABILITY[normalizeRunner(runnerId)] ?? null;
}
```

`RunnerStatusProvider.getContextPct` becomes a thin shim that calls `RunnerObservability.getContextPct` and extracts `.value`, preserving the existing call site at zero-churn. The Claude entry registers hook-file paths derived from `{{runtime_dir}}/.observability/`; absent runners produce `null` from the registry lookup and every caller already null-checks (the pattern is identical to `getRunnerStatusProvider`).

## Runner Support Matrix

The `RunnerObservability` interface is runner-agnostic by registry-lookup: `getRunnerObservability(runnerId)` returns `null` for any runner without an entry, and every caller already null-checks. The matrix below summarizes per-runner viability as of 2026-05-21, with verdicts grounded in three parallel inventories of `oh-my-claudecode`, `oh-my-codex`, and `cursor-agent` 3.4.20.

| Runner     | Event surface                                                                                                                                             | Persisted state                                                                                                                                 | TUI markers (regex confidence)                                                                    | Provider for v1                                                              | Verdict rationale                                                                                                                                                                                                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`   | 29 hook events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`/`PostToolUse`, `Stop`, `SubagentStop`, …)                                                | Hook scripts write `hooks.jsonl` + `statusline.json` (Farmslot owns schema)                                                                     | Medium — drifts with HUD overlays                                                                 | `ClaudeObservabilityProvider` — full implementation                          | Native hook + statusline contract; ours to extend via slot fixture.                                                                                                                                                                                                                                             |
| `codex`    | `SessionStart`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `Stop` (no `Notification` / `StopFailure` / `SubagentStop`) | Farmslot installer writes project `.codex/hooks.json` + slot `{{runtime_dir}}/codex-home/` (`config.toml` trusted hashes, `auth.json` symlink)  | Not a TUI — no busy/idle markers; `exec` mode used for validation                                 | **`event-driven` (Phase 1.5)** — `codex: claudeHookObservability` in gateway | Codex reads user-global `~/.codex/config.toml` by default; Farmslot bootstraps isolated `CODEX_HOME` per slot. OMX plugin hooks duplicate user hooks — production/validation launches pass `--disable plugin_hooks`. Canonical `trusted_hash` (OMX-style JSON identity) required or hooks are skipped.          |
| `cursor`   | None at CLI level (`cursor-agent --help` exposes no `--hooks`/`--json-events`)                                                                            | `~/.cursor/projects/*/agent-transcripts/*.jsonl` written **post-hoc per turn**, not streamed; `~/.cursor/agent-cli-state.json` is static config | High — `plan, search, build anything composer\s+\d` is stable, no HUD                             | **`null`**                                                                   | `persistsSessionFiles: false` + no `--continue` → non-resumable sessions, hook architecture doesn't apply. Pane scrape has **higher confidence** here than for Claude. Uses `needsPostLaunchPrompt: true`, immune to mid-session nudge timeouts.                                                                |
| `grok`     | None observed in local `grok --help` as of 2026-06-13; headless mode is `-p/--single` with `--output-format`, separate from the interactive TUI           | Grok exposes `sessions`/`resume`, but Farmslot does not yet scan Grok transcript storage                                                        | Medium — interactive TUI is the supported default, pane scrape is the current integration surface | **`null`**                                                                   | Added as a Cursor-style interactive runner: no argv task prompt, `needsPostLaunchPrompt: true`, tmux-steerable, session metadata intentionally null until a Grok transcript scanner exists. Farmslot auto-submits Grok's current-project selector before prompt delivery when that pre-composer screen appears. |
| `opencode` | None documented                                                                                                                                           | None                                                                                                                                            | Exec-only launch mode, no interactive TUI                                                         | **`null`**                                                                   | No observability surface; runs are one-shot via exec mode.                                                                                                                                                                                                                                                      |

**Null is a contract, not a stub — enforced via capability flag.** `RunnerDefinition` (`services/gateway/src/runners.ts`) gains a new field `observabilityScope: 'event-driven' | 'pane-only' | 'none'`. Cursor/OpenCode entries set it to `'pane-only'`; Codex starts `'pane-only'` and graduates to `'event-driven'` once Phase 1.5 ships; Claude sets `'event-driven'`. Callers that want to know "is the missing provider intentional?" inspect the flag, not the registry. `getRunnerObservability()` returning `null` is the answer for both intentional-no-impl and TODO; the scope flag disambiguates.

Pane-scrape stays the canonical signal source for `'pane-only'` runners — not a fallback awaiting replacement. Cursor's pane regex is in fact more reliable than Claude's (no HUD overlay drift); pulling it onto hooks would be a regression there.

### Codex — Phase 1.5 path

OMX inventory at `/Users/deeeed/dev/oh-my-codex/docs/codex-native-hooks.md` confirmed: Codex CLI has a hook registry at `.codex/hooks.json`. OMX registers wrappers there today that write workflow-mode state — not turn boundaries — so consuming OMX's existing output gives us workflow state, not what `RunnerObservability` needs.

**Phase 1.5 approach:** Farmslot ships its OWN wrapper script registered in `.codex/hooks.json` alongside OMX's wrappers. The script writes per-turn events (`UserPromptSubmit`, `Stop` equivalents) to `hooks.jsonl` in the same shape as the Claude path, so the Codex provider can share most of the `ClaudeObservabilityProvider` implementation.

**Phase 1.5 prerequisites** (must verify before writing the wrapper):

- Multi-source registration in `.codex/hooks.json` — when Farmslot and OMX both install wrappers, do both fire, or does one overwrite the other? Verify empirically on a test slot.
- Codex event payload shape — confirm Codex CLI delivers `UserPromptSubmit`-equivalent and `Stop`-equivalent events with timestamp + session id. Doc-specialist matrix did not cover Codex hooks in this depth; needs follow-up.
- Context-% surface — Codex has no documented statusline contract. Either skip `getContextPct()` for Codex (provider returns null for that one method) or extend a Codex wrapper to write a sibling `statusline.json`.

Phase 1.5 ships **after** Claude phase 1 lands, so the wrapper writes into the same `{{runtime_dir}}/.observability/` schema and reuses the same gateway watcher infrastructure.

### Runner validation harness (2026-06-27 addendum)

Per-runner behavioral differences (how to launch in tmux, whether compose buffers input, how hooks fire, how turns end, when interjection is unsafe) must not live in one-off gate scripts. Farmslot owns a **runner validation harness** at `scripts/runner-validation/`:

| Layer                  | Responsibility                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runners/<id>.mjs`     | Launch adapters, registered hook events, repo prep (`git init` for Codex), explicit skip reasons                                                                                                           |
| `scenarios/<name>.mjs` | Executable contracts: hook smoke, prompt digest acceptance, turn ordering, busy-composer fixtures, permission mode                                                                                         |
| `lib/`                 | tmux driver delegates to `.agents/skills/tmux-model-driver` scripts (`pane-state`, `send-and-verify`, `resolve-launch-blockers`, `send-shell-script`); hook readers and digest helpers synced with gateway |
| `run.mjs`              | Orchestrator: `--runner`, `--scenario`, evidence JSON under `docs/operations/evidence/runner-validate-*`                                                                                                   |

**Empirical rules encoded in adapters (not shared assumptions):**

- **Claude tmux:** interactive `❯` compose often buffers without submitting; one-shot `-p` in a **shell pane** is the reliable hook-smoke path.
- **Codex tmux:** bare tmux lacks shell `codex` function — use full `node …/codex.js`; require git repo; set `CODEX_HOME={{runtime_dir}}/codex-home`; prefer `codex exec --disable plugin_hooks`.
- **Grok tmux (pane-only, priority):** production uses interactive TUI + post-launch prompt + project-directory blocker. Harness validates **`grok -p`** (`pane-smoke`) and **interactive compose** (`interaction-smoke`) separately. See [runner-validation-harness.md](../operations/runner-validation-harness.md).
- **Cursor tmux (pane-only):** argv/`--print` launch; hook scenarios skip; `pane-smoke` uses `cursor-agent --print --trust`.

Scenarios that are runner-inapplicable (Codex busy-composer, Codex mode-switch; hook scenarios on pane-only runners) **skip with `pass: true` and an explicit `skipReason`** rather than fake success. Live mid-turn busy capture remains a fixture-tier test until a stable recipe exists.

Gate entrypoint: `node scripts/runner-validation/run.mjs` (also wired into `scripts/run-runner-observability-gate.sh`):

- `hook-smoke` — Claude + Codex (event-driven hooks)
- `grok pane-smoke` — single-turn `grok -p` shell launch
- `grok interaction-smoke` — production-parity interactive TUI (project-directory blocker when shown + compose submit)

Operator guide: [runner-validation-harness.md](../operations/runner-validation-harness.md).

**Committed closeout evidence (repo):** only four macwork JSON snapshots are versioned — install probes (`adr032-phase1-probe-macwork-{claude,codex}.json`) and harness hook-smoke artifacts (`runner-validate-macwork-{claude,codex}-hook-smoke.json`). PR #81 merge-process and Phase 2 exit snapshots live under `docs/operations/evidence/adr032/`. Optional harness scenarios and Grok/Cursor pane smokes run locally via `e2e-tmux-runner-validate.sh` into a temp directory and must not be committed. One-shot ADR closeout verifiers (`assert-adr032-*`, `verify-adr032-*`) were retired from `scripts/` after closeout; ongoing ops use [runner-observability-empirical-gate.md](../operations/runner-observability-empirical-gate.md).

### Interaction with `oh-my-claudecode` (OMC)

OMC ships Claude hooks at **user scope** (`~/.claude/hooks/`). Our slot fixture installs at **project scope** (`.claude/settings.json` inside the worker repo). Claude Code merges hook arrays across scopes — **both fire**. Specifically:

- OMC's `SessionStart` (writes `~/.claude/.omc/state/sessions/<id>/skill-active-state.json`) and Farmslot's `SessionStart` (writes our `hooks.jsonl`) both run on session start. Order is undefined; our hook must be idempotent.
- OMC's `PreToolUse` / `PostToolUse` (mutate `skill-active-state.json`) and ours (append to `hooks.jsonl`) coexist via the `flock`-protected append in our hook script.
- OMC's `Stop` (enforces `/goal`-style stop blocks) runs alongside our `Stop` (writes turn-complete event). The 30 s `UserPromptSubmit` hook ceiling applies to the aggregate of all hooks for that event — keep our hook body to <100 ms even when OMC is also active.

**Read-only consumption of OMC state.** OMC's `skill-active-state.json` is a signal Farmslot can **read** to detect `/goal`-style mode gates. Had we been consuming this on 2026-05-21, the mm-3 nudge would have surfaced "worker is in `/goal active`" before send-keys was attempted.

Path discovery: glob `~/.claude/.omc/state/sessions/*/skill-active-state.json`, then filter by directory mtime `>=` the run's `dispatchedAt - 5 s` (drops stale sibling sessions). Failure modes:

- _File missing_ (OMC not installed): return `null` from `getActivity()`, log nothing — absence is expected.
- _Mid-write race_ (OMC's hook writing concurrently): atomic-read into a buffer, `JSON.parse` inside `try/catch`; on parse error retry once after 50 ms, then return `null`. Never throw.
- _Stale session-id directory_: mtime filter handles it. If two sibling directories satisfy mtime, choose the one whose `session_id` matches the run's most-recent `SessionStart` hook payload.
- _Remote-user mismatch_: on runner-a/runner-b the OMC install (if any) lives under the SSH user's `~/.claude/`, which may not be the Farmslot operator's `~/.claude/`. Path is resolved relative to the worker's home, not the orchestrator's — `loadSlotVars` already passes the remote home directory.

Never write to that file — OMC owns it. The read is best-effort; pane fallback always shadows it.

## Migration Plan

**Phase 1 — Hooks emit; pane is authoritative.** Slot fixture installs a Claude `settings.json` writing `hooks.jsonl` + `statusline.json` under `{{runtime_dir}}/.observability/`. `task-watcher.ts` watches both files. `RunnerObservability` is wired but consulted only for telemetry — `sendRunnerInstructionSafely` keeps pane scraping as the decision input.

Phase 1 prerequisites (do BEFORE shipping the fixture):

1. **`$TMUX_PANE` empirical verification** (the BLOCKER above). Install a minimal `SessionStart`-only hook on runner-browser-1, trigger a fresh dispatch, confirm hook payload contains `tmux_pane` non-empty. If empty, redesign de-multiplexing to `{cwd, session_id}` composite key before any fixture lands. **Abort phase on failure.**
2. **Hook latency bench** on each machine class (runner-local, mini, runner-a). Median < 150 ms. Abort phase on failure.

Phase 1 telemetry (new code that must ship alongside the fixture):

- `services/gateway/src/observability-agreement-log.ts` — records every `sendRunnerInstructionSafely` call with both hook-derived and pane-derived readings; daily aggregation rolled into run-store.
- `Run.metrics.nudgeTimeoutCount` increments at the existing `NudgeTimeoutError` throw site (`nudge.ts:330`). Run-list UI exposes it as a column.

**Phase 1 closeout criterion (empirical, tmux-first):** `scripts/e2e-tmux-runner-validate.sh` passes on a representative machine — Claude/Codex `hook-smoke`, Grok `pane-smoke` + `interaction-smoke`, skill `send-shell-script` + `resolve-launch-blockers` — plus install probes (`probe-runner-observability.mjs`). See [runner-observability-empirical-gate.md](../operations/runner-observability-empirical-gate.md). **Shipped** in PR #81 (`feat/observability-phase1-closeout-15`).

**Fleet telemetry (optional, not a closeout blocker):** `observability-agreement-log.ts` may record hook-vs-pane readings during live nudges for triage. No fixed event-count threshold gates Phase 1 — agreement NDJSON is diagnostic when hooks are enabled on slots, not a synthetic exit bar.

**Phase 2 — Hooks authoritative; pane is fallback (active).** `sendRunnerInstructionSafely` consults `RunnerObservability` first via `runnerHasPendingInstruction` / `runnerShowsBusyComposer` (hook `promptAccepted` + `getActivity` with `selectPendingFromObservabilityAndPane` / `selectBusyFromObservabilityAndPane`); pane scraping is used only when the observability provider returns `unknown`, `null`, or `low` confidence. Event-driven runners use `RUNNER_HOOK_SAFE_SEND_TIMEOUT_MS` (10 s); pane-only runners and hook fallback keep `RUNNER_PANE_SAFE_SEND_TIMEOUT_MS` (30 s). `resolveSafeSendTimeoutMs()` selects the timeout at nudge and other safe-send call sites.

**Exit criterion (measurable via Phase 1 telemetry):** `Run.metrics.nudgeTimeoutCount` aggregated over a 7-day rolling window stays at zero across all Claude-runner slots; statusline-derived `ctxPct` matches pane-derived `ctxPct` ± 1% on all healthy slots (daily check in `observability-agreement-log.ts`).

**Phase 3 — Retire Claude pane regex set (scope-restricted).** Delete the **claude-only branches** of `paneShowsBusyComposer`, `runnerPaneHasPendingInstruction`, `runnerPaneLooksIdle`. Retain the `cursor` and `codex` branches — those runners' `observabilityScope === 'pane-only'` (per matrix above) and pane regex is more reliable there than for Claude. Retire the `requiresBusyComposerPoll` capability flag iff its only non-default consumer (Claude) is gone. Demote `parseClaudeCtxPctFromPane` to a debug helper.

**Exit criterion:** Phase 2 empirical exit **passed** (2026-06-27) — `Run.metrics.nudgeTimeoutCount` stayed at zero over the 7-day rolling window on Claude-runner slots (`docs/operations/evidence/adr032/phase2-exit-window.json`, `exitPass: true`). Phase 3 pane-regex retirement is the remaining implementation work.

## Migration Surface (existing code paths)

Source: explore-lane inventory, 2026-05-21.

| Call site                                                                                                                                                        | Current dependency                                  | Phase                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| `runners.ts:786-796` instruction submit verify loop                                                                                                              | `runnerPaneHasPendingInstruction` regex             | 2                                                     |
| `runners.ts:840` busy composer loop                                                                                                                              | `paneShowsBusyComposer` regex                       | 2                                                     |
| `runners.ts:885-946` post-launch readiness poll                                                                                                                  | `detectRunnerLaunchBlocker` + `runnerPaneLooksIdle` | 2 (partial) + new `RunnerReadinessProvider` interface |
| `runners.ts:967-972` prompt delivery verification                                                                                                                | marker-in-pane regex                                | 2                                                     |
| `claudeStatusProvider.getContextPct` (`runners.ts:672-676`)                                                                                                      | `parseClaudeCtxPctFromPane`                         | 1                                                     |
| `tmux-stream.ts:72` terminal data streaming                                                                                                                      | `capture-pane -p` per poll                          | unchanged (UI terminal display, not observability)    |
| `ci-monitor.ts:1151`, `run-monitor.ts:755`, `self-review.ts:1182,1412`, `methods/run.ts:632`, `methods/dispatch/nudge.ts:326`, `methods/dispatch/execute.ts:338` | `capture-pane` one-shot diagnostic snapshots        | unchanged (diagnostic only)                           |

## Risks

- **Hook-disable footguns.** Claude lets users disable hooks via settings.json. Mitigation: slot fixture writes hooks under `{{runtime_dir}}/settings.json` (slot-specific, not user-global), and gateway detects "no hook events within 10 s of `UserPromptSubmit`-equivalent send-keys" as a degraded mode that re-engages pane fallback automatically.
- **settings.json drift across slots.** Different fixture revisions could ship inconsistent hook scripts. Mitigation: hook script committed under `projects/<name>/fixtures/.claude/settings.json` and validated against a schema at preflight (existing fixture-sync path), same model used for `.tool-versions`.
- **Sandbox / timeout interactions.** `UserPromptSubmit` hook has a verified **30 s** ceiling (overrides the default 600 s). Aggregate across all hooks for that event must stay under 30 s. Farmslot hook script targets **<100 ms** end-to-end; current draft uses `jq -c` twice per event (~40-80 ms total bench-pending). If `jq` is too slow on the target machine, replace with bash-native printf/heredoc. **Phase 1 first task: bench hook latency on runner-local + mini + runner-a worker shells; abort phase if median > 150 ms.**
- **`$TMUX_PANE` availability inside Claude's hook child process is empirically unverified.** Hook script's de-multiplexing strategy at line 76 relies on `${TMUX_PANE:-}` being populated when Claude spawns the hook. Claude _should_ propagate parent env to children, but this has not been verified on actual fleet machines. **Phase 1 first task: install a minimal hook on runner-browser-1, trigger `SessionStart`, verify the hook child sees `TMUX_PANE`. If empty, switch de-multiplexing to a `{cwd, session_id}` composite key.**
- **Ordering races.** Gateway can observe a `send-keys` complete before the corresponding `UserPromptSubmit` hook is written. Mitigation: `promptAccepted()` polls with a 500 ms grace window after send-keys before reporting `false`; this is still 60× faster than the current 30 s timeout.
- **Hook crash.** Hook script error must not throw inside the runner. Two options:
  - **A (preferred):** declare the hook as `"async": true` in the slot's `.claude/settings.json` so non-zero exit is logged but does not block the runner — sidesteps the suppression entirely.
  - **B (fallback):** trailing `|| true` on the append, which is a benign suppression. This is **a documented waiver of the project HARD RULE "No Swallowed Exceptions"** (see `CLAUDE.md`). The waiver applies _only to the writer-level append in the hook script fixture_ and only because the runner cannot recover from a hook crash; the gateway-side absence-detection (below) does the actual error handling.

  Degraded-mode signal (concrete spec): `sendRunnerInstructionSafely` at `services/gateway/src/runners.ts:805` gains a post-send-keys poll on `{{runtime_dir}}/.observability/hooks.jsonl` mtime; if mtime hasn't advanced within 5 s of send-keys completion AND the worker is supposed to have received a prompt, log a `[observability] degraded — falling back to pane` warning and the call site reverts to current pane-regex behavior for that operation. The 5 s window is tunable per-runner via `RunnerDefinition.observabilityHeartbeatMs` (new field; Claude default 5000, others null = skip the check).

- **OMC custom statusline conflicts.** OMC ships a statusline that paints into the same rows; users may already have a custom `statusLine.command`. Mitigation: detect a non-Farmslot statusline at preflight and emit a deterministic-recovery action (ADR-031) rather than silently overwriting; operator approves the swap.
- **Multi-worker pane contention.** A single tmux window with split panes (rare today) would share one settings.json but produce two interleaved hook streams. Mitigation: hook script tags each event with `$TMUX_PANE`, and watcher de-multiplexes by pane id.

## Non-Goals

- No changes to dispatch input. `send-keys` remains the only way prompts reach a runner; this ADR does not introduce an IPC channel for input.
- No redesign of `FIND_SLOT`, run-engine step graph, decision model, or family ledger.
- No persistence of hook events beyond the slot runtime dir. The events are operational signal, not eval evidence — eval evidence stays under `artifacts/` per ADR-024.
- No new runner. Codex/Cursor/OpenCode observability remains `null` until those providers ship; absence is contractual (enforced by `observabilityScope`).
- No replacement for `SIGNAL.json` task semantics. The hook channel observes the runner process; `SIGNAL.json` keeps observing the worker task.
- **No IDE integration.** `hooks.jsonl` is consumed by Farmslot gateway only. No VSCode / JetBrains plugin reads this surface.
- **No telemetry export beyond slot runtime dir.** `hooks.jsonl` is local to the slot. No external sink (DataDog / Sentry / Honeycomb).
- **No security review of hook script execution.** Hook scripts run with worker-level permission; a compromised worker can rewrite settings.json. This is intrinsic to Claude's contract — out of scope for this ADR.
- **No replacement for ADR-027 unified state model.** Observability adds new disk files; it does not unify or alter the existing `Run.monitorState` / `slot.currentRunId` model.

## Roadmap Placement

This work does not map cleanly to a current canonical milestone. The closest fits are:

- [ROADMAP-next.md](../ROADMAP-next.md) §"Immediate Execution Order" item 1 — UI/UX stabilization of recent operator surfaces. The nudge timeout that motivated this ADR is exactly the kind of operator-visible reliability defect that pass should fix, but the ADR introduces a structural mechanism, not a stabilization patch.
- [ROADMAP.md](../ROADMAP.md) "Runner-Agnostic Execution" lane (deferred). The interface is a runner-agnostic extension of ADR-023, but the broader runner-expansion lane is explicitly deferred.

**Placement (2026-05-22):** accepted under [ROADMAP-next.md](../ROADMAP-next.md) §"Immediate Execution Order" item 7, with Phase 1 scoped by [plans/runner-observability-hooks-phase1.md](../plans/runner-observability-hooks-phase1.md). The motivating regression (mm-3 nudge timeout on 2026-05-21) was already unblocked by tactical patches, so Phase 1 remains telemetry-only: hooks prove agreement with pane-derived state before any nudge/control behavior becomes hook-authoritative.

## References

- `services/gateway/src/runners.ts:614-620` (incomplete busy regex — the immediate trigger)
- `services/gateway/src/runners.ts:659-691` (`RunnerStatusProvider` registry the new interface mirrors)
- `services/gateway/src/runners.ts:805-849` (`sendRunnerInstructionSafely`, the call site that failed)
- `services/gateway/src/methods/dispatch/nudge.ts:313, 330` (`NudgeTimeoutError`)
- `services/gateway/src/task-watcher.ts` (existing watch infrastructure to extend)
- `services/gateway/src/ci-monitor.ts:1357-1367` (existing SIGNAL.json wait pattern)
- ADR-023 (runner-agnostic TUI execution; abstraction surface)
- ADR-027 (state persistence model; `Run.monitorState` shape)
- ADR-031 (deterministic-first auto-recovery; degraded-mode handling)
