# ADR-002: tmux Terminal Streaming

**Status:** Accepted
**Date:** 2026-03-26
**Updated:** 2026-03-26 (revised after ADR-008 acceptance)
**Relates to:** [PRD](../PRD-command-center-canonical.md) — Open Question #2, Features C1/C2/C3, [ADR-008](008-remote-communication.md)

## Context

The Agent Observatory (PRD category C) is the highest-priority v1 feature — it replaces Arthur's current workflow of opening multiple Cursor windows to watch agents. Terminal streaming must be low-latency, reliable, and work across local and remote machines.

Each farmslot agent runs inside a tmux session on the slot's machine. The gateway needs to:

1. **Stream** the terminal output to the UI in near-real-time
2. **Accept input** (nudges, corrections) and deliver to the tmux pane
3. **Work identically** for local and remote machines

**Key dependency:** ADR-008 establishes that each machine runs a node agent connected to the gateway via WebSocket. This fundamentally simplifies terminal streaming — the node agent handles tmux locally and pushes data over the existing WebSocket. No SSH needed.

## Options Considered

### A. Poll `tmux capture-pane` (from gateway via SSH)

Gateway periodically runs `tmux capture-pane -t SESSION -p` via SSH, diffs output, sends changes.

**Pros:** Simple, no dependencies beyond SSH
**Cons:** 200-500ms latency, SSH overhead per poll, full pane each time

### B. `tmux pipe-pane` to file + tail (via SSH)

Pipe pane output to a file, tail it remotely.

**Pros:** Lower latency (~50-100ms), incremental
**Cons:** File management on remote machines, only one pipe per pane, raw escape sequences

### C. SSH PTY bridge (`ssh2` → `tmux attach -r`)

Open SSH channel, attach to tmux read-only, stream raw bytes.

**Pros:** True real-time (~10ms)
**Cons:** Persistent SSH per terminal, resize side-effects, two code paths (local vs remote)

### D. Node Agent Local Capture + WS Push

Node agent (ADR-008) runs `tmux capture-pane` locally, diffs, pushes changes over the existing WebSocket to gateway. Gateway forwards to subscribed UI clients.

**Pros:**

- Zero SSH — agent is already connected via WebSocket
- Low latency — local tmux access (~1ms capture) + WS push
- Single code path — local and remote machines use the same agent
- Incremental — agent diffs locally, sends only changes
- No persistent connections beyond the existing agent WS
- xterm.js on UI renders the captured text

**Cons:**

- Capture-pane returns rendered text, not raw pty bytes (no cursor position, no alternate screen)
- Agent poll interval determines latency floor (50-200ms)

### E. Node Agent PTY Attach + WS Push

Node agent spawns `tmux attach -r -t SESSION`, reads raw pty bytes, pushes over WebS.

**Pros:**

- True real-time raw pty stream
- xterm.js renders natively (colors, cursor, alternate screen, scrollback)
- Single code path via agent
- Richer than capture-pane

**Cons:**

- `tmux attach -r` adds a tmux client (minor overhead)
- Raw byte stream is higher bandwidth than diffed capture-pane
- Agent must manage PTY lifecycle (start/stop per subscriber)

## Decision

**Option E — Node Agent PTY Attach + WS Push**, with Option D as fallback.

### Rationale

With the node agent running on every machine (ADR-008), the SSH complexity from Options A-C disappears entirely. The agent handles tmux interaction locally and pushes data over its existing WebSocket — same connection used for all other commands.

Option E (PTY attach) is preferred over D (capture-pane poll) because:

- Raw pty bytes give xterm.js the full terminal experience (cursor, colors, alternate screen)
- Streaming is push-based, not poll-based — lower latency
- This is what makes the Agent Observatory feel like a real terminal, not a text dump

Option D (capture-pane) remains as fallback for edge cases where PTY attach doesn't work (tmux version issues, pane resize conflicts).

### Architecture

```
┌──────────┐     WebSocket      ┌──────────┐     WebSocket      ┌────────────┐
│  Browser  │ ◄──────────────── │  Gateway  │ ◄──────────────── │ Node Agent │
│  xterm.js │ ──(input)───────► │  (routes) │ ──(tmux.send)───► │ (on machine)│
└──────────┘                    └──────────┘                     └─────┬──────┘
                                                                      │ local
                                                                ┌─────▼──────┐
                                                                │ tmux pane  │
                                                                │ (agent)    │
                                                                └────────────┘
```

**Read path (streaming):**

1. UI calls `terminal.subscribe(slotId)` RPC
2. Gateway routes to the machine's node agent: `tmux.stream.start(session)`
3. Node agent spawns `tmux attach -r -t SESSION`, reads stdout (raw pty bytes)
4. Agent pushes byte chunks over WebSocket as `tmux.data` events
5. Gateway forwards to subscribed UI clients as `terminal.data` events
6. xterm.js renders raw bytes

**Write path (input):**

1. UI calls `terminal.send(slotId, text)` RPC
2. Gateway routes to node agent: `tmux.send(session, text)`
3. Node agent runs `tmux send-keys -t SESSION "text" Enter`

**Initial snapshot:**

- On subscribe, agent also runs `tmux capture-pane -t SESSION -p -S -1000`
- Sent as initial payload before starting the live PTY stream
- Gives scrollback context without waiting for new output

**Connection lifecycle:**

- `terminal.subscribe` → agent starts PTY attach, begins streaming
- `terminal.unsubscribe` → agent kills PTY attach, stops streaming
- If agent disconnects → gateway notifies UI ("machine offline"), auto-resume on reconnect
- Multiple UI clients can subscribe to same slot — agent streams once, gateway multicasts

### Fallback (Option D)

If PTY attach causes issues on a specific machine:

- Agent falls back to polling `tmux capture-pane` every 100ms
- Diffs against previous capture, sends only changed lines
- UI receives text updates instead of raw bytes — xterm.js still renders (just without cursor/alternate screen)
- Configurable per machine in agent config

## Consequences

**Positive:**

- Near-real-time terminal viewing via raw pty stream
- Full xterm.js rendering (colors, cursor, alternate screen)
- Single code path — no local-vs-remote split
- No SSH dependency for streaming
- Leverages existing agent WebSocket (zero additional connections)

**Negative:**

- Raw pty stream is higher bandwidth than text diffs (~1-10KB/s typical, bursts higher)
- PTY attach adds a tmux client per subscribed session
- Agent must manage PTY lifecycle

**Risks:**

- `tmux attach -r` behavior across tmux versions — mitigated by fallback to capture-pane
- Bandwidth bursts during large output (file dumps, test results) — mitigated by backpressure in ws library
- Multiple subscribers to same session — mitigated by agent multicasting (one PTY, broadcast to gateway)

## References

- tmux manual: `tmux attach -r` (read-only client), `tmux capture-pane`
- xterm.js: renders raw pty byte streams natively
- ADR-008: Node agent architecture (provides the WebSocket transport)
- Current nudge pattern: `tmux send-keys -t SESSION "text" Enter`
