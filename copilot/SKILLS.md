# SKILLS.md — Operational Knowledge

How to handle common fleet operations. This is injected into your system prompt so you know the right procedures.

## Runner Differences

### Claude Code (runner: claude)

- **Interactive tmux session** — worker runs in a tmux pane, reads/writes via terminal
- **Nudging**: `send_terminal` with context-aware message. Worker sees it as user input.
- **Stuck detection**: `terminal_snapshot` — look for `❯` or `⏵⏵` prompt with no recent output. If the cursor is on a prompt line with no activity, the worker may be idle or waiting.
- **Interrupt**: `tmux_send_keys` with `C-c` to cancel current operation, then nudge
- **Mode cycle**: bypass → shortcuts → accept edits → plan mode → bypass. Use `tmux_send_keys` with `BTab` (Shift+Tab) to cycle.
- **Multi-window**: worker may have additional windows (metro, self-review). Use `tmux_list` to see, `tmux_select_window` to switch, `terminal_snapshot` to check each.
- **Completion signal**: worker writes SIGNAL.json when done. `task_progress` shows current step.

### Codex (runner: codex)

- **Single-command dispatch** — prompt delivered as CLI argument, not interactive
- **No send_terminal**: Codex doesn't read stdin after launch. Nudging has no effect.
- **No tmux_send_keys**: same reason — non-interactive
- **Stuck handling**: only option is `cancel_run` and re-dispatch
- **Monitoring**: `terminal_snapshot` still works to see output. `task_progress` tracks steps.

## Debugging a Stuck Worker

1. `terminal_snapshot` — see what's on screen
2. `task_progress` — which step are they on?
3. `git_status` — have they made changes?
4. If Claude runner:
   - Check if waiting for input (`❯` prompt visible)
   - Try `send_terminal` with a contextual nudge referencing the current step
   - If completely stuck: `tmux_send_keys` with `C-c`, wait, then nudge
5. If Codex runner:
   - Check if process is still running (terminal_snapshot shows activity)
   - If dead/stuck: `cancel_run` + re-dispatch

## Resolving Decisions

Decisions block the run pipeline until resolved. Use `list_pending_decisions` to see all.

### Ready Gate (kind: ready)

The worker finished. Before approving:

1. `git_diff` with `base: main` — review the actual changes
2. `terminal_snapshot` — confirm worker reported success
3. `task_progress` — all steps should be done
4. If looks good: `resolve_decision` with action `approve`
5. If something's wrong: `resolve_decision` with action `rework` (sends worker back)

### Review Gate (kind: review)

Self-review found issues. Check the review feedback:

1. `get_run` — look at the self-review step outputs
2. `read_file` on the review feedback file if available
3. `resolve_decision` with `approve` (post review) or `dismiss` (skip posting)

### Slot Picker (kind: slot_picker)

All slots scored badly. Present candidates to user with scores and reasons.
`resolve_decision` with action = chosen slot ID.

### CI Watch Timeout

CI checks didn't complete in time. Options:

- `approve` — continue anyway (checks may pass later)
- `retry` — reset the ci-watch timer
- `cancel` — abort the run

## Slot Lifecycle

| State       | Meaning                              | Valid actions                             |
| ----------- | ------------------------------------ | ----------------------------------------- |
| ready       | Idle, available for dispatch         | slot_prepare, queue_add                   |
| dispatching | Being prepared + task copied         | wait                                      |
| working     | Worker agent running                 | send*terminal, terminal_snapshot, tmux*\* |
| releasing   | Being cleaned up                     | wait                                      |
| released    | Clean, needs prepare before next use | slot_prepare                              |
| ci-watch    | Monitoring PR CI after completion    | cancel_run                                |
| disabled    | Taken offline                        | —                                         |

## Fleet Health Checks

- `fleet_refresh` — force re-scan when state looks stale
- `get_machine_health` — CPU, memory, disk, thermal, headroom per machine
- `get_slot` — individual slot lifecycle, branch, agent status
- If a slot shows `agent: no-tmux` but lifecycle is `working` — the worker crashed. Run the completion checklist or `cancel_run`.
