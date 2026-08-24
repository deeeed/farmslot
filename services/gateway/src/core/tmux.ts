import path from 'node:path';

import type { ExecResult } from '@farmslot/protocol';

import { loadPoolConfigs } from '../fleet/state.js';

import { loadSlotVars } from './config.js';
import { execOnSlot } from './exec.js';

// Remote node RPC under load often exceeds 3s. Discovery is runner-agnostic
// (Claude/Codex/Grok/Cursor all call resolveTmuxSession). A timeout must miss
// and fall back to the configured session, not fail the pipeline.
const TMUX_DISCOVERY_TIMEOUT_MS = 15_000;

export function tmuxDiscoveryFailedResult(err: unknown): ExecResult | null {
  const message = err instanceof Error ? err.message : String(err);
  if (
    /timeout after \d+ms/i.test(message) ||
    /WebSocket not open/i.test(message) ||
    /No node connected for machine /i.test(message)
  ) {
    return { stdout: '', stderr: message, exitCode: 124 };
  }
  return null;
}

/** `has-session` 124 is a transport miss, not "this name is absent". Stop walking aliases. */
export function tmuxSessionProbeShouldKeepConfigured(exitCode: number): boolean {
  return exitCode === 124;
}

/** Pane/window queries must not treat a timeout as "missing". */
export function throwIfTmuxQueryTimedOut(result: ExecResult, context: string): void {
  if (result.exitCode !== 124) return;
  throw new Error(`tmux ${context} timed out: ${result.stderr || 'exit 124'}`);
}

async function execTmuxDiscovery(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  cmd: string,
): Promise<ExecResult> {
  try {
    return await execOnSlot(vars, cmd, { timeout: TMUX_DISCOVERY_TIMEOUT_MS });
  } catch (err) {
    const mapped = tmuxDiscoveryFailedResult(err);
    if (mapped) return mapped;
    throw err;
  }
}

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

export function buildDispatchRoleShellCommand(remoteRepo: string): string {
  return [
    `cd ${shellQuote(remoteRepo)}`,
    // Managed role windows must never pause on Oh My Zsh's interactive update
    // question after a runner exits. The operator can still update zsh outside
    // Farmslot; this only disables the prompt in lifecycle-owned shells.
    'export DISABLE_AUTO_UPDATE=true',
    'shell="${SHELL:-}"',
    'if [ -z "$shell" ]; then shell="$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | awk \'{print $2}\')"; fi',
    'if [ -z "$shell" ]; then shell="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"; fi',
    'exec "${shell:-/bin/sh}"',
  ].join(' && ');
}

export function parseTmuxKeys(keys: string): string[] {
  return keys.trim().split(/\s+/).filter(Boolean);
}

