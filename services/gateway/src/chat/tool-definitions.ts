// chat/tool-definitions.ts — Co-Pilot gateway tool schemas.

import type { Tool } from '@earendil-works/pi-ai';
import { Type } from '@sinclair/typebox';

export const FLEET_TOOLS: Tool[] = [
  // ─── Read tools: fleet state ───
  {
    name: 'list_active_runs',
    description:
      'List all currently active runs with status, flow type, slot assignment, and pending decisions.',
    parameters: Type.Object({}),
  },
  {
    name: 'get_run',
    description: 'Get full details for a specific run: steps, decisions, metrics, error.',
    parameters: Type.Object({ run_id: Type.String({ description: 'Run ID or first 8 chars' }) }),
  },
  {
    name: 'run_context_bundle',
    description:
      'Get a compact investigation bundle for a run: summary, failed/running/detail steps, pending decisions, TASK.md, active task file, and key report artifacts.',
    parameters: Type.Object({ run_id: Type.String({ description: 'Run ID or first 8 chars' }) }),
  },
  {
    name: 'propose_run_recovery',
    description:
      'Build a typed read-only recovery proposal for a failed/blocked/confusing run or step. Returns finding, evidence, confidence, inference notes, and safe read-only next steps.',
    parameters: Type.Object({
      run_id: Type.String({ description: 'Run ID or first 8 chars' }),
      step_name: Type.Optional(Type.String({ description: 'Optional step name to diagnose.' })),
    }),
  },
  {
    name: 'get_slot',
    description: 'Get current state of a slot: lifecycle, agent, branch, task phase.',
    parameters: Type.Object({
      slot_id: Type.String({ description: 'Slot ID e.g. runner-local-mobile-1' }),
    }),
  },
  {
    name: 'fleet_refresh',
    description: 'Force re-scan of fleet state from disk. Use when state looks stale.',
    parameters: Type.Object({}),
  },
  {
    name: 'list_pending_decisions',
    description:
      'List all pending decisions from the canonical decision inbox, including recent completed-run retrospectives.',
    parameters: Type.Object({}),
  },
  {
    name: 'operator_snapshot',
    description:
      'Get the typed operator-facing gateway snapshot: fleet counts, active runs, queue, pending decisions, machine health, and recent events.',
    parameters: Type.Object({}),
  },
  {
    name: 'chat_session_context',
    description:
      'Get the Co-Pilot chat session context meter: message counts, token usage from provider responses, estimated remaining input tokens, cost, and compaction status.',
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({
          description:
            'Chat session ID. Defaults to the active Co-Pilot session when invoked from chat.',
        }),
      ),
    }),
  },
  {
    name: 'read_last_screen_evidence',
    description:
      'Read the last sanitized DOM/context screen snapshot supplied by the Command Center UI. This is read-last-screen-evidence, not a screenshot or live browser scrape; check freshness and uncertainty before relying on it.',
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({
          description:
            'Chat session ID. Defaults to the active Co-Pilot session when invoked from chat.',
        }),
      ),
    }),
  },
  {
    name: 'read_observer_evidence',
    description:
      'Read bounded recent gateway observer events and attention recommendations. Use for questions about recent alerts, what needs attention, or what changed outside the active chat session.',
    parameters: Type.Object({
      severity: Type.Optional(
        Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')], {
          description: 'Optional severity filter.',
        }),
      ),
      type: Type.Optional(
        Type.String({
          description: 'Optional observer event type filter, e.g. run.failed or monitor.violation.',
        }),
      ),
      run_id: Type.Optional(Type.String({ description: 'Optional run ID filter.' })),
      slot_id: Type.Optional(Type.String({ description: 'Optional slot ID filter.' })),
      window_ms: Type.Optional(
        Type.Number({ description: 'Lookback window in milliseconds. Defaults to 2 hours.' }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: 'Maximum events to return. Defaults to 20, capped by the gateway.',
        }),
      ),
    }),
  },
  {
    name: 'queue_list',
    description: 'List items in the dispatch queue waiting for a free slot.',
    parameters: Type.Object({}),
  },
  {
    name: 'get_machine_health',
    description:
      'Get live system health metrics for all machines or a specific machine: CPU, memory, disk, load, thermal, headroom.',
    parameters: Type.Object({
      machine: Type.Optional(
        Type.String({
          description: 'Machine name (e.g. runner-local, runner-a). Omit for all machines.',
        }),
      ),
    }),
  },

  // ─── Read tools: Farmslot self-inspection ───
  {
    name: 'read_farmslot_file',
    description:
      'Read an approved Farmslot source/doc/script path, or a registered log id/display/absolute path from list_farmslot_logs. Registered log content is redacted.',
    parameters: Type.Object({
      path: Type.String({
        description:
          'Relative path under Farmslot root, or a log id/display/absolute path returned by list_farmslot_logs.',
      }),
      max_chars: Type.Optional(
        Type.Number({ description: 'Max characters to return, default 20000' }),
      ),
    }),
  },
  {
    name: 'search_farmslot_files',
    description:
      'Search Farmslot gateway/protocol/UI/docs/scripts/log files for a regex or text pattern. Read-only; skips dependencies and build outputs.',
    parameters: Type.Object({
      pattern: Type.String({ description: 'Regex pattern to search for' }),
      path_prefix: Type.Optional(
        Type.String({ description: 'Optional relative path prefix within approved search roots' }),
      ),
      max_results: Type.Optional(Type.Number({ description: 'Max matches to return, default 50' })),
    }),
  },
  {
    name: 'list_farmslot_logs',
    description:
      'List registered Farmslot log evidence sources that can be read with read_farmslot_file. Includes canonical production logs, configured extra dirs, and the dev gateway compatibility log.',
    parameters: Type.Object({}),
  },
  {
    name: 'investigate_gateway_issue',
    description:
      'Delegate a bounded read-only investigation to a fresh gateway intelligence worker. Use for multi-step diagnostics about runs, decisions, gateway behavior, logs, or source-code issues. The worker can only use read-only tools and returns an evidence report.',
    parameters: Type.Object({
      question: Type.String({
        description:
          'Specific investigation question. Include the observed symptom and what needs explaining.',
      }),
      run_id: Type.Optional(
        Type.String({
          description:
            'Optional run ID or prefix to seed the investigation with run_context_bundle.',
        }),
      ),
      focus: Type.Optional(
        Type.String({
          description:
            'Optional focus area, e.g. decisions, prepare failure, logs, source code, UI/backend mismatch.',
        }),
      ),
    }),
  },

  // ─── Read tools: run history ───
  {
    name: 'search_runs',
    description:
      'Search run history by ticket/PR ref, flow type, outcome, date range. Returns all matching runs (not just active). Use this to check if a ticket was already worked on.',
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: 'Ticket/PR ref or keyword (e.g. PROJ-2483)' }),
      ),
      flow_type: Type.Optional(
        Type.String({ description: 'fix-bug | review-pr | update-branch | etc.' }),
      ),
      outcome: Type.Optional(Type.String({ description: 'merged | approved | failed | etc.' })),
      limit: Type.Optional(Type.Number({ description: 'Max results, default 20' })),
    }),
  },
  {
    name: 'read_task_file',
    description:
      'Read a bounded preview from an orchestrator task directory. Pass run_id to auto-resolve the task dir, or path for a direct relative path that must contain a tasks path segment. Useful for reading TASK.md, artifacts/report.md, artifacts/grade.json.',
    parameters: Type.Object({
      run_id: Type.Optional(
        Type.String({ description: 'Run ID (short or full) — resolves task dir automatically' }),
      ),
      file: Type.Optional(
        Type.String({
          description:
            'File within the task dir, e.g. TASK.md or artifacts/report.md. Defaults to TASK.md',
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: 'Direct path relative to farmslotRoot (alternative to run_id)',
        }),
      ),
    }),
  },
  {
    name: 'check_pr',
    description:
      'Get GitHub PR status (state, title, url, mergeable, branch). Pass pr_ref as "owner/repo#number" — the repository must be explicit.',
    parameters: Type.Object({
      pr_ref: Type.String({
        description:
          'Owner/repo-qualified PR reference, e.g. "deeeed/farmslot#421". A bare number is rejected: there is no default repository to resolve it against.',
      }),
    }),
  },
  {
    name: 'list_pull_requests',
    description:
      'List the Command Center PR dashboard data with recommendation buckets, CI counts, review state, linked run/family IDs, and actionable bot comment counts. Use when the current screen or user question is about PRs, reviews, merge readiness, or CI failures.',
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({
          description: 'Optional Farmslot project filter, e.g. example-browser or example-mobile.',
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: 'Maximum PRs to return after priority sorting. Default 20.' }),
      ),
    }),
  },

  // ─── Read tools: workspace inspection ───
  {
    name: 'read_file',
    description:
      "Read a file from a slot's workspace. Works across local and remote (SSH) slots. Returns file content and detected language.",
    parameters: Type.Object({
      slot_id: Type.String({ description: 'Slot ID' }),
      path: Type.String({
        description:
          'File path relative to repo root (e.g. src/index.ts, .task/TASK.md, package.json)',
      }),
    }),
  },
  {
    name: 'list_files',
    description:
      "List files and directories in a slot's workspace path. Works across local and remote slots.",
    parameters: Type.Object({
      slot_id: Type.String({ description: 'Slot ID' }),
      path: Type.String({ description: 'Directory path relative to repo root. Use "." for root.' }),
    }),
  },
  {
    name: 'git_status',
    description:
      "Get git status of a slot's workspace: current branch, ahead/behind, staged and unstaged changes.",
    parameters: Type.Object({
      slot_id: Type.String({ description: 'Slot ID' }),
    }),
  },
  {
    name: 'git_diff',
    description:
      "Get the full git diff of a slot's workspace. Optionally diff against a base branch (three-dot merge-base diff).",
    parameters: Type.Object({
      slot_id: Type.String({ description: 'Slot ID' }),
      base: Type.Optional(
        Type.String({
          description: 'Base branch for three-dot diff (e.g. main). Omit for unstaged diff.',
        }),
      ),
      path: Type.Optional(Type.String({ description: 'Limit diff to specific file path' })),
    }),
  },
  {
    name: 'git_log',
    description: "Get recent git commits from a slot's workspace.",
    parameters: Type.Object({
      slot_id: Type.String({ description: 'Slot ID' }),
      limit: Type.Optional(Type.Number({ description: 'Max commits to return (default 20)' })),
    }),
  },
  {
    name: 'terminal_snapshot',
    description:
      "Capture the current terminal output of a slot's tmux session. Shows what the worker is doing right now.",
    parameters: Type.Object({
      slot_id: Type.String({ description: 'Slot ID' }),
      lines: Type.Optional(
        Type.Number({ description: 'Number of lines to capture (default 200)' }),
      ),
    }),
  },
  {
    name: 'task_progress',
    description:
      'Get the current task progress of a slot: which phase/step the worker is on, completed vs total steps.',
    parameters: Type.Object({
      slot_id: Type.String({ description: 'Slot ID' }),
    }),
  },
  {
    name: 'search_code',
    description:
      "Search for a pattern in a slot's workspace files. Returns matching lines with file, line number, and context.",
    parameters: Type.Object({
      slot_id: Type.String({ description: 'Slot ID' }),
      pattern: Type.String({ description: 'Search pattern (regex supported)' }),
      file_glob: Type.Optional(
        Type.String({ description: 'Glob to filter files (e.g. "*.ts", "src/**/*.tsx")' }),
      ),
      max_results: Type.Optional(Type.Number({ description: 'Max results (default 50)' })),
    }),
  },

  // ─── Tmux control ───
  {
    name: 'tmux_list',
    description:
      "List all tmux windows and panes in a slot's session. Shows window names, pane sizes, and which is active.",
    parameters: Type.Object({
      slot_id: Type.String({ description: 'Slot ID' }),
    }),
  },
  {
    name: 'tmux_send_keys',
    description:
      "Send raw key sequences to a slot's tmux pane. Use for Ctrl+C (C-c), Escape (Escape), Enter (Enter), Tab (Tab), arrow keys (Up/Down/Left/Right). Keys are space-separated tmux key names.",
    parameters: Type.Object({
      slot_id: Type.String({ description: 'Slot ID' }),
      keys: Type.String({
        description:
          'Space-separated tmux key names, e.g. "C-c" for Ctrl+C, "Escape" for Esc, "Enter" for Enter',
      }),
    }),
  },
  {
    name: 'tmux_select_window',
    description:
      "Switch to a different tmux window in a slot's session. Use tmux_list first to see available windows.",
    parameters: Type.Object({
      slot_id: Type.String({ description: 'Slot ID' }),
      index: Type.Number({ description: 'Window index (0-based, from tmux_list)' }),
    }),
  },

  // ─── Resource management ───
  {
    name: 'resource_list',
    description:
      'List all resources across fleet (or for a specific slot/machine) with current status. Resources include simulators, emulators, browsers, etc.',
    parameters: Type.Object({
      slot_id: Type.Optional(Type.String({ description: 'Slot ID to list resources for' })),
      machine: Type.Optional(
        Type.String({
          description: 'Machine name to list all slot resources (e.g. mini, runner-local)',
        }),
      ),
    }),
  },
  {
    name: 'resource_pressure_snapshot',
    description:
      'Read a fleet resource-pressure snapshot for Co-Pilot diagnosis: machine health, slot load, resource status counts, and idle cleanup candidates. Read-only; use this before proposing cleanup or watch changes.',
    parameters: Type.Object({
      machine: Type.Optional(
        Type.String({
          description: 'Optional machine filter, e.g. mini or runner-local.',
        }),
      ),
      project: Type.Optional(
        Type.String({
          description: 'Optional project filter, e.g. example-mobile.',
        }),
      ),
    }),
  },
  {
    name: 'resource_control',
    description:
      'Boot, shutdown, or relaunch a resource on a specific slot. Use resource_list first to discover available resources and their IDs.',
    parameters: Type.Object({
      slot_id: Type.String({ description: 'Slot ID' }),
      resource_id: Type.String({ description: 'Resource ID (from resource_list)' }),
      action: Type.String({ description: 'Action: boot, shutdown, or relaunch' }),
    }),
  },
  {
    name: 'resource_refresh',
    description:
      'Force re-poll resource health for a slot or all slots on a machine. Returns updated statuses.',
    parameters: Type.Object({
      slot_id: Type.Optional(Type.String({ description: 'Slot ID to refresh' })),
      machine: Type.Optional(Type.String({ description: 'Machine name to refresh all its slots' })),
    }),
  },

  // ─── Write tools ───
  {
    name: 'send_terminal',
    description:
      "Send text to a slot's terminal. Use only when user explicitly requests nudging a worker.",
    parameters: Type.Object({
      slot_id: Type.String(),
      text: Type.String({ description: 'Text to send (tool appends Enter)' }),
    }),
  },
  {
    name: 'cancel_run',
    description: 'Cancel an active run. Use only when user explicitly asks to cancel.',
    parameters: Type.Object({
      run_id: Type.String({ description: 'Run ID or first 8 chars' }),
      reason: Type.Optional(Type.String({ description: 'Cancellation reason' })),
    }),
  },
  {
    name: 'resolve_decision',
    description:
      'Resolve a pending decision on a run (approve ready-gate, pick slot, etc.). Use when user delegates a decision or explicitly asks to resolve one.',
    parameters: Type.Object({
      run_id: Type.String({ description: 'Run ID' }),
      decision_id: Type.String({ description: 'Decision ID' }),
      action_id: Type.String({ description: 'Action ID to select (e.g. approve, reject, pick)' }),
    }),
  },
  {
    name: 'slot_prepare',
    description:
      'Prepare a slot: checkout branch, install deps, run health checks. Long-running operation.',
    parameters: Type.Object({
      slot_id: Type.String(),
      branch: Type.Optional(Type.String({ description: 'Branch to checkout' })),
      merge_main: Type.Optional(Type.Boolean({ description: 'Merge main after checkout' })),
    }),
  },
  {
    name: 'slot_release',
    description:
      'Release a slot after work is done. Resets branch to main and marks slot as released.',
    parameters: Type.Object({
      slot_id: Type.String(),
    }),
  },
  {
    name: 'slot_recycle',
    description:
      'Hard-reset a stuck slot. DESTRUCTIVE: kills processes, wipes state. Use only when user explicitly asks or slot is unrecoverably stuck.',
    parameters: Type.Object({
      slot_id: Type.String(),
    }),
  },
  {
    name: 'queue_add',
    description:
      'Add a task to the dispatch queue. It will be dispatched when a matching slot becomes free.',
    parameters: Type.Object({
      flow_type: Type.String({
        description: 'fix-bug | review-pr | dev | pr-complete | update-branch',
      }),
      project: Type.String({ description: 'Project name e.g. example-mobile' }),
      ticket_or_pr: Type.String({ description: 'Jira ticket URL/key or PR URL/number' }),
      slot_id: Type.Optional(
        Type.String({
          description: 'Target slot (required for update-branch, optional otherwise)',
        }),
      ),
      model: Type.Optional(Type.String({ description: 'LLM model: sonnet | opus | haiku' })),
      runner: Type.Optional(Type.String({ description: 'Runner: claude | codex' })),
    }),
  },
];
