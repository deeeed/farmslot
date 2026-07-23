import {
  execOnSlot,
  expandTemplate,
  getProjectField,
  type ProjectVars,
  type RawProjectJson,
  type SlotVars,
} from '../../core/index.js';
import { resolveTmuxSession, shellQuote, tmuxShellSnippet } from '../../core/tmux.js';

import { buildPrepareKillWindowsByNameCommand } from './prepare-command.js';

/**
 * Dedicated tmux window that live-tails the project's dev-server log so operators
 * attached to the slot session (or the Command Center slot terminal) get streaming
 * dev-server output without hand-typing a `tail`. It complements the preserved
 * preflight pane: that pane holds the dev server's PTY alive and shows the
 * preflight scrollback, while this window follows the log file the dev server
 * keeps writing to after preflight's foreground portion finishes.
 *
 * Generic mechanism, project-supplied path: the log location comes from the
 * project's `health.dev_server_log` field (template-expanded, relative to the slot
 * repo) — the framework never hardcodes `metro.log`. Mobile farm points it at
 * Metro, the extension farm at Webpack, and so on.
 */
export const DEVSERVER_LOG_WINDOW_NAME = 'devserver-log';

const TMUX_CMD_TIMEOUT_MS = 10_000;

/**
 * Resolve the slot-host path to the project's dev-server log, or null when the
 * project does not configure one. Mirrors slotCheck's expansion: the configured
 * value must be repo-relative, is template-expanded, and is anchored to the slot
 * repo.
 */
export function resolveDevServerLogPath(
  projectJson: RawProjectJson,
  vars: SlotVars,
  projectVars: ProjectVars | undefined,
): string | null {
  const configured = getProjectField(projectJson, 'health.dev_server_log');
  if (!configured) return null;
  const expanded = expandTemplate(configured, vars, projectVars).trim();
  if (!expanded) return null;
  return `${vars.remoteRepo}/${expanded}`;
}

/**
 * tmux command that (re)creates the dev-server-log tail window idempotently:
 * kill any prior window of the same name first so a re-prepare replaces rather
 * than stacks duplicates, then open a fresh detached window running the tail.
 *
 * `tail -F` (follow by name) is deliberate: it waits for a not-yet-written log to
 * appear and re-opens the file after preflight truncates/rotates it, so a missing
 * log never crashes the window. `-d` keeps the window in the background — it never
 * steals the operator's focus, and a passive reader never holds the slot busy or
 * interferes with the preserved preflight pane.
 */
export function buildDevServerLogTailWindowCommand(
  session: string,
  logPath: string,
  cwd: string,
  windowName = DEVSERVER_LOG_WINDOW_NAME,
): string {
  const tailCmd = `tail -F ${shellQuote(logPath)}`;
  return [
    buildPrepareKillWindowsByNameCommand(session, windowName),
    tmuxShellSnippet(
      `"$TMUX_BIN" new-window -d -t ${shellQuote(`${session}:`)} ` +
        `-n ${shellQuote(windowName)} -c ${shellQuote(cwd)} ${shellQuote(tailCmd)}`,
    ),
  ].join('\n');
}

/** tmux command that closes the dev-server-log tail window if present. */
export function buildCloseDevServerLogTailWindowCommand(
  session: string,
  windowName = DEVSERVER_LOG_WINDOW_NAME,
): string {
  return buildPrepareKillWindowsByNameCommand(session, windowName);
}

/**
 * Open (or replace) the dev-server-log tail window in the slot's session. The
 * caller resolves the session; the window is only opened when a log path is
 * configured. Never throws — a tmux glitch must not fail an otherwise-successful
 * prepare, so failures are reported as a non-opened result for the caller to log.
 */
export async function openDevServerLogTailWindow(
  vars: SlotVars,
  session: string,
  logPath: string,
): Promise<{ opened: boolean; detail: string }> {
  const command = buildDevServerLogTailWindowCommand(session, logPath, vars.remoteRepo);
  try {
    const result = await execOnSlot(vars, command, { timeout: TMUX_CMD_TIMEOUT_MS });
    if (result.exitCode === 0) {
      return {
        opened: true,
        detail: `Tailing dev-server log in tmux window '${DEVSERVER_LOG_WINDOW_NAME}' (${logPath})`,
      };
    }
    return {
      opened: false,
      detail: `dev-server log tail window skipped: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
    };
  } catch (error) {
    return {
      opened: false,
      detail: `dev-server log tail window skipped: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Close the dev-server-log tail window during slot teardown. The slot's tmux
 * session outlives a release (only role windows are killed), so this window must
 * be closed explicitly. Best-effort: a missing window or session is a no-op.
 */
export async function closeDevServerLogTailWindow(
  vars: SlotVars,
  sessionOverride?: string,
): Promise<void> {
  try {
    const session = sessionOverride ?? (await resolveTmuxSession(vars.slotId, vars));
    await execOnSlot(vars, buildCloseDevServerLogTailWindowCommand(session), {
      timeout: TMUX_CMD_TIMEOUT_MS,
    });
  } catch {
    // Cleanup is best-effort; a missing tmux session must not fail slot release.
  }
}
