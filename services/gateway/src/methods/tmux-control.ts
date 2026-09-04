// methods/tmux-control.ts — tmux split, pane navigation, window management

import { randomUUID } from 'node:crypto';

import type {
  OkResult,
  TmuxKillPaneParams,
  TmuxListParams,
  TmuxListResult,
  TmuxNewWindowParams,
  TmuxNewWindowResult,
  TmuxPane,
  TmuxPasteTextParams,
  TmuxRenameWindowParams,
  TmuxSelectPaneParams,
  TmuxSelectWindowParams,
  TmuxSendKeysParams,
  TmuxSplitParams,
  TmuxSynchronizePanesParams,
  TmuxWindow,
  TmuxZoomPaneParams,
} from '@farmslot/protocol';

import { resolveAgentTarget } from '../agents/contexts.js';
import { execOnSlot } from '../core/exec.js';
import { loadSlotVars } from '../core/index.js';
import { parseTmuxKeys, resolveTmuxSession, shellQuote, tmuxShellSnippet } from '../core/tmux.js';

const TMUX_LIST_TIMEOUT_MS = 3000;
const TMUX_LIST_CACHE_TTL_MS = 3000;

const tmuxListCache = new Map<string, { checkedAt: number; result: TmuxListResult }>();
const tmuxListInFlight = new Map<string, Promise<TmuxListResult>>();

type TmuxControlParams = { slotId: string; bareSession?: boolean } & Parameters<
  typeof resolveAgentTarget
>[1];

async function resolveTmuxControlTarget(params: TmuxControlParams): Promise<{
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  target: string;
  session: string;
}> {
  const vars = await loadSlotVars(params.slotId);
  if (params.bareSession === true) {
    const session = await resolveTmuxSession(params.slotId, vars);
    return { vars, target: session, session };
  }
  const resolved = await resolveAgentTarget(params.slotId, params);
  return { vars, target: resolved.target, session: resolved.session };
}

function tmuxListCacheKey(vars: Awaited<ReturnType<typeof loadSlotVars>>, session: string): string {
  return `${vars.machine}:${vars.slotId}:${session}`;
}

function clearTmuxListCache(vars: Awaited<ReturnType<typeof loadSlotVars>>, session: string): void {
  tmuxListCache.delete(tmuxListCacheKey(vars, session));
}

export async function tmuxSplit(params: TmuxSplitParams): Promise<OkResult> {
  const { vars, target, session } = await resolveTmuxControlTarget(params);
  const flag = params.direction === 'h' ? '-h' : '-v';
  await execOnSlot(
    vars,
    tmuxShellSnippet(`split-window ${flag} -t ${shellQuote(target)} -c '#{pane_current_path}'`),
  );
  clearTmuxListCache(vars, session);
  return { ok: true };
}

export async function tmuxSelectPane(params: TmuxSelectPaneParams): Promise<OkResult> {
  const { vars, target, session } = await resolveTmuxControlTarget(params);
  await execOnSlot(
    vars,
    tmuxShellSnippet(`select-pane -${params.direction} -t ${shellQuote(target)}`),
  );
  clearTmuxListCache(vars, session);
  return { ok: true };
}

export async function tmuxKillPane(params: TmuxKillPaneParams): Promise<OkResult> {
  const { vars, target, session } = await resolveTmuxControlTarget(params);
  await execOnSlot(vars, tmuxShellSnippet(`kill-pane -t ${shellQuote(target)}`));
  clearTmuxListCache(vars, session);
  return { ok: true };
}

export async function tmuxZoomPane(params: TmuxZoomPaneParams): Promise<OkResult> {
  const { vars, target, session } = await resolveTmuxControlTarget(params);
  await execOnSlot(vars, tmuxShellSnippet(`resize-pane -Z -t ${shellQuote(target)}`));
  clearTmuxListCache(vars, session);
  return { ok: true };
}