export function tmuxSendTextCommand(
  target: string,
  text: string,
  opts?: {
    enter?: boolean;
    submitKey?: 'Enter' | 'C-m';
    /** Opt-in gap between literal text and submit for TUIs with paste-burst detection. */
    submitDelayMs?: number;
    suffix?: string;
  },
): string {
  const submitDelayMs = opts?.submitDelayMs ?? 0;
  if (!Number.isInteger(submitDelayMs) || submitDelayMs < 0 || submitDelayMs > 1_000) {
    throw new Error(
      `tmux submitDelayMs must be an integer between 0 and 1000 (got ${submitDelayMs})`,
    );
  }
  const suffix = opts?.suffix ? ` ${opts.suffix}` : '';
  const commands = [
    tmuxShellSnippet(`send-keys -t ${shellQuote(target)} -l ${shellQuote(text)}${suffix}`),
  ];
  if (opts?.enter) {
    if (submitDelayMs > 0) commands.push(`sleep ${submitDelayMs / 1_000}`);
    commands.push(
      tmuxShellSnippet(`send-keys -t ${shellQuote(target)} ${opts.submitKey ?? 'Enter'}${suffix}`),
    );
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
    const result = await execTmuxDiscovery(
      vars,
      // Tmux otherwise prefix-matches `ff-1` to `ff-1-orch`, returning the
      // configured alias instead of the session that actually owns the pane.
      tmuxShellSnippet(`has-session -t ${shellQuote(`=${candidate}`)} 2>/dev/null`),
    );
    if (result.exitCode === 0) return candidate;
    // Transport miss is not "this name is absent". Do not walk slotId /
    // basename aliases or we can bind a sibling session (ff-1 vs farmslot-1).
    if (tmuxSessionProbeShouldKeepConfigured(result.exitCode)) return configured;
  }

  if (!opts?.strict) {
    try {
      const { stdout, exitCode } = await execTmuxDiscovery(
        vars,
        tmuxShellSnippet(`list-panes -a -F '#{session_name}|#{pane_current_path}' 2>/dev/null`),
      );
      if (tmuxSessionProbeShouldKeepConfigured(exitCode)) return configured;
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
    } catch (err) {
      const mapped = tmuxDiscoveryFailedResult(err);
      if (mapped) return configured;
      throw err;
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

export function buildTmuxRespawnLaunchCommand(
  command: string,
  remoteRepo: string,
  preserveWindowAfterExit = false,
): string {
  if (!preserveWindowAfterExit) return `exec bash -lc ${shellQuote(command)}`;
  return `bash -c ${shellQuote(
    [`bash -lc ${shellQuote(command)}`, buildDispatchRoleShellCommand(remoteRepo)].join('\n'),
  )}`;
}

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
  options?: { preserveWindowAfterExit?: boolean },
): Promise<void> {
  const launchCommand = buildTmuxRespawnLaunchCommand(
    command,
    vars.remoteRepo,
    options?.preserveWindowAfterExit,
  );
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

/** Replace one exact pane without terminating sibling panes in the same window. */
export async function respawnTmuxPaneWithCommand(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  paneId: string,
  command: string,
  options?: { preservePaneAfterExit?: boolean },
): Promise<void> {
  if (!/^%\d+$/.test(paneId)) throw new Error(`Invalid exact tmux pane id: ${paneId}`);
  const launchCommand = buildTmuxRespawnLaunchCommand(
    command,
    vars.remoteRepo,
    options?.preservePaneAfterExit,
  );
  const respawned = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `respawn-pane -k -t ${shellQuote(paneId)} -c ${shellQuote(vars.remoteRepo)} ` +
        shellQuote(launchCommand),
    ),
  );
  if (respawned.exitCode !== 0) {
    throw new Error(
      `Failed to launch command in tmux pane ${paneId}: ${respawned.stderr || respawned.stdout || `exit ${respawned.exitCode}`}`,
    );
  }
}

export interface TmuxWindowRef {
  windowId: string;
  windowIndex: number;
  windowName: string;
  activityAt: number;
  paneId: string;
  panePid: string;
}

/** List exact named windows without tmux's prefix or first-name-match semantics. */
export async function listExactTmuxWindows(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  windowName: string,
): Promise<TmuxWindowRef[]> {
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `list-panes -a -F '#{session_name}\t#{window_name}\t#{window_id}\t#{window_index}\t#{window_activity}\t#{pane_id}\t#{pane_pid}' 2>/dev/null`,
    ),
    { timeout: TMUX_DISCOVERY_TIMEOUT_MS },
  );
  throwIfTmuxQueryTimedOut(result, `listExactTmuxWindows ${session}:${windowName}`);
  if (result.exitCode !== 0) return [];

  const windows = new Map<string, TmuxWindowRef>();
  for (const line of result.stdout.split('\n')) {
    const [candidateSession, candidateName, windowId, indexRaw, activityRaw, paneId, panePid] =
      line.split('\t');
    if (candidateSession !== session || candidateName !== windowName) continue;
    if (!/^@\d+$/.test(windowId ?? '') || !/^%\d+$/.test(paneId ?? '')) continue;
    if (!/^\d+$/.test(panePid ?? '')) continue;
    if (windows.has(windowId!)) continue;
    windows.set(windowId!, {
      windowId: windowId!,
      windowIndex: Number.parseInt(indexRaw ?? '', 10),
      windowName: candidateName!,
      activityAt: Number.parseInt(activityRaw ?? '', 10),
      paneId: paneId!,
      panePid: panePid!,
    });
  }
  return [...windows.values()];
}

