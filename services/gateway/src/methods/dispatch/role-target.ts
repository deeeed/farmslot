// methods/dispatch/role-target.ts — Pure role-target helpers for dispatch tmux windows.

import type { AgentContextTarget } from '@farmslot/protocol';

import { shellQuote } from '../../core/tmux.js';

export function parseCapturedAgentPaneTarget(session: string, raw: string): AgentContextTarget {
  const [target = session, windowName = null] = raw ? raw.split('|', 2) : [session, null];
  const match = target.match(/^[^:]+:(\d+)(?:\.(\d+))?$/);
  return {
    session,
    window: windowName || match?.[1] || null,
    pane: match?.[2] ?? null,
    target,
  };
}

export function buildDispatchRoleShellCommand(remoteRepo: string): string {
  return `cd ${shellQuote(remoteRepo)} && exec \${SHELL:-bash}`;
}