export async function tmuxNewWindow(params: TmuxNewWindowParams): Promise<TmuxNewWindowResult> {
  const { vars, session } = await resolveTmuxControlTarget(params);
  // `-P -F` makes tmux print the identity of what it just created, so callers
  // never have to guess which window is theirs.
  const created = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `new-window -P -F '#{pane_id}|#{window_index}|#{window_name}|#{session_name}' -t ${shellQuote(session)}`,
    ),
  );
  clearTmuxListCache(vars, session);
  if (created.exitCode !== 0) {
    throw new Error(
      `tmux new-window in ${session} failed: ${created.stderr?.trim() || created.stdout?.trim() || `exit ${created.exitCode}`}`,
    );
  }
  const [paneId, windowIndex, windowName, sessionName] = created.stdout.trim().split('|');
  return {
    ok: true,
    ...(paneId && /^%\d+$/.test(paneId) ? { paneId } : {}),
    ...(windowIndex && /^\d+$/.test(windowIndex) ? { windowIndex: Number(windowIndex) } : {}),
    ...(windowName ? { windowName } : {}),
    ...(sessionName ? { sessionName } : {}),
  };
}

export async function tmuxSelectWindow(params: TmuxSelectWindowParams): Promise<OkResult> {
  const { vars, session } = await resolveTmuxControlTarget(params);
  await execOnSlot(
    vars,
    tmuxShellSnippet(`select-window -t ${shellQuote(`${session}:${params.index}`)}`),
  );
  clearTmuxListCache(vars, session);
  return { ok: true };
}

export async function tmuxRenameWindow(params: TmuxRenameWindowParams): Promise<OkResult> {
  const { vars, target, session } = await resolveTmuxControlTarget(params);
  // B2: Require a window-qualified target to avoid renaming the wrong window
  // when the role context hasn't materialized yet (resolveAgentTarget falls back
  // to the bare session, which renames whichever window is currently active).
  if (!target.includes(':')) {
    throw new Error(
      `tmuxRenameWindow requires a window-qualified target (session:window), got bare session: ${target}`,
    );
  }
  await execOnSlot(
    vars,
    tmuxShellSnippet(`rename-window -t ${shellQuote(target)} ${shellQuote(params.name)}`),
  );
  clearTmuxListCache(vars, session);
  return { ok: true };
}

export async function tmuxList(params: TmuxListParams): Promise<TmuxListResult> {
  const { vars, session } = await resolveTmuxControlTarget(params);
  const cacheKey = tmuxListCacheKey(vars, session);
  const cached = tmuxListCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < TMUX_LIST_CACHE_TTL_MS) {
    return cached.result;
  }

  const existing = tmuxListInFlight.get(cacheKey);
  if (existing) return existing;

  const pending = listTmuxWindows(vars, session).then((result) => {
    tmuxListCache.set(cacheKey, { checkedAt: Date.now(), result });
    return result;
  });
  tmuxListInFlight.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    tmuxListInFlight.delete(cacheKey);
  }
}

