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

/** Prefer a role-scoped window name over a persisted numeric tmux target. */
export function canonicalAgentContextTarget(target: AgentContextTarget): string {
  const session = target.session?.trim();
  const window = target.window?.trim();
  if (session && window && !/^\d+$/.test(window)) {
    return `${session}:${window}`;
  }
  return target.target;
}
