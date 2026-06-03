// methods/tmux-control.ts — tmux split, pane navigation, window management

import type {
  OkResult,
  TmuxKillPaneParams,
  TmuxListParams,
  TmuxListResult,
  TmuxNewWindowParams,
  TmuxPane,
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

export async function tmuxNewWindow(params: TmuxNewWindowParams): Promise<OkResult> {
  const { vars, session } = await resolveTmuxControlTarget(params);
  await execOnSlot(vars, tmuxShellSnippet(`new-window -t ${shellQuote(session)}`));
  clearTmuxListCache(vars, session);
  return { ok: true };
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
        `list-panes -t ${shellQuote(`${session}:${winIndex}`)} -F '#{pane_index}|#{pane_active}|#{pane_width}|#{pane_height}|#{pane_title}'`,
      ),
      { timeout: TMUX_LIST_TIMEOUT_MS },
    );

    const panes: TmuxPane[] = [];
    for (const paneLine of paneOut.trim().split('\n').filter(Boolean)) {
      const [pi, pa, pw, ph, pt] = paneLine.split('|');
      panes.push({
        index: parseInt(pi, 10),
        active: pa === '1',
        width: parseInt(pw, 10),
        height: parseInt(ph, 10),
        title: pt || '',
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
  await execOnSlot(vars, tmuxShellSnippet(`send-keys -t ${shellQuote(target)} ${keyArgs}`));
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