async function listTmuxWindows(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  session: string,
): Promise<TmuxListResult> {
  // Get windows
  const { stdout: winOut } = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `list-windows -t ${shellQuote(session)} -F '#{window_index}|#{window_name}|#{window_active}'`,
    ),
    { timeout: TMUX_LIST_TIMEOUT_MS },
  );

  const windows: TmuxWindow[] = [];

  for (const line of winOut.trim().split('\n').filter(Boolean)) {
    const [indexStr, name, activeStr] = line.split('|');
    const winIndex = parseInt(indexStr, 10);

    // Get panes for this window
    const { stdout: paneOut } = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-panes -t ${shellQuote(`${session}:${winIndex}`)} -F '#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_title}|#{pane_current_command}|#{pane_id}|#{pane_pid}'`,
      ),
      { timeout: TMUX_LIST_TIMEOUT_MS },
    );

    const panes: TmuxPane[] = [];
    for (const paneLine of paneOut.trim().split('\n').filter(Boolean)) {
      const [pi, pa, pw, ph, pt, pc, pid, ppid] = paneLine.split('|');
      panes.push({
        index: parseInt(pi, 10),
        active: pa === '1',
        width: parseInt(pw, 10),
        height: parseInt(ph, 10),
        title: pt || '',
        ...(pc ? { currentCommand: pc } : {}),
        ...(pid ? { paneId: pid } : {}),
        ...(ppid ? { panePid: ppid } : {}),
      });
    }

    const { stdout: syncOut } = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `show-window-options -qv -t ${shellQuote(`${session}:${winIndex}`)} synchronize-panes`,
      ),
      { timeout: TMUX_LIST_TIMEOUT_MS },
    );

    windows.push({
      index: winIndex,
      name,
      active: activeStr === '1',
      synchronizePanes: syncOut.trim() === 'on',
      panes,
    });
  }

  return { windows };
}

export async function tmuxSendKeys(params: TmuxSendKeysParams): Promise<OkResult> {
  const { vars, target } = await resolveTmuxControlTarget(params);
  const keyArgs = parseTmuxKeys(params.keys).map(shellQuote).join(' ');
  const result = await execOnSlot(
    vars,
    tmuxShellSnippet(`send-keys -t ${shellQuote(target)} ${keyArgs}`),
  );
  // `{ ok: true }` regardless of the tmux exit code hid every send into a
  // window that had already been destroyed.
  if (result.exitCode !== 0) {
    throw new Error(
      `tmux send-keys to ${target} failed: ${result.stderr?.trim() || result.stdout?.trim() || `exit ${result.exitCode}`}`,
    );
  }
  return { ok: true };
}

/**
 * Deliver text to a pane as one bracketed paste.
 *
 * `send-keys` types the text, and tmux chunks it: a multi-kilobyte command
 * arrives in pieces and a shell can be left mid-token at a continuation prompt
 * with nothing executed. A paste buffer is written once and pasted once, which
 * is also what an operator's own paste does. `-p` brackets it so the shell does
 * not execute on an embedded newline; the caller submits explicitly.
 */
export async function tmuxPasteText(params: TmuxPasteTextParams): Promise<OkResult> {
  const { vars, target } = await resolveTmuxControlTarget(params);
  const bufferName = `farmslot-paste-${randomUUID()}`;
  const write = await execOnSlot(
    vars,
    tmuxShellSnippet(`set-buffer -b ${shellQuote(bufferName)} -- ${shellQuote(params.text)}`),
  );
  if (write.exitCode !== 0) {
    throw new Error(
      `tmux set-buffer for ${target} failed: ${write.stderr?.trim() || write.stdout?.trim() || `exit ${write.exitCode}`}`,
    );
  }
  // `-d` deletes the buffer after pasting, so a long command is never left in
  // the slot's shared paste stack.
  const paste = await execOnSlot(
    vars,
    tmuxShellSnippet(`paste-buffer -d -p -b ${shellQuote(bufferName)} -t ${shellQuote(target)}`),
  );
  if (paste.exitCode !== 0) {
    await execOnSlot(
      vars,
      tmuxShellSnippet(`delete-buffer -b ${shellQuote(bufferName)} 2>/dev/null || true`),
    );
    throw new Error(
      `tmux paste-buffer to ${target} failed: ${paste.stderr?.trim() || paste.stdout?.trim() || `exit ${paste.exitCode}`}`,
    );
  }
  if (params.submit) {
    const submit = await execOnSlot(
      vars,
      tmuxShellSnippet(`send-keys -t ${shellQuote(target)} Enter`),
    );
    if (submit.exitCode !== 0) {
      throw new Error(
        `tmux submit to ${target} failed: ${submit.stderr?.trim() || submit.stdout?.trim() || `exit ${submit.exitCode}`}`,
      );
    }
  }
  return { ok: true };
}

export async function tmuxSynchronizePanes(params: TmuxSynchronizePanesParams): Promise<OkResult> {
  const { vars, target, session } = await resolveTmuxControlTarget(params);
  await execOnSlot(
    vars,
    tmuxShellSnippet(
      `set-window-option -t ${shellQuote(target)} synchronize-panes ${params.enabled ? 'on' : 'off'}`,
    ),
  );
  clearTmuxListCache(vars, session);
  return { ok: true };
}
