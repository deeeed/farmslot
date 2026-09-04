// methods/dispatch/role-target.ts — Pure role-target helpers for dispatch tmux windows.

import type { AgentContextTarget } from '@farmslot/protocol';

export { buildDispatchRoleShellCommand } from '../../core/tmux.js';

export function parseCapturedAgentPaneTarget(session: string, raw: string): AgentContextTarget {
  const [rawTarget = session, windowName = null, paneId = null] = raw
    ? raw.split('|', 3)
    : [session, null, null];
  const match = rawTarget.match(/^[^:]+:(\d+)(?:\.(\d+))?$/);
  const window = windowName?.trim() || match?.[1] || null;
  // Named windows are stable across reordered indices; numeric targets drift when
  // metro/recipe windows are added and the original dev pane moves or disappears.
  const target =
    windowName?.trim() && !/^\d+$/.test(windowName.trim())
      ? `${session}:${windowName.trim()}`
      : rawTarget;
  return {
    session,
    window,
    pane: match?.[2] ?? null,
    ...(paneId?.trim() ? { paneId: paneId.trim() } : {}),
    target,
  };
}

/**
 * Routing target for an agent context.
 *
 * An exact `%N` pane id wins: a window can hold several panes, and routing by
 * `session:window` alone lets input reach a sibling pane. Rediscovery records
 * the pane it structurally proved owns the session, so honouring it is what
 * keeps terminal input on that pane. Otherwise prefer a role-scoped window name
 * over a persisted numeric tmux target.
 */
export function canonicalAgentContextTarget(target: AgentContextTarget): string {
  const paneId = target.paneId?.trim();
  if (paneId && /^%\d+$/.test(paneId)) return paneId;
  const session = target.session?.trim();
  const window = target.window?.trim();
  if (session && window && !/^\d+$/.test(window)) {
    return `${session}:${window}`;
  }
  return target.target;
}
