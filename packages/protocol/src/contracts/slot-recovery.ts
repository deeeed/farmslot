import type { SlotStatus } from './slots.js';

export type SlotWorkPublication = 'baseline' | 'merged' | 'pushed' | 'unpushed' | 'unknown';
export type SlotRecoveryPhase = 'inspect' | 'cleanup' | 'reset' | 'fixtures' | 'verify';
export type SlotRecoveryRefusal =
  | 'dirty'
  | 'stale'
  | 'unpushed'
  | 'unknown'
  | 'identity-changed'
  | 'protected'
  | 'failed-phase';

/** Confirmation identity. A HEAD-only confirmation cannot authorize changed local files. */
export interface SlotWorkspaceIdentity {
  epoch: number;
  currentRunId: string | null;
  cleanupRunId: string | null;
  handoffRunId: string | null;
  branch: string;
  headSha: string;
  dirtyFingerprint: string;
  recoveryId: string | null;
}

export interface SlotRecovery {
  id: string;
  identity: SlotWorkspaceIdentity;
  completed: SlotRecoveryPhase[];
  phase: SlotRecoveryPhase;
  error?: string;
}

export interface SlotWorkspace extends SlotWorkspaceIdentity {
  observedAt: string;
  defaultBranch?: string;
  localDefaultSha: string | null;
  defaultFetchedAt: string | null;
  remoteDefaultSha: string | null;
  remoteObservedAt: string | null;
  behind: number | null;
  remoteAdvanced: boolean;
  publication: SlotWorkPublication;
  dirtyCount: number;
  unpublishedCount: number;
  protectedReason?: string;
  terminalOwner?: boolean;
  error?: string;
  pullRequest?: { repo: string; number: number; state: 'merged' };
  recovery?: SlotRecovery;
}

export interface SlotRecoveryEligibility {
  allowed: boolean;
  bulkAllowed: boolean;
  /** Opening a read-only review is safe while publication evidence refreshes. */
  bulkInspectable: boolean;
  confirmationRequired: boolean;
  reason?: SlotRecoveryRefusal;
  detail?: string;
}

/** The gateway rechecks this same rule at execution; renderers never infer force authority. */
export function slotRecoveryEligibility(
  slot: SlotStatus | undefined,
  now = Date.now(),
): SlotRecoveryEligibility {
  let bulkInspectable = false;
  const blocked = (
    detail: string,
    reason: SlotRecoveryRefusal = 'protected',
  ): SlotRecoveryEligibility => ({
    allowed: false,
    bulkAllowed: false,
    bulkInspectable,
    confirmationRequired: false,
    reason,
    detail,
  });
  if (!slot || slot.missingFromPool) return blocked('Slot is missing from the pool');
  if (!slot.enabled || slot.lifecycle === 'disabled') return blocked('Slot is disabled');
  if (slot.health.ssh === 'FAIL') return blocked('Node is offline');
  if (slot.lifecycle === 'manual') return blocked('Slot is in manual mode');
  if (slot.agent === 'working') return blocked('Slot is working');
  if (slot.cleanupRunId || slot.handoffRunId) return blocked('Slot has a cleanup or handoff owner');
  bulkInspectable = slot.lifecycle === 'ready' && !slot.currentRunId;
  const work = slot.workspace;
  if (!work) return blocked(slot.workspaceError ?? 'Workspace has not been inspected', 'unknown');
  const observed = Date.parse(work.observedAt);
  if (!Number.isFinite(observed) || now - observed > 30_000)
    return blocked('Workspace inspection expired', 'unknown');
  if (slot.lifecycle === 'busy' && !work.terminalOwner) return blocked('Slot is working');
  bulkInspectable = slot.lifecycle === 'ready' && !work.currentRunId;
  if (work.protectedReason) {
    bulkInspectable = false;
    return blocked(work.protectedReason);
  }
  if (work.cleanupRunId || work.handoffRunId) {
    bulkInspectable = false;
    return blocked('Slot has a cleanup or handoff owner');
  }
  if (
    slot.lifecycle === 'held' &&
    !work.recovery &&
    !(work.terminalOwner && slot.phase !== 'occupied' && !slot.heldReason)
  )
    return blocked(slot.heldReason ?? 'Slot is held');
  if (work.publication === 'unknown')
    return blocked(work.error ?? 'Publication is unknown', 'unknown');
  const confirmationRequired = work.dirtyCount > 0 || work.publication === 'unpushed';
  return {
    allowed: true,
    bulkInspectable,
    bulkAllowed:
      slot.lifecycle === 'ready' && !work.currentRunId && !work.recovery && !confirmationRequired,
    confirmationRequired,
    ...(confirmationRequired
      ? { reason: work.dirtyCount > 0 ? ('dirty' as const) : ('unpushed' as const) }
      : {}),
  };
}

export function slotWorkspaceIdentity(work: SlotWorkspaceIdentity): SlotWorkspaceIdentity {
  const {
    epoch,
    currentRunId,
    cleanupRunId,
    handoffRunId,
    branch,
    headSha,
    dirtyFingerprint,
    recoveryId,
  } = work;
  return {
    epoch,
    currentRunId,
    cleanupRunId,
    handoffRunId,
    branch,
    headSha,
    dirtyFingerprint,
    recoveryId,
  };
}

export function sameSlotWorkspace(
  left: SlotWorkspaceIdentity,
  right: SlotWorkspaceIdentity,
): boolean {
  return (
    JSON.stringify(slotWorkspaceIdentity(left)) === JSON.stringify(slotWorkspaceIdentity(right))
  );
}
