# Completed Milestones — Full Implementation History

> Archived from the legacy command-center roadmap content. These milestones are complete.
> See the current roadmap for active work: [ROADMAP.md](../ROADMAP.md)

---

## Milestone 0: Foundation — DONE

**Goal:** Plumbing works end-to-end. Each package runs independently.

### 0.1 — Workspace Setup ✓

- [x] Yarn workspace config (root package.json, tsconfig.base.json)
- [x] `@farmslot/protocol` package with frame, type, method, event definitions
- [x] `@farmslot/gateway` package with all method handlers (13 source files)
- [x] `@farmslot/agent` package with exec, tmux commands, auto-reconnect
- [x] `ui/` with Vite + Lit, all components, dev harness
- [x] `yarn dev` starts gateway + UI concurrently
- [x] All packages pass `tsc --noEmit` strict checks, zero `as any`

### 0.2 — Gateway ✓

- [x] HTTP server + WebSocket upgrade handler (port 7777)
- [x] Frame routing (req → dispatch → res) with typed per-method assertions
- [x] Broadcast mechanism (push events to all connected clients)
- [x] Fleet state module — reads `.farm-status.json`, caches in memory
- [x] `fleet.status` / `fleet.refresh` methods
- [x] chokidar watch on `.farm-status.json` — push `fleet.updated` events on change
- [x] Slot lifecycle: `slot.check`, `slot.prepare`, `slot.release`, `slot.recycle`
- [x] Dispatch: `dispatch.preview`, `run.create`
- [x] Terminal: `terminal.subscribe`, `terminal.unsubscribe`, `terminal.send`, `terminal.snapshot`
- [x] PR: `pr.status`, `pr.list`, `pr.monitor`
- [x] Decisions: `decision.list`, `decision.resolve`
- [x] Config: `config.pools`, `config.pool`, `config.projects`, `config.project`
- [x] Server-side monitor: fleet polling, decision scanning, violation detection

### 0.3 — Node Agent (MVP) — partial (deployment deferred)

- [x] Agent daemon: connects to gateway WS, sends `connect` with machine identity
- [x] `exec` command: run shell command, stream stdout/stderr back
- [x] `tmux.capture`, `tmux.send`, `tmux.list` commands
- [x] `health.check` command
- [x] Auto-reconnect with exponential backoff
- [x] MachineRegistry on gateway: tracks connected agents, presence events
- [ ] Machine pairing: first-connect token exchange (simple, no crypto v1)
- [ ] Install script for remote machines
- [ ] launchd plist (macOS) / systemd unit (Linux)

> **Deferred:** Agent deployment (install scripts, launchd/systemd, pairing) postponed until all local features are stable. The agent daemon works — what's missing is production deployment tooling for remote machines.

### 0.4 — UI Shell + Dev Harness ✓

- [x] GatewayBrowserClient (request/subscribe/reconnect)
- [x] Client-side state store (FleetStatus, PRStatus, Decisions)
- [x] App shell with hash router + sidebar nav
- [x] Fleet summary bar (slot counts, connection indicator)
- [x] **Dev harness** at `#dev/*` routes
- [x] Mock data factory module (`ui/src/dev/mock-data.ts`)

### 0.5 — Integration: Foundation ✓

- [x] UI connects to real gateway via Vite WS proxy
- [x] Fleet view shows live slot data from `.farm-status.json` (12 real slots)
- [x] Machine presence indicators (presence dots in slot-card, `AGENT_CONNECTED` events)

---

## Milestone 1: Agent Observatory — DONE

### 1.1 — Terminal View (Isolated) ✓

### 1.2 — Terminal Streaming ✓

- [x] Gateway: PTY attach for local slots (node-pty), polling fallback for remote (SSH)
- [x] UI: xterm.js `onData` → `terminal.input` for full keyboard interactivity

### 1.3 — Integration: Terminal ✓

### 1.4 — Multi-Slot Split View (Isolated) ✓

### 1.5 — Integration: Split View ✓

### 1.6 — TASK.md Progress Tracker (Isolated) ✓

### 1.7 — Integration: Progress Tracker ✓

### 1.8 — Nudge & Violation Feed (Isolated) ✓

### 1.9 — Integration: Violations ✓

**Validates:** Open browser, see 4 agents live in split view, progress bars advancing, send a nudge.

---

## Milestone 2: Fleet Map — DONE

### 2.1 — Slot Card (Isolated) ✓

### 2.2 — Fleet Canvas (Isolated) ✓

### 2.3 — Integration: Fleet Map ✓

**Validates:** Fleet map shows all slots. Click one → see its terminal.

---

## Milestone 3: Dispatch & Lifecycle — DONE

### 3.1 — Slot Detail (Isolated) ✓

### 3.2 — Dispatch Wizard (Isolated) ✓

### 3.3 — Slot Scoring (Gateway) ✓

- [x] Port find-slot.sh scoring logic to TypeScript (multi-tier scoring)
- [x] `dispatch.preview` method — native scoring, no bash shelling

### 3.4 — Integration: Dispatch & Lifecycle ✓

---

## Milestone 4: PR Dashboard — DONE

### 4.1 — PR Card (Isolated) ✓

### 4.2 — PR Board (Isolated) ✓

### 4.3 — PR Methods (Gateway) ✓

### 4.4 — Integration: PR Dashboard ✓

- [x] Auto-refresh via 60s polling
- [x] "Dispatch Fix" action → dispatch wizard pre-filled with `pr-complete` flow

---

## Milestone 5: Diff Viewer & Decision Inbox — DONE

### 5.1 — Diff & Source Viewers (Isolated) ✓

- [x] `diff-review` (diff2html), `code-viewer` (Monaco), shadow DOM CSS fix (`adoptDocumentCss`)

