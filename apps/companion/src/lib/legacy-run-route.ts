import { ACTIVE_RUN_STATUSES, type RunStatus } from '@farmslot/protocol';

export type RunWorkspaceTab = 'diff' | 'evidence' | 'files' | 'timeline';

export function runWorkspaceTabForLegacyPackageTab(packageTab: string): RunWorkspaceTab {
  return packageTab === 'diff' || packageTab === 'timeline' || packageTab === 'files'
    ? packageTab
    : 'evidence';
}

export const runWorkspacePathnames = {
  diff: '/workspace/run/[runId]/diff',
  evidence: '/workspace/run/[runId]/evidence',
  files: '/workspace/run/[runId]/files',
  timeline: '/workspace/run/[runId]/timeline',
} as const;

export function runWorkspacePathnameForStatus(
  status: RunStatus | null | undefined,
): (typeof runWorkspacePathnames)[keyof typeof runWorkspacePathnames] {
  return status && ACTIVE_RUN_STATUSES.includes(status)
    ? runWorkspacePathnames.timeline
    : runWorkspacePathnames.evidence;
}
