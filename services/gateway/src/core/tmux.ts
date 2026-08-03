import path from 'node:path';

import { loadPoolConfigs } from '../fleet/state.js';

import { loadSlotVars } from './config.js';
import { execOnSlot } from './exec.js';

const TMUX_DISCOVERY_TIMEOUT_MS = 3000;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function tmuxShellSnippet(snippet: string): string {
  const trimmed = snippet.trim();
  return [
    'TMUX_BIN="$(command -v tmux 2>/dev/null || true)"',
    'if [ -z "$TMUX_BIN" ]; then',
    '  for candidate in /opt/homebrew/bin/tmux /usr/local/bin/tmux /usr/bin/tmux; do',
    '    if [ -x "$candidate" ]; then TMUX_BIN="$candidate"; break; fi',
    '  done',
    'fi',
    '[ -n "$TMUX_BIN" ] || { echo "tmux not found" >&2; exit 127; }',
    `"$TMUX_BIN" ${trimmed}`,
  ].join('\n');
}

export function parseTmuxKeys(keys: string): string[] {
  return keys.trim().split(/\s+/).filter(Boolean);
}

export function tmuxSendTextCommand(
  target: string,
  text: string,
  opts?: { enter?: boolean; suffix?: string },
): string {
  const suffix = opts?.suffix ? ` ${opts.suffix}` : '';
  const commands = [
    tmuxShellSnippet(`send-keys -t ${shellQuote(target)} -l ${shellQuote(text)}${suffix}`),
  ];
  if (opts?.enter) {
    commands.push(tmuxShellSnippet(`send-keys -t ${shellQuote(target)} Enter${suffix}`));
  }
  return commands.join('\n');
}

export function selectResolvedTmuxSession(configured: string, candidateSessions: string[]): string {
  const unique = Array.from(new Set(candidateSessions.filter(Boolean)));
  return unique.length === 1 ? unique[0] : configured;
}

export interface ResolveTmuxSessionOpts {
  /** Skip the path-based fallback scan. Use when cross-slot contamination must be avoided (e.g. agent detection). */
  strict?: boolean;
}

export async function resolveTmuxSession(
  slotId: string,
  varsArg?: Awaited<ReturnType<typeof loadSlotVars>>,
  opts?: ResolveTmuxSessionOpts,
): Promise<string> {
  const vars = varsArg ?? (await loadSlotVars(slotId));
  const pools = await loadPoolConfigs();
  let configured = vars.session || slotId;
  for (const pool of pools) {
    const slot = pool.slots.find((s) => s.id === slotId);
    if (slot) {
      configured = slot.session;
      break;
    }
  }
  const candidates = Array.from(
    new Set([configured, vars.session, slotId, path.basename(vars.remoteRepo)].filter(Boolean)),
  ) as string[];

  for (const candidate of candidates) {
    const result = await execOnSlot(
      vars,
      tmuxShellSnippet(`has-session -t ${shellQuote(candidate)} 2>/dev/null`),
      { timeout: TMUX_DISCOVERY_TIMEOUT_MS },
    );
    if (result.exitCode === 0) return candidate;
  }

  if (!opts?.strict) {
    try {
      const { stdout } = await execOnSlot(
        vars,
        tmuxShellSnippet(`list-panes -a -F '#{session_name}|#{pane_current_path}' 2>/dev/null`),
        { timeout: TMUX_DISCOVERY_TIMEOUT_MS },
      );
      const matchingSessions: string[] = [];
      for (const line of stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)) {
        const [sessionName, panePath] = line.split('|');
        if (!sessionName || !panePath) continue;
        if (panePath === vars.remoteRepo || panePath.startsWith(`${vars.remoteRepo}/`)) {
          matchingSessions.push(sessionName);
        }
      }
      return selectResolvedTmuxSession(configured, matchingSessions);
    } catch {
      // Fall back to configured session when discovery fails.
    }
  }

  return configured;
}

/**
 * Resolve `${session}:${firstWindowIndex}` for any tmux session, replacing the
 * old `${session}:0` hardcodes that broke on hosts where `base-index 1` is set
 * (mini.local + many community tmux confs). Throws if the session has no
 * windows — a session without windows can't host a worker, and silently
 * returning would let downstream send-keys/rename/display-message hit a
 * non-existent pane and produce confusing "exit 1" errors with empty stderr.
 *
 * Lives in core/tmux so dispatch, slot, self-review, and any future caller
 * share one source of truth — the prior PR's review found `${session}:0`
 * hardcodes scattered across slot.killAgentInSession, runners.resolvePrimaryWorkerTarget,
 * and self-review's pane-target fallback that all had to converge on this helper.
 */
/**
 * Settle after `respawn-window` before polling an interactive runner TUI for
 * readiness. Matches dispatch's ROLE_WINDOW_STARTUP_SETTLE_MS.
 */
