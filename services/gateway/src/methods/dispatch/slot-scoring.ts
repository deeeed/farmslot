import {
  DEFAULT_BRANCH,
  isDispatchScoreStale,
  isSlotRefreshStaleBranch,
  SLOT_STALE_BRANCH_SCORE_PENALTY,
  type SlotStatus,
  type SlotTrackingProjectConfig,
} from '@farmslot/protocol';

export { isDispatchScoreStale, SLOT_STALE_BRANCH_SCORE_PENALTY };

import { JIRA_KEY_RE, normalizeTicketRef } from './ticket-ref.js';

// ─── Slot Scoring ───

const RED_HOST_PENALTY = 100;
const YELLOW_HOST_PENALTY = 20;
const TARGET_BRANCH_BONUS = 100;
const FAMILY_AFFINITY_BONUS = 75;
const STALE_BRANCH_PENALTY = SLOT_STALE_BRANCH_SCORE_PENALTY;
const CDP_MISSING_PENALTY = 5;
const DEVICE_MISSING_PENALTY = 5;
const FIXTURE_STALE_PENALTY = 1;

export function isFreeSlot(slot: SlotStatus): boolean {
  if (slot.lifecycle !== 'ready') return false;
  return slot.agent !== 'working';
}

export function isCdpLive(cdp: string): boolean {
  return cdp !== 'OFF' && cdp !== '-' && cdp !== 'FAIL' && cdp !== 'Other';
}

export type SlotScoringProjectConfig = SlotTrackingProjectConfig;

export function projectConfigsFromProjects(
  projects: ReadonlyArray<{
    name: string;
    defaultBranch?: string;
    slotTrackingBranch?: string;
  }>,
): Record<string, SlotScoringProjectConfig> {
  return Object.fromEntries(
    projects.map((p) => [
      p.name,
      {
        defaultBranch: p.defaultBranch ?? DEFAULT_BRANCH,
        slotTrackingBranch: p.slotTrackingBranch,
      },
    ]),
  );
}

export function slotTrackingConfigForSlot(
  slot: SlotStatus,
  projectConfigs?: Readonly<Record<string, SlotScoringProjectConfig>>,
): SlotScoringProjectConfig {
  const cfg = projectConfigs?.[slot.project];
  return {
    defaultBranch: cfg?.defaultBranch ?? DEFAULT_BRANCH,
    slotTrackingBranch: cfg?.slotTrackingBranch,
  };
}

export function isDispatchStaleBranch(
  slot: SlotStatus,
  projectConfigs?: Readonly<Record<string, SlotScoringProjectConfig>>,
): boolean {
  return isSlotRefreshStaleBranch(
    slot.branch ?? '',
    slotTrackingConfigForSlot(slot, projectConfigs),
    {
      session: slot.session,
      slotId: slot.slot,
      linkedWorktree: slot.linkedWorktree,
    },
  );
}

export function slotScore(
  slot: SlotStatus,
  targetBranch?: string,
  options?: {
    familyId?: string | null;
    projectConfigs?: Readonly<Record<string, SlotScoringProjectConfig>>;
  },
): number {
  let score = 0;
  const hostHeadroom = slot.hostLoad?.headroom;
  const hostRed = hostHeadroom === 'red';
  // Host load penalty. Red stays dominant; yellow remains eligible for PR-branch affinity.
  if (slot.hostLoad) {
    if (slot.hostLoad.headroom === 'red') score += RED_HOST_PENALTY;
    if (slot.hostLoad.headroom === 'yellow') score += YELLOW_HOST_PENALTY;
  }
  // Branch matching — PR-bound flows pass the PR's head branch as targetBranch.
  // A slot already sitting on that branch has no merge-main / checkout cost,
  // so flip the usual stale penalty into a decisive bonus. Without this, the
  // PR's own slot would score +50 (stale) and lose to any slot on main.
  if (targetBranch && slot.branch === targetBranch && !hostRed) {
    score -= TARGET_BRANCH_BONUS;
  } else if (isDispatchStaleBranch(slot, options?.projectConfigs)) {
    // Stale branch is the primary penalty — prepare must reset to idle baseline first
    score += STALE_BRANCH_PENALTY;
  }
  // Family matching — follow-up flows (review-pr / pr-complete / merge-main) often
  // target a PR whose head branch is not discoverable yet from pr.list/gh, but the
  // run store can still tell us which dev/fix family produced it. Prefer the slot
  // already carrying that family over clean main so the operator lands back in the
  // prepared workspace with inherited context nearby. Red host load remains dominant
  // just like target-branch affinity.
  if (options?.familyId && slot.currentFamilyId === options.familyId && !hostRed) {
    score -= FAMILY_AFFINITY_BONUS;
  }
  // Device and CDP are tiebreakers — prepare rebuilds these anyway
  if (!isCdpLive(slot.health.cdp)) score += CDP_MISSING_PENALTY;
  if (!slot.health.device.endsWith(':OK')) score += DEVICE_MISSING_PENALTY;
  if (slot.health.fixtures !== 'OK') score += FIXTURE_STALE_PENALTY;
  return score;
}