### 5.2 — Review Comment Overlay ✓ (done via M7)

### 5.3 — Decision Inbox (Isolated) ✓

### 5.4 — Integration: Diff & Decisions ✓

---

## Milestone 6: Slot Workspace — DONE

**Goal:** Browse a slot's repo, view changed files + diffs without opening Cursor.

### 6.1 — File Tree ✓

### 6.2 — Git Changed Files ✓

### 6.3 — Workspace Layout ✓

### 6.4 — FS & Git Gateway Methods ✓

### 6.4b — Remote Slot Routing ✓

### 6.6 — Integration: Slot Workspace ✓

---

## Milestone 6+: Slot View Polish — DONE

- [x] Editor mode toggle, file search (fuzzy), git staged/unstaged separation
- [x] Always-editable Monaco with Cmd+S save, preview tabs, new file creation
- [x] Git status colors, gitignored files toggle, right-click context menu
- [x] fs.rename, fs.delete, fs.reveal, fs.mkdir gateway methods
- [x] Image/video viewer, tmux control toolbar, Claude Code shortcuts
- [x] Pinned folder in Source Control, scrollable/resizable sections

---

## Milestone 7: PR Review Experience — DONE

### 7.0 — Foundation ✓

- [x] `PRReviewThread` + `PRReviewComment` types, GitHub GraphQL threads
- [x] `pr.addComment`, `pr.resolveThread`, `pr.forSlot` gateway methods

### 7.1 — PR Comments Panel ✓

- [x] Thread-based view grouped by file, filter bar (Unresolved/Resolved/Outdated)
- [x] Reply, resolve/unresolve, click → navigate to file:line

### 7.2 — PR Review Polish ✓

- [x] Inline comment ViewZones in Monaco, markdown rendering, comment edit/delete

### 7.3 — Problems Panel ✓

- [x] `diagnostics.run` method, tsc + eslint output parsing, auto-refresh on save

### 7.4 — Branch Changed-Files View ✓

- [x] `git.branchDiff`, 5th activity tab (delta), comment count badges

---

## Milestone 8: Structured Task Tracking — DONE

### 8.1 — Task Schema & Enhanced Parser ✓

- [x] `generateTaskSchema()` parses `###` headers + `- [ ]` steps on-the-fly from TASK.md

### 8.2 — Schema Generation (Integration) ✓

- [x] chokidar watch on TASK.md, broadcasts `task.progress.updated`
- [x] `SlotStatus` extended with `taskPhase` + `taskStepProgress`

### 8.3 — UI: Structured Progress ✓

- [x] Phase accordion, mini progress bar on fleet cards, real-time updates

---

## v1.1: Resilience & Notifications — DONE

- [x] Server-side monitor loop in gateway (replaces session-bound crons)
- [x] Browser Notification API — permission on startup, deep-link on click, deduplication

---

## Milestone 9: Device Screen Feed — DONE (partial)

### 9.1 — Protocol + Binary WebSocket ✓

### 9.2 — Capture Engine: iOS ✓

- [x] Swift CLI `capture-helper` (ScreenCaptureKit, VideoToolbox H.264)

### 9.3 — Capture Engine: Android — partial

- [x] `adb exec-out screenrecord --output-format=h264` verified on real device
- [ ] Remote verification on gohan/goku (machines unreachable during dev)

### 9.4 — UI: Device Feed Component ✓

### 9.5 — Integration ✓

### 9.6 — Device Panel Polish — partial (D3.6 deferred)

---

## Milestone 10: Script Evolution — Native TS Gateway — DONE

### 10.1 — Core TS Module + gw CLI ✓

- [x] `core/config.ts`, `core/hooks.ts`, `core/exec.ts`, `core/state.ts`
- [x] 18 unit tests, bash parity confirmed

### 10.2 — Native slot.check ✓

- [x] `check-slot.sh` → 40-line thin wrapper (was 286 lines)

### 10.3 — Native fleet.refresh + pr.status/pr.list ✓

- [x] `farm-status.sh` → 100-line thin wrapper (was 629 lines)

### 10.4 — Native lifecycle ✓

- [x] `slotPrepare()`, `slotRelease()`, `dispatchExecute()` in TypeScript
- [x] Thin-wrap `prepare-slot.sh` (319→5 lines), `release-slot.sh` (186→5 lines), `dispatch.sh` (218→20 lines)

### 10.5 — TASK.md live watching ✓

### 10.6 — `farmslot` CLI ✓

- [x] `@farmslot/cli` package with commander.js, all lifecycle commands
- [x] 3-language chain eliminated (bash→Node→Python → single TS binary)

---

## Milestone 11: Gateway-Mediated Orchestration — DONE

### 11.1 — Run Model + Persistence ✓

### 11.2 — Workflow State Machine ✓

### 11.3 — Persistent Monitoring + Decision Queue ✓

### 11.4 — Intelligence Integration ✓

- [x] Claude API client, `gradeTicket()`, `generateTaskContent()`, Jira + GitHub clients

### 11.5 — Run Dashboard UI ✓

### 11.6 — Completion Pipeline ✓

- [x] Artifact archival, PR comment posting, label management, retrospective curation

### 11.7 — Multi-Provider LLM Abstraction ✓

- [x] `@earendil-works/pi-ai` integration, auth cascade, per-project model config

### 11.8 — Run Pipeline Canvas ✓

- [x] SVG pipeline canvas: engine nodes, decision diamonds, actor lanes, pause/resume controls

### 11.9 — Unified Fleet + Run View ✓

- [x] Fleet: expandable panel with `<run-pipeline>` on working slot click
- [x] Slot view: "Run" section in sidebar

### 11.10 — Human Review Gates ✓

- [x] Review workspace, ready workspace, configurable gates per flow type