export const TMUX_WINDOW_RESPAWN_SETTLE_MS = 500;

/**
 * Launch a shell command in an existing tmux window by replacing its pane via
 * `respawn-window`. Avoids `send-keys -l` for long runner launch lines, which
 * can be poisoned by shell-init escape responses on fresh windows (see dispatch
 * launch prelude comments in methods/dispatch/execute.ts).
 */
export async function respawnTmuxWindowWithCommand(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  command: string,
): Promise<void> {
  const launchCommand = `exec bash -lc ${shellQuote(command)}`;
  const respawned = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `respawn-window -k -t ${shellQuote(target)} -c ${shellQuote(vars.remoteRepo)} ` +
        shellQuote(launchCommand),
    ),
  );
  if (respawned.exitCode !== 0) {
    throw new Error(
      `Failed to launch command in tmux window ${target}: ${respawned.stderr || respawned.stdout || `exit ${respawned.exitCode}`}`,
    );
  }
  const collapse = await execOnSlot(
    vars,
    tmuxShellSnippet(`kill-pane -a -t ${shellQuote(target)} 2>/dev/null || true`),
  );
  if (collapse.exitCode !== 0) {
    throw new Error(
      `Failed to collapse tmux window ${target} to a single pane after launch: ${collapse.stderr || collapse.stdout || `exit ${collapse.exitCode}`}`,
    );
  }
}

export const TMUX_ROLE_WINDOW_MIN_WIDTH = 80;
export const TMUX_ROLE_WINDOW_MIN_HEIGHT = 24;

export async function resolveTmuxPaneId(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
): Promise<string | null> {
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(`list-panes -t ${shellQuote(target)} -F '#{pane_id}' 2>/dev/null | head -1`),
  );
  const paneId = result.stdout.trim();
  return paneId || null;
}

/**
 * Resolve a persisted `session:window-name` without tmux's prefix matching.
 * A missing `rev-claude` must not silently bind to `rev2-claude` during
 * restart recovery.
 */
export async function resolveExactTmuxWindowPane(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
): Promise<{ paneId: string; panePid: string } | null> {
  const separator = target.indexOf(':');
  if (separator <= 0 || separator === target.length - 1) return null;
  const session = target.slice(0, separator);
  const windowName = target.slice(separator + 1);
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `list-panes -a -F '#{session_name}\t#{window_name}\t#{pane_id}\t#{pane_pid}' 2>/dev/null | ` +
        `awk -F '\t' -v session=${shellQuote(session)} -v window=${shellQuote(windowName)} ` +
        `'\$1 == session && \$2 == window { print \$3 "\\t" \$4; exit }'`,
    ),
    { timeout: TMUX_DISCOVERY_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) return null;
  const [paneId, panePid] = result.stdout.trim().split('\t');
  return paneId && panePid && /^%\d+$/.test(paneId) && /^\d+$/.test(panePid)
    ? { paneId, panePid }
    : null;
}

/**
 * Role windows (dev, self-review, ci-fix) need enough lines for capture-pane
 * verification and operator forensics. Tiny windows (e.g. 114x5) truncate prompts
 * and hide progress markers.
 */
export async function ensureTmuxWindowMinimumSize(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  target: string,
  minWidth = TMUX_ROLE_WINDOW_MIN_WIDTH,
  minHeight = TMUX_ROLE_WINDOW_MIN_HEIGHT,
): Promise<void> {
  const dims = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `display-message -t ${shellQuote(target)} -p '#{window_width} #{window_height}' 2>/dev/null`,
    ),
  );
  const [widthRaw, heightRaw] = dims.stdout.trim().split(/\s+/);
  const width = Number.parseInt(widthRaw ?? '', 10);
  const height = Number.parseInt(heightRaw ?? '', 10);
  const nextWidth = Number.isFinite(width) ? Math.max(width, minWidth) : minWidth;
  const nextHeight = Number.isFinite(height) ? Math.max(height, minHeight) : minHeight;
  if (nextWidth === width && nextHeight === height) return;
  const resized = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `resize-window -t ${shellQuote(target)} -x ${nextWidth} -y ${nextHeight} 2>/dev/null`,
    ),
  );
  if (resized.exitCode !== 0) {
    throw new Error(
      `Failed to resize tmux window ${target} to at least ${minWidth}x${minHeight}: ${resized.stderr || resized.stdout || `exit ${resized.exitCode}`}`,
    );
  }
}

export async function firstWindowTarget(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
): Promise<string> {
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(`list-windows -t ${shellQuote(session)} -F '#I' 2>/dev/null | head -1`),
    { timeout: TMUX_DISCOVERY_TIMEOUT_MS },
  );
  const firstIdx = result.stdout.trim();
  if (!firstIdx) {
    throw new Error(`tmux session ${session} has no windows — cannot resolve a worker target`);
  }
  return `${session}:${firstIdx}`;
}
