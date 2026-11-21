import type { ResourceConnectionReason } from '@farmslot/protocol/client-cache';

import type { WorkspaceAccess } from './workspace-access';

export interface StartupWorkspace {
  profileId: string;
  gatewayUrl: string;
  principalId: string | null;
}

export interface StartupRunAuthority extends StartupWorkspace {
  startupWorkspace?: StartupWorkspace | null;
  status: 'disconnected' | 'connecting' | 'connected';
  workspaceAccess: WorkspaceAccess;
  signedOut: boolean;
  refused: boolean;
  offline?: boolean;
}

export function startupRunDestination(href: string): string | null {
  const path = href.split('?', 1)[0];
  const runId = '[a-z0-9][a-z0-9._-]*';
  return new RegExp(
    `^/(?:evidence/${runId}|run/${runId}|workspace/run/${runId}/evidence)$`,
    'i',
  ).test(path)
    ? href
    : null;
}

/** Undefined waits for the selected startup workspace. Null discards its pending link. */
export function resolveStartupRunDestination(
  href: string,
  authority: StartupRunAuthority,
): string | null | undefined {
  if (authority.signedOut || authority.refused) return null;
  const initial = authority.startupWorkspace;
  if (initial === null) return null;
  if (initial === undefined) return undefined;
  if (authority.gatewayUrl !== initial.gatewayUrl || authority.profileId !== initial.profileId)
    return null;
  if (authority.status !== 'connected') return authority.offline ? null : undefined;
  if (
    authority.workspaceAccess !== 'farm' ||
    !authority.principalId ||
    (initial.principalId !== null && authority.principalId !== initial.principalId)
  )
    return null;
  return href;
}

export function startupFallbackAccess(
  authority: StartupRunAuthority,
  remembered: { access: WorkspaceAccess; principalId?: string },
): WorkspaceAccess {
  if (authority.signedOut || authority.refused) return 'none';
  if (authority.status === 'connected') return authority.workspaceAccess;
  const initial = authority.startupWorkspace;
  return authority.offline &&
    initial?.profileId === authority.profileId &&
    initial.gatewayUrl === authority.gatewayUrl &&
    initial.principalId === remembered.principalId
    ? remembered.access
    : 'none';
}

export function pendingStartupRunDestination(href: string) {
  const destination = startupRunDestination(href);
  if (destination === null) return null;
  let consumed = false;
  return {
    href: destination,
    claim() {
      if (consumed) return false;
      consumed = true;
      return true;
    },
  };
}

export function startupWorkspaceAfterConnectionChange(
  workspace: StartupWorkspace | null | undefined,
  reason: ResourceConnectionReason | undefined,
): StartupWorkspace | null | undefined {
  // Connection reasons are transient. Keep a rejected startup scope rejected after reconnect.
  return reason === 'principal-change' ||
    reason === 'profile-change' ||
    reason === 'sign-out' ||
    reason === 'credential-refused' ||
    reason === 'session-ended'
    ? null
    : workspace;
}