export function resolveJiraTargetBranchFromFleet(
  slots: SlotStatus[],
  project: string,
  ticketOrPr: string,
  projectConfigs?: Readonly<Record<string, SlotScoringProjectConfig>>,
): string | undefined {
  const canonical = normalizeTicketRef(ticketOrPr);
  if (!JIRA_KEY_RE.test(canonical)) return undefined;
  return (
    slots.find(
      (s) =>
        s.project === project &&
        isFreeSlot(s) &&
        s.branch &&
        isDispatchStaleBranch(s, projectConfigs) &&
        branchContainsJiraKey(s.branch, canonical),
    )?.branch || undefined
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function branchContainsJiraKey(branch: string, jiraKey: string): boolean {
  const ticketSlug = normalizeTicketRef(jiraKey).toLowerCase();
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(ticketSlug)}($|[^a-z0-9])`, 'i').test(branch);
}

export function findBestSlot(
  slots: SlotStatus[],
  project: string,
  options?: {
    allowedSlots?: string[] | null;
    targetBranch?: string;
    familyId?: string | null;
    lane?: string | null;
    variant?: string | null;
    projectConfigs?: Readonly<Record<string, SlotScoringProjectConfig>>;
  },
): SlotStatus | null {
  const allow =
    options?.allowedSlots && options.allowedSlots.length > 0 ? new Set(options.allowedSlots) : null;
  const candidates = slots
    .filter((s) => {
      if (s.project !== project || !isFreeSlot(s) || (allow && !allow.has(s.slot))) return false;
      if (slotBranchCheckoutBlocker(s, slots, options?.targetBranch)) return false;
      if (
        !s.currentRunId &&
        !s.currentFamilyId &&
        !s.currentLane &&
        !s.currentVariant &&
        !s.currentTicketOrPr &&
        !s.currentFlowType
      )
        return true;
      const policy = evaluateSlotIdentityPolicy(
        {
          runId: s.currentRunId,
          ticket: s.currentTicketOrPr,
          flow: s.currentFlowType,
          familyId: s.currentFamilyId,
          lane: s.currentLane,
          variant: s.currentVariant,
        },
        {
          familyId: options?.familyId,
          lane: options?.lane,
          variant: options?.variant,
        },
      );
      return policy.action !== 'block';
    })
    .sort(
      (a, b) =>
        slotScore(a, options?.targetBranch, {
          familyId: options?.familyId,
          projectConfigs: options?.projectConfigs,
        }) -
        slotScore(b, options?.targetBranch, {
          familyId: options?.familyId,
          projectConfigs: options?.projectConfigs,
        }),
    );
  if (candidates.length === 0) return null;
  const cdpCandidates = candidates.filter((s) => isCdpLive(s.health.cdp));
  return cdpCandidates.length > 0 ? cdpCandidates[0] : candidates[0];
}

export function slotBranchCheckoutBlocker(
  slot: SlotStatus,
  slots: readonly SlotStatus[],
  targetBranch?: string | null,
): SlotStatus | null {
  if (!targetBranch || !slot.linkedWorktree || slot.branch === targetBranch) return null;
  return (
    slots.find(
      (other) =>
        other.slot !== slot.slot &&
        other.project === slot.project &&
        other.linkedWorktree &&
        other.branch === targetBranch,
    ) ?? null
  );
}

export function validateSlotForTargetBranch(
  slot: SlotStatus,
  slots: readonly SlotStatus[],
  targetBranch?: string | null,
): string | null {
  const baseError = validateSlot(slot);
  if (baseError) return baseError;
  const blocker = slotBranchCheckoutBlocker(slot, slots, targetBranch);
  if (!blocker) return null;
  return `Branch ${targetBranch} is already checked out by linked worktree slot ${blocker.slot}`;
}

export function validateSlot(slot: SlotStatus): string | null {
  if (slot.lifecycle === 'disabled') return 'Slot is disabled';
  if (slot.lifecycle === 'manual') return 'Slot is in manual mode';
  if (slot.agent === 'working') return 'Agent is working';
  if (slot.lifecycle === 'busy') return `Slot is busy (${slot.phase ?? 'unknown'})`;
  return null;
}

export function evaluateSlotIdentityPolicy(
  existing: {
    runId?: string | null;
    ticket?: string | null;
    flow?: string | null;
    familyId?: string | null;
    lane?: string | null;
    variant?: string | null;
  },
  requested: {
    runId?: string | null;
    ticket?: string | null;
    flow?: string | null;
    familyId?: string | null;
    lane?: string | null;
    variant?: string | null;
    /**
     * When set, the requested run was forked from a known sibling run
     * (collision-redirect or "Re-run alongside"). Allows landing on a fresh
     * (all-null) slot — the parent reference is the legitimacy signal that
     * stand-in for the missing slot identity. Without this, the strict-comparison
     * branch below would block every forked comparison from claiming a freshly
     * prepared slot.
     */
    parentRunId?: string | null;
  },
  mode?: 'interactive' | 'autonomous' | 'validation',
): { action: 'allow' | 'warn' | 'scrub' | 'block'; strictComparison: boolean } {
  const strictComparison = requested.lane === 'comparison';
  const sameRun = strictComparison
    ? Boolean(existing.runId && requested.runId && existing.runId === requested.runId)
    : !existing.runId || !requested.runId || existing.runId === requested.runId;
  if (sameRun) return { action: 'allow', strictComparison: requested.lane === 'comparison' };
  const slotIsFresh = !existing.runId && !existing.familyId && !existing.lane;
  if (strictComparison && slotIsFresh && (requested.parentRunId || requested.familyId)) {
    // Comparison run landing on a freshly-prepared slot. A `parentRunId`
    // proves a legitimate fork; a `familyId` proves a legitimate sibling
    // cluster (or the family root, where familyId == runId). A fully-null
    // slot has no residual identity to clash with, so allow the claim.
    return { action: 'allow', strictComparison };
  }
  if (strictComparison && (!existing.runId || !existing.familyId || !existing.lane)) {
    return { action: mode === 'validation' ? 'scrub' : 'block', strictComparison };
  }
  const sameTaskFamily =
    !existing.ticket || !requested.ticket || existing.ticket === requested.ticket;
  const sameFlow = !existing.flow || !requested.flow || existing.flow === requested.flow;
  const sameFamilyIdentity = strictComparison
    ? existing.familyId === requested.familyId
    : !existing.familyId || !requested.familyId || existing.familyId === requested.familyId;
  const sameLane = strictComparison
    ? existing.lane === requested.lane
    : !existing.lane || !requested.lane || existing.lane === requested.lane;
  const sameVariant = strictComparison
    ? (existing.variant ?? null) === (requested.variant ?? null)
    : !existing.variant || !requested.variant || existing.variant === requested.variant;
  const sameFamilyFollowUp = Boolean(
    existing.familyId &&
    requested.familyId &&
    existing.familyId === requested.familyId &&
    sameLane &&
    sameVariant,
  );

  if (
    (sameTaskFamily && sameFlow && sameFamilyIdentity && sameLane && sameVariant) ||
    sameFamilyFollowUp
  ) {
    const legacyIdentity = !strictComparison && (!existing.familyId || !existing.lane);
    return { action: legacyIdentity ? 'warn' : 'allow', strictComparison };
  }
  return { action: mode === 'validation' ? 'scrub' : 'block', strictComparison };
}

export function buildSlotClaimStatus(params: {
  runId?: string | null;
  taskId: string;
  flowSubdir: string;
  taskFolderId: string;
  flowType: string | null;
  mode?: 'interactive' | 'autonomous' | 'validation';
  runner: string;
  model: string;
  currentRun?: { familyId?: string | null; lane?: string | null; variant?: string | null } | null;
  fallbackLane?: string | null;
  fallbackVariant?: string | null;
}) {
  return {
    lifecycle: 'busy',
    phase: 'dispatching',
    task_id: params.taskId,
    task_file: `${params.flowSubdir}/${params.taskFolderId}`,
    current_run_id: params.runId ?? null,
    current_flow_type: params.flowType || null,
    current_ticket_or_pr: params.taskId,
    current_mode: params.mode ?? null,
    current_family_id: params.currentRun?.familyId ?? null,
    current_lane: params.currentRun?.lane ?? params.fallbackLane ?? null,
    current_variant: params.currentRun?.variant ?? params.fallbackVariant ?? null,
    dispatched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    completed_at: null,
    runner: params.runner,
    model: params.model,
  };
}