/** Ensure at least one exact, named tmux window exists before reconciliation. */
export async function ensureTmuxWindow(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
  windowName: string,
): Promise<{ disposition: 'existing' | 'created'; windows: TmuxWindowRef[] }> {
  const existing = await listExactTmuxWindows(vars, session, windowName);
  if (existing.length > 0) return { disposition: 'existing', windows: existing };
  const created = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `new-window -t ${shellQuote(`=${session}`)} -n ${shellQuote(windowName)} -d 2>&1`,
    ),
  );
  const afterCreate = await listExactTmuxWindows(vars, session, windowName);
  if (afterCreate.length > 0) {
    return { disposition: created.exitCode === 0 ? 'created' : 'existing', windows: afterCreate };
  }
  throw new Error(
    `Failed to create tmux window ${session}:${windowName}: ${created.stderr || created.stdout || `exit ${created.exitCode}`}`,
  );
}

export async function killTmuxWindowById(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  windowId: string,
): Promise<void> {
  const killed = await execOnSlot(
    vars,
    tmuxShellSnippet(`kill-window -t ${shellQuote(windowId)} 2>/dev/null`),
  );
  if (killed.exitCode !== 0) {
    throw new Error(
      `Failed to remove duplicate tmux window ${windowId}: ${killed.stderr || killed.stdout || `exit ${killed.exitCode}`}`,
    );
  }
}

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

export function selectExactTmuxWindowPane(
  output: string,
  session: string,
  windowName: string,
): { paneId: string; panePid: string } | null {
  for (const line of output.split('\n')) {
    const [candidateSession, candidateWindow, paneId, panePid] = line.split('\t');
    if (candidateSession !== session || candidateWindow !== windowName) continue;
    return paneId && panePid && /^%\d+$/.test(paneId) && /^\d+$/.test(panePid)
      ? { paneId, panePid }
      : null;
  }
  return null;
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
  if (/^%\d+$/.test(target)) {
    const result = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `display-message -p -t ${shellQuote(target)} '#{pane_id}\t#{pane_pid}' 2>/dev/null`,
      ),
      { timeout: TMUX_DISCOVERY_TIMEOUT_MS },
    );
    throwIfTmuxQueryTimedOut(result, `resolveExactTmuxWindowPane ${target}`);
    const [paneId, panePid] = result.stdout.trim().split('\t');
    return result.exitCode === 0 && /^%\d+$/.test(paneId ?? '') && /^\d+$/.test(panePid ?? '')
      ? { paneId: paneId!, panePid: panePid! }
      : null;
  }
  if (/^@\d+$/.test(target)) {
    const result = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-panes -t ${shellQuote(target)} -F '#{pane_id}\t#{pane_pid}' 2>/dev/null | head -1`,
      ),
      { timeout: TMUX_DISCOVERY_TIMEOUT_MS },
    );
    throwIfTmuxQueryTimedOut(result, `resolveExactTmuxWindowPane ${target}`);
    const [paneId, panePid] = result.stdout.trim().split('\t');
    return result.exitCode === 0 && /^%\d+$/.test(paneId ?? '') && /^\d+$/.test(panePid ?? '')
      ? { paneId: paneId!, panePid: panePid! }
      : null;
  }
  const separator = target.indexOf(':');
  if (separator <= 0 || separator === target.length - 1) return null;
  const session = target.slice(0, separator);
  const windowName = target.slice(separator + 1);
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `list-panes -a -F '#{session_name}\t#{window_name}\t#{pane_id}\t#{pane_pid}' 2>/dev/null`,
    ),
    { timeout: TMUX_DISCOVERY_TIMEOUT_MS },
  );
  throwIfTmuxQueryTimedOut(result, `resolveExactTmuxWindowPane ${target}`);
  if (result.exitCode !== 0) return null;
  return selectExactTmuxWindowPane(result.stdout, session, windowName);
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
  throwIfTmuxQueryTimedOut(result, `firstWindowTarget ${session}`);
  const firstIdx = result.stdout.trim();
  if (!firstIdx) {
    throw new Error(`tmux session ${session} has no windows — cannot resolve a worker target`);
  }
  return `${session}:${firstIdx}`;
}
