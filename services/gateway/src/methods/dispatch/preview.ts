import {
  DEFAULT_CLAUDE_MODEL,
  type DispatchCandidatesParams,
  type DispatchCandidatesResult,
  type DispatchPreviewParams,
  type DispatchPreviewResult,
  type FlowType,
  isPressureAdmissionRejected,
  PR_BOUND_FLOW_TYPES,
  type PressureAdmissionDecision,
  primaryRoleForFlow,
  type Run,
  type SlotStatus,
} from '@farmslot/protocol';

import {
  execOnSlot,
  isLocal,
  loadProjectVars,
  loadSlotVars,
  SLOT_PHASE_RELEASING,
  updateSlotStatus,
} from '../../core/index.js';
import { firstWindowTarget, resolveTmuxSession, shellQuote } from '../../core/tmux.js';
import { buildFollowUpLineage } from '../../family-observability/context.js';
import { findFollowUpParentRun } from '../../family-observability/state.js';
import { getNode } from '../../fleet/machine-registry.js';
import { loadFleetStatus, loadProjectConfig, loadProjectConfigs } from '../../fleet/state.js';
import { detectProfileFit } from '../../run-engine/profile-fit-gate.js';
import { fetchTicketData } from '../../run-engine/ticket-data.js';
import {
  normalizeRunner,
  runnerDefaultModel,
  runnerSupportsTmuxNudges,
  runnerSupportsTmuxNudgesForLaunch,
} from '../../runners/registry.js';
import { getRunnerStatusProvider } from '../../runners/status-provider.js';
import { getAllRuns } from '../../runs/store.js';
import { currentSessionOriginator } from '../../security/work-originator.js';
import {
  projectUsesExecutionTemplateCatalog,
  resolveConfiguredExecutionTemplateForSlot,
} from '../../tasks/execution-template-catalog.js';
import { gitHeadProbeCommand, parseGitHeadProbe, slotHeadRefreshUpdate } from '../fleet.js';
import { normalizeRunCreateMode } from '../run-create-mode.js';

import {
  capturePressureAdmissionDecisions,
  formatPressureRejection,
} from './pressure-admission.js';
import {
  activeRunIds,
  activeRunSlotIds,
  companionResourceBlocker,
  findBestSlot,
  isCdpLive,
  isDispatchStaleBranch,
  isFreeSlot,
  isReplaceableWarmSlot,
  parkPreservedSlotIds,
  type ParkPreservedWorkspace,
  prepareProfileNeedsCompanionResource,
  projectConfigsFromProjects,
  slotScore,
  validateSlotForDispatch,
} from './slot-scoring.js';
import { resolveDispatchTargetBranch } from './target-branch.js';
import { normalizeTicketRef } from './ticket-ref.js';

const BRANCH_REFRESH_CONCURRENCY = 4;
const BRANCH_REFRESH_TIMEOUT_MS = 5_000;
/** Skip a live git probe when this slot was refreshed this recently. */
export const BRANCH_REFRESH_TTL_MS = 30_000;
const branchRefreshAt = new Map<string, number>();

export function resetBranchRefreshTimestampsForTests(): void {
  branchRefreshAt.clear();
}

export function slotsNeedingBranchRefresh(
  slots: readonly SlotStatus[],
  lastRefreshAt: ReadonlyMap<string, number>,
  now: number,
  ttlMs: number,
): SlotStatus[] {
  return slots.filter((slot) => {
    const at = lastRefreshAt.get(slot.slot);
    return at === undefined || now - at >= ttlMs;
  });
}

export function selectDispatchCandidateSlots(
  slots: readonly SlotStatus[],
  params: { project?: string; machines?: string[] },
): SlotStatus[] {
  const machineFilter =
    params.machines && params.machines.length > 0 ? new Set(params.machines) : null;
  return slots.filter(
    (slot) =>
      slot.lifecycle !== 'disabled' &&
      (!params.project || slot.project === params.project) &&
      (!machineFilter || machineFilter.has(slot.machine)),
  );
}

interface DispatchFamilyContext {
  familyId?: string;
  parentRunId?: string;
  familyRootTicketOrPr?: string;
  inferredFromParentRunId?: string;
}

function parsePrNumberForFollowUp(input: { flowType?: string | null; ticketOrPr?: string | null }) {
  if (!input.ticketOrPr) return null;
  const flowType = input.flowType as FlowType | undefined;
  if (!flowType || !PR_BOUND_FLOW_TYPES.has(flowType)) return null;
  const normalized = normalizeTicketRef(input.ticketOrPr);
  const match = normalized.match(/#(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function resolveDispatchFamilyContext(
  params: {
    flowType?: string | null;
    ticketOrPr?: string | null;
    project?: string;
    familyId?: string | null;
    parentRunId?: string | null;
    familyRootTicketOrPr?: string | null;
    targetBranch?: string | null;
  },
  runs: Run[] = getAllRuns(),
): DispatchFamilyContext {
  if (params.familyId) {
    return {
      familyId: params.familyId,
      parentRunId: params.parentRunId ?? undefined,
      familyRootTicketOrPr: params.familyRootTicketOrPr ?? undefined,
    };
  }
  if (!params.flowType || !params.ticketOrPr || !params.project) return {};
  const flowType = params.flowType as FlowType;
  if (!PR_BOUND_FLOW_TYPES.has(flowType)) return {};
  const parent = findFollowUpParentRun(runs, {
    ticketOrPr: normalizeTicketRef(params.ticketOrPr),
    prNumber: parsePrNumberForFollowUp(params),
    branch: params.targetBranch,
    project: params.project,
  });
  if (!parent) return {};
  const lineage = buildFollowUpLineage(parent);
  return { ...lineage, inferredFromParentRunId: parent.id };
}

// ─── PR Affinity — prefer slot already on this PR's branch ───

export function findAffinitySlot(
  slots: SlotStatus[],
  project: string,
  ticketOrPr: string,
  options?: {
    familyId?: string | null;
    lane?: string | null;
    variant?: string | null;
    allowedSlots?: string[] | null;
  },
): SlotStatus | null {
  const allow =
    options?.allowedSlots && options.allowedSlots.length > 0 ? new Set(options.allowedSlots) : null;
  const ticketSlug = ticketOrPr.replace(/[#/]/g, '-').toLowerCase();
  // Extract PR number from "owner/repo#1234" or "#1234"
  const prMatch = ticketOrPr.match(/#(\d+)$/);
  const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;

  const strictComparison = options?.lane === 'comparison';
  return (
    slots.find(
      (s) =>
        s.project === project &&
        !s.missingFromPool &&
        (!allow || allow.has(s.slot)) &&
        s.lifecycle === 'held' &&
        s.agent !== 'working' &&
        (strictComparison
          ? s.currentFamilyId === options?.familyId &&
            s.currentLane === options?.lane &&
            (s.currentVariant ?? null) === (options?.variant ?? null)
          : !options?.familyId || !s.currentFamilyId || s.currentFamilyId === options.familyId) &&
        (strictComparison
          ? true
          : !options?.lane || !s.currentLane || s.currentLane === options.lane) &&
        (strictComparison
          ? true
          : !options?.variant || !s.currentVariant || s.currentVariant === options.variant) &&
        (s.branch.includes(ticketSlug) || (prNumber != null && s.prHealth?.pr === prNumber)),
    ) ?? null
  );
}

// ─── Branch-Affinity Nudge — busy slot on the target PR's branch ───
//
// Mirror of findAffinitySlot but inverted on busy state. findAffinitySlot keeps the strict
// `lifecycle === 'held' && agent !== 'working'` gate that ADR-024 §7 production-lane reuse
// safety depends on; this companion finder targets the *opposite* slice — slots actively
// running a worker on the PR's own branch — so the operator can choose to nudge into the
// loaded session instead of dispatching fresh on a stale free slot. Documented at
// docs/adr/024-run-lanes-and-run-family-model.md §7 addendum (2026-04-30).

export interface BranchAffinityNudgeCandidate {
  slot: SlotStatus;
  uncommittedCount: number;
  uncommittedFiles: string[];
  nudgeCount: number;
  ctxPct: number | null;
  prMatchKind: 'pr-number' | 'branch-slug';
  riskFlags: string[];
  /** True when the slot's runner supports tmux send-keys nudges (Claude today). When false,
   * the row still surfaces — operators want to see "this slot is on the PR's branch" even for
   * codex / opencode workers — but only the **Fresh dispatch** action is available; the
   * **Nudge worker** action is gated off because it would silently fail under that runner's
   * model (codex resumes via `--continue` re-exec, not send-keys). */
  canNudge: boolean;
}

/** Cap the file list rendered in the wizard / decision card. Keeps the payload bounded so a
 * worker mid-refactor with hundreds of unstaged files doesn't balloon the WebSocket frame. */
const NUDGE_FILE_LIST_LIMIT = 10;
/** Empirical threshold for surfacing a `high-nudge-count` risk flag. Beyond ~5 nudges the
 * worker's context starts to look like a different conversation than the one the operator
 * intended to nudge into; tune per-project once we have telemetry. */
const HIGH_NUDGE_COUNT_THRESHOLD = 5;
/** Claude triggers `/compact` around 80-90% of the context window. Below 80% a nudge is
 * usually absorbed without compacting; above 80% the operator should know it will. */
const HIGH_CTX_PCT_THRESHOLD = 80;

function isBranchAffinityCandidateBranchMatch(
  slot: SlotStatus,
  ticketSlug: string,
  prNumber: number | null,
  targetBranch: string | null,
): { matched: true; kind: 'pr-number' | 'branch-slug' } | { matched: false } {
  // Exact head-branch equality is the strongest signal (the dispatch wizard / run.create
  // already resolved the PR's head branch against the live PR list). Treat it as a PR-number-
  // grade match — when we have an authoritative branch, prHealth.pr would just confirm what
  // we already know.
  if (targetBranch && slot.branch && slot.branch === targetBranch)
    return { matched: true, kind: 'pr-number' };
  if (prNumber != null && slot.prHealth?.pr === prNumber)
    return { matched: true, kind: 'pr-number' };
  // PR-number ambiguity guard: if the slot has a known prHealth.pr that's NOT the requested PR,
  // skip even if the branch slug looks similar — branch reuse across PRs is rare but real, and
  // a slug-only match in the face of a contradicting prHealth is exactly the wrong slot to reuse.
  if (prNumber != null && slot.prHealth?.pr != null && slot.prHealth.pr !== prNumber)
    return { matched: false };
  if (ticketSlug && slot.branch.toLowerCase().includes(ticketSlug))
    return { matched: true, kind: 'branch-slug' };
  return { matched: false };
}

function passesBranchAffinityLaneGate(
  slot: SlotStatus,
  options: { familyId?: string | null; lane?: string | null; variant?: string | null } | undefined,
): boolean {
  // Comparison-lane requests are gated out at the call site (run-engine + dispatchCandidates),
  // but defend-in-depth: if a comparison lane somehow reaches here, require strict identity.
  if (options?.lane === 'comparison') {
    return (
      slot.currentFamilyId === options?.familyId &&
      slot.currentLane === options?.lane &&
      (slot.currentVariant ?? null) === (options?.variant ?? null)
    );
  }
  // Production / validation: allow if either side is null OR they match. Family mismatch is a
  // soft warning surfaced via riskFlags, not a hard skip — operator chooses.
  if (options?.lane && slot.currentLane && slot.currentLane !== options.lane) return false;
  return true;
}

function buildBranchAffinityRiskFlags(
  slot: SlotStatus,
  options: { familyId?: string | null; lane?: string | null; variant?: string | null } | undefined,
  nudgeCount: number,
  ctxPct: number | null,
  prMatchKind: 'pr-number' | 'branch-slug',
  uncommittedCount: number,
  metaFetchFailed: boolean,
): string[] {
  const flags: string[] = [];
  if (prMatchKind === 'branch-slug') flags.push('branch-slug-only');
  if (options?.familyId && slot.currentFamilyId && slot.currentFamilyId !== options.familyId)
    flags.push('family-mismatch');
  if (options?.variant && slot.currentVariant && slot.currentVariant !== options.variant)
    flags.push('variant-mismatch');
  if (nudgeCount >= HIGH_NUDGE_COUNT_THRESHOLD) flags.push('high-nudge-count');
  if (ctxPct != null && ctxPct >= HIGH_CTX_PCT_THRESHOLD) flags.push('high-ctx-pct');
  if (uncommittedCount > 0) flags.push('uncommitted-changes');
  if (metaFetchFailed) flags.push('meta-fetch-failed');
  return flags;
}

interface BranchAffinityCandidateMeta {
  uncommittedCount: number;
  uncommittedFiles: string[];
  ctxPct: number | null;
  /** True when at least one sub-fetch (vars / git status / ctxPct) failed. Surfaced as the
   * `meta-fetch-failed` risk flag so the wizard renders a "?" chip instead of pretending the
   * slot has zero uncommitted files / unknown ctx — those are different signals. */
  metaFetchFailed: boolean;
}

async function captureBranchAffinityCandidateMeta(
  slot: SlotStatus,
): Promise<BranchAffinityCandidateMeta> {
  // Candidate-meta enrichment is best-effort: an unreachable slot or a runner without a status
  // provider must not block the caller from offering nudge UX. Each sub-fetch is settled
  // independently via Promise.allSettled so one failure (e.g. SSH down for git status) does
  // not erase the data we did manage to capture from the other.
  let vars: Awaited<ReturnType<typeof loadSlotVars>>;
  try {
    vars = await loadSlotVars(slot.slot);
  } catch (err) {
    // Loading vars failing is the only hard prerequisite — every other step needs them.
    // Recovery: surface zero/null meta + metaFetchFailed flag so the wizard's risk-flag chip
    // makes the situation visible to the operator instead of looking like a clean slot.
    console.warn(`[branch-affinity] vars unavailable for ${slot.slot}: ${(err as Error).message}`);
    return { uncommittedCount: 0, uncommittedFiles: [], ctxPct: null, metaFetchFailed: true };
  }

  const provider = getRunnerStatusProvider(slot.runner);
  const [statusOutcome, ctxOutcome] = await Promise.allSettled([
    execOnSlot(vars, `git -C ${shellQuote(vars.remoteRepo)} status --porcelain 2>/dev/null`),
    (async (): Promise<number | null> => {
      if (!provider) return null;
      // First window of the slot's session is the worker pane in the dominant single-pane
      // case. Role-aware capture is not worth the extra round trips for a wizard preview.
      // Any case where ctxPct ends up null surfaces as the same `?` chip in the wizard:
      // (a) runner has no status provider (non-Claude — gated out before reaching here),
      // (b) the parser couldn't find `ctx:N%` in the captured pane (likely cause: alt-screen
      // buffer or scroll position), or (c) the SSH probe failed (which also flips
      // metaFetchFailed via the Promise.allSettled rejection above). The UI does not
      // distinguish unsupported vs fetch-failed at the chip level — the meta-fetch-failed
      // risk-flag chip is the operator-visible signal for SSH-down outages.
      const session = await resolveTmuxSession(slot.slot, vars);
      const target = await firstWindowTarget(vars, session);
      return provider.getContextPct(vars, target);
    })(),
  ]);

  let uncommittedCount = 0;
  let uncommittedFiles: string[] = [];
  let metaFetchFailed = false;
  if (statusOutcome.status === 'fulfilled') {
    const lines = statusOutcome.value.stdout
      .split('\n')
      .map((l) => l.replace(/^\s*[A-Z?!]{1,2}\s+/, '').trim())
      .filter(Boolean);
    uncommittedCount = lines.length;
    uncommittedFiles = lines.slice(0, NUDGE_FILE_LIST_LIMIT);
  } else {
    metaFetchFailed = true;
    console.warn(
      `[branch-affinity] git status skipped for ${slot.slot}: ${(statusOutcome.reason as Error).message}`,
    );
  }

  let ctxPct: number | null = null;
  if (ctxOutcome.status === 'fulfilled') {
    ctxPct = ctxOutcome.value;
  } else {
    metaFetchFailed = true;
    console.warn(
      `[branch-affinity] ctxPct skipped for ${slot.slot}: ${(ctxOutcome.reason as Error).message}`,
    );
  }

  return { uncommittedCount, uncommittedFiles, ctxPct, metaFetchFailed };
}

/**
 * Collect every busy slot whose loaded branch matches the requested PR. Nudge-capable rows
 * sort ahead of fresh-only rows, then by lowest ctxPct (room to absorb the nudge without
 * compact), lowest nudgeCount, and most recent dispatch (freshest context). Returns an empty
 * array when comparison-lane is requested — the caller is expected to filter that out, but
 * defend-in-depth.
 */
/**
 * Pure eligibility filter — extracted so it can be unit-tested without SSH / tmux / git IO.
 * Returns the slots that pass the lifecycle / agent / branch-match / lane gates with their
 * `prMatchKind` and runner-derived `canNudge` capability flag. The full collector layers
 * meta capture (uncommitted-files count, ctxPct) on top of this.
 */
export function selectBranchAffinityEligibleSlots(
  slots: SlotStatus[],
  project: string,
  ticketOrPr: string,
  options?: {
    familyId?: string | null;
    lane?: string | null;
    variant?: string | null;
    allowedSlots?: string[] | null;
    targetBranch?: string | null;
    requiredPrepareProfile?: string | null;
    activeRunIds?: ReadonlySet<string>;
  },
): Array<{ slot: SlotStatus; prMatchKind: 'pr-number' | 'branch-slug'; canNudge: boolean }> {
  if (options?.lane === 'comparison') return [];
  const allow =
    options?.allowedSlots && options.allowedSlots.length > 0 ? new Set(options.allowedSlots) : null;
  const ticketSlug = ticketOrPr.replace(/[#/]/g, '-').toLowerCase();
  const prMatch = ticketOrPr.match(/#(\d+)$/);
  const prNumber = prMatch ? parseInt(prMatch[1], 10) : null;
  const targetBranch = options?.targetBranch ?? null;

  const eligible: Array<{
    slot: SlotStatus;
    prMatchKind: 'pr-number' | 'branch-slug';
    canNudge: boolean;
  }> = [];
  for (const s of slots) {
    if (s.project !== project) continue;
    if (allow && !allow.has(s.slot)) continue;
    // Don't filter on `lifecycle === 'busy'` — that state only fires during prepare/dispatch
    // transitions. A worker actively running a task sits at `lifecycle: ready, agent: working`,
    // which is exactly the population we want to nudge into. Skip the no-go lifecycles
    // (manual / disabled / held) so we don't try to nudge a parked or human-driven slot.
    if (s.lifecycle === 'manual' || s.lifecycle === 'disabled' || s.lifecycle === 'held') continue;
    // A slot mid-release is being torn down; surfacing it as a nudge candidate
    // would claim over an in-flight teardown.
    if (s.phase === SLOT_PHASE_RELEASING) continue;
    if (s.agent !== 'working') continue;
    if (options?.activeRunIds && (!s.currentRunId || !options.activeRunIds.has(s.currentRunId))) {
      continue;
    }
    // Runner capability is per-action, not per-eligibility: codex / opencode slots still
    // surface as branch-matched candidates so the operator sees "this slot is on the PR's
    // branch" — but `canNudge` gates only the Nudge action; Fresh dispatch works for any
    // runner because it tears down + relaunches.
    if (!passesBranchAffinityLaneGate(s, options)) continue;
    if (companionResourceBlocker(s, options?.requiredPrepareProfile)) continue;
    const m = isBranchAffinityCandidateBranchMatch(s, ticketSlug, prNumber, targetBranch);
    if (!m.matched) continue;
    eligible.push({ slot: s, prMatchKind: m.kind, canNudge: runnerSupportsTmuxNudges(s.runner) });
  }
  return eligible;
}

export async function collectBranchAffinityNudgeCandidates(
  slots: SlotStatus[],
  project: string,
  ticketOrPr: string,
  options?: {
    familyId?: string | null;
    lane?: string | null;
    variant?: string | null;
    allowedSlots?: string[] | null;
    targetBranch?: string | null;
    requiredPrepareProfile?: string | null;
    activeRunIds?: ReadonlySet<string>;
  },
): Promise<BranchAffinityNudgeCandidate[]> {
  const eligibleEntries = selectBranchAffinityEligibleSlots(slots, project, ticketOrPr, options);
  if (eligibleEntries.length === 0) return [];

  const candidates = await Promise.all(
    eligibleEntries.map(
      async ({ slot, prMatchKind, canNudge }): Promise<BranchAffinityNudgeCandidate> => {
        const meta = await captureBranchAffinityCandidateMeta(slot);
        const primaryRole = slot.currentFlowType
          ? primaryRoleForFlow(slot.currentFlowType as FlowType)
          : null;
        const primaryContext = primaryRole
          ? slot.agentContexts?.find((c) => c.role === primaryRole)
          : slot.agentContexts?.[0];
        const nudgeCount = primaryContext?.nudgeCount ?? 0;
        const riskFlags = buildBranchAffinityRiskFlags(
          slot,
          options,
          nudgeCount,
          meta.ctxPct,
          prMatchKind,
          meta.uncommittedCount,
          meta.metaFetchFailed,
        );
        return {
          slot,
          uncommittedCount: meta.uncommittedCount,
          uncommittedFiles: meta.uncommittedFiles,
          nudgeCount,
          ctxPct: meta.ctxPct,
          prMatchKind,
          riskFlags,
          canNudge,
        };
      },
    ),
  );

  return candidates.sort((a, b) => {
    // Nudge-capable rows first — when both Nudge and Fresh are options the operator usually
    // wants the context-preserving Nudge, so surface those slots above Fresh-only ones.
    if (a.canNudge !== b.canNudge) return a.canNudge ? -1 : 1;
    const aCtx = a.ctxPct ?? -1;
    const bCtx = b.ctxPct ?? -1;
    if (aCtx !== bCtx) return aCtx - bCtx;
    if (a.nudgeCount !== b.nudgeCount) return a.nudgeCount - b.nudgeCount;
    const aTime = a.slot.dispatchedAt ? Date.parse(a.slot.dispatchedAt) : 0;
    const bTime = b.slot.dispatchedAt ? Date.parse(b.slot.dispatchedAt) : 0;
    return bTime - aTime;
  });
}

/** Convenience: top candidate from {@link collectBranchAffinityNudgeCandidates}. */
export async function findBranchAffinityNudgeCandidate(
  slots: SlotStatus[],
  project: string,
  ticketOrPr: string,
  options?: {
    familyId?: string | null;
    lane?: string | null;
    variant?: string | null;
    allowedSlots?: string[] | null;
    targetBranch?: string | null;
    requiredPrepareProfile?: string | null;
    activeRunIds?: ReadonlySet<string>;
  },
): Promise<BranchAffinityNudgeCandidate | null> {
  const all = await collectBranchAffinityNudgeCandidates(slots, project, ticketOrPr, options);
  return all[0] ?? null;
}

/**
 * Busy slots whose live branch should be refreshed before branch-affinity matching.
 *
 * Keep this wider than nudge capability: non-tmux runners still surface as Fresh-only
 * branch-affinity rows, so stale cached branch state would otherwise hide valid reuse options.
 */
export function selectBranchAffinityRefreshSlots(slots: SlotStatus[]): SlotStatus[] {
  return slots.filter(
    (s) =>
      s.agent === 'working' &&
      s.lifecycle !== 'manual' &&
      s.lifecycle !== 'disabled' &&
      s.lifecycle !== 'held',
  );
}

/**
 * Re-verify a slot is still nudge-eligible right before binding it.
 *
 * Two TOCTOU windows make this load-bearing:
 *   1. **Wizard click → run.create.** Operator sees the nudge row in `dispatch.candidates` and
 *      clicks Nudge. By the time `runCreate` reaches FIND_SLOT, the slot may have completed
 *      its prior task, recycled to a different branch, or had its runner killed. Without this
 *      check, the engine would happily route DISPATCH through `nudgeDispatch` against a stale
 *      target.
 *   2. **Gateway restart recovery.** `engineState.flags.nudgeReuse` survives restart, so a run
 *      mid-DISPATCH at restart will rehydrate with the flag set. The slot may have been
 *      stomped by another flow in the meantime.
 *
 * Returns `null` on success, or a human-readable rejection reason that the caller surfaces as
 * a thrown error / decision-card description.
 */
async function launchCommandForSlotCurrentRun(slot: SlotStatus | undefined): Promise<unknown> {
  if (!slot?.currentRunId) return undefined;
  const { getRun } = await import('../../runs/store.js');
  const run = getRun(slot.currentRunId);
  return run?.steps.find((step) => step.name === 'dispatch')?.outputs?.launchCommand;
}

export async function verifyBranchAffinityNudgeStillEligible(
  slot: SlotStatus | undefined,
  project: string,
  ticketOrPr: string,
  options?: {
    familyId?: string | null;
    lane?: string | null;
    variant?: string | null;
    allowedSlots?: string[] | null;
    targetBranch?: string | null;
    requiredPrepareProfile?: string | null;
    activeRunIds?: ReadonlySet<string>;
  },
): Promise<string | null> {
  if (!slot) return 'slot not found in fleet';
  // Re-run the same gate logic the collector uses, scoped to just this slot. If the slot
  // passes, the collector returns a 1-element array; otherwise we surface the most likely
  // user-readable reason inline rather than a generic empty-array failure.
  const matches = await collectBranchAffinityNudgeCandidates([slot], project, ticketOrPr, options);
  if (matches.length === 1) return null;
  if (slot.lifecycle === 'manual' || slot.lifecycle === 'disabled' || slot.lifecycle === 'held')
    return `slot ${slot.slot} is no longer dispatchable (lifecycle=${slot.lifecycle})`;
  if (slot.agent !== 'working')
    return `slot ${slot.slot} has no active run to nudge (agent=${slot.agent}) — use Fresh dispatch instead`;
  const resourceBlocker = companionResourceBlocker(slot, options?.requiredPrepareProfile);
  if (resourceBlocker) return resourceBlocker;
  const launchCommand = await launchCommandForSlotCurrentRun(slot);
  if (!runnerSupportsTmuxNudgesForLaunch(slot.runner, launchCommand)) {
    return `slot ${slot.slot} runner '${slot.runner ?? 'unknown'}' launch mode does not support tmux nudges`;
  }
  return `slot ${slot.slot} no longer matches branch / PR for ${ticketOrPr} (current branch=${slot.branch || 'none'})`;
}

// ─── Live branch refresh for accurate scoring ───

/** Pool misconfiguration surfaced from refreshBranches. Re-thrown out of the
 *  per-slot catch so dispatch.candidates fails visibly instead of silently
 *  presenting stale branch data while the operator chases a phantom bug.
 *
 *  `slotIds` is the structured list of affected slots — the refreshBranches
 *  aggregate may collect more than one. `slotId` is preserved as the first
 *  element so consumers can keep matching against a singular value where it
 *  makes sense (single-slot throws produce a one-element list). */
export class PoolConfigError extends Error {
  public readonly slotIds: ReadonlyArray<string>;
  public readonly slotId: string;
  constructor(slotIds: string | ReadonlyArray<string>, message: string) {
    super(message);
    this.name = 'PoolConfigError';
    this.slotIds = typeof slotIds === 'string' ? [slotIds] : [...slotIds];
    this.slotId = this.slotIds[0] ?? '';
  }
}

export type RefreshSlotAction = 'refresh' | 'skip-disconnected';

/** Pure classifier extracted from refreshBranches so the skip / fail-loud
 *  decision tree is testable without mocking node-rpc, exec, or the FS.
 *  Throws PoolConfigError for empty machine (pool config is broken). Returns
 *  'skip-disconnected' for remote slots whose node agent is not connected
 *  (avoids the 15s waitForNode hang per node-rpc.ts). Returns 'refresh'
 *  otherwise. */
export function classifyRefreshSlotAction(
  slotId: string,
  vars: { host: string; machine: string },
  getNodeFn: (machine: string) => unknown,
): RefreshSlotAction {
  if (!vars.machine) {
    throw new PoolConfigError(slotId, `${slotId} has empty vars.machine — fix pool config`);
  }
  if (!isLocal(vars.host, vars.machine) && !getNodeFn(vars.machine)) {
    return 'skip-disconnected';
  }
  return 'refresh';
}

export async function refreshBranches(
  slots: SlotStatus[],
  options: { force?: boolean; now?: number } = {},
): Promise<void> {
  const errors: PoolConfigError[] = [];
  const now = options.now ?? Date.now();
  const pending = options.force
    ? slots
    : slotsNeedingBranchRefresh(slots, branchRefreshAt, now, BRANCH_REFRESH_TTL_MS);
  if (pending.length === 0) return;
  await mapWithConcurrency(pending, BRANCH_REFRESH_CONCURRENCY, async (s) => {
    try {
      const vars = await loadSlotVars(s.slot);
      const action = classifyRefreshSlotAction(s.slot, vars, getNode);
      if (action === 'skip-disconnected') return;
      // Refresh the COMMIT alongside the branch. Dispatch's detached-HEAD
      // exception compares the slot's head against a park's recorded tip, and a
      // branch-only refresh left a stale commit in the row — so unrelated
      // detached work could keep answering with the preserved SHA.
      const r = await execOnSlot(vars, gitHeadProbeCommand(vars.remoteRepo), {
        timeout: BRANCH_REFRESH_TIMEOUT_MS,
      });
      const probe = parseGitHeadProbe(r.stdout);
      const update = slotHeadRefreshUpdate(s, probe);
      if (update) {
        s.branch = update.branch;
        if (update.head_sha) s.headSha = update.head_sha;
        else delete s.headSha;
        await updateSlotStatus(s.slot, update);
      }
      branchRefreshAt.set(s.slot, now);
    } catch (err) {
      if (err instanceof PoolConfigError) {
        // Aggregate so dispatch.candidates surfaces the actionable pool error
        // without losing the other slots' refresh results.
        errors.push(err);
        return;
      }
      // Transient per-slot failure (SSH glitch, ENOENT during reload). Warn
      // and proceed — stale branch is preferred over a fully empty picker.
      console.warn(`[refresh-branches] ${s.slot} skipped: ${(err as Error).message}`);
    }
  });
  if (errors.length > 0) {
    throw new PoolConfigError(
      errors.flatMap((e) => e.slotIds),
      `pool config error: ${errors.map((e) => e.message).join('; ')}`,
    );
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

// ─── Dispatch Candidates ───

/**
 * Same validation FIND_SLOT applies at dispatch time, surfaced on FREE candidate rows
 * so the wizard can disable them up front instead of advertising a pick that fails
 * after queueing. Nudge rows are excluded: they are busy by definition (the base
 * validator would reject every one of them) and already pass their own eligibility
 * pipeline (branch match + companion resources) before getting here. `fleetSlots`
 * must be the FULL fleet, matching FIND_SLOT — a machine-filtered or disabled
 * worktree can still own the target branch.
 */
export function candidateIneligibilityReason(
  slot: SlotStatus,
  fleetSlots: readonly SlotStatus[],
  options: {
    isNudgeRow: boolean;
    replaceableWarm?: boolean;
    targetBranch?: string | null;
    requiredPrepareProfile?: string | null;
  },
): string | null {
  if (options.isNudgeRow) return null;
  if (!isFreeSlot(slot) && !options.replaceableWarm) return null;
  return validateSlotForDispatch(slot, fleetSlots, {
    targetBranch: options.targetBranch,
    requiredPrepareProfile: options.requiredPrepareProfile,
    allowWorking: options.replaceableWarm,
  });
}

export async function resolveDispatchScoringByProject(
  params: DispatchCandidatesParams,
  fleetSlots: SlotStatus[],
  projectSlots: SlotStatus[],
): Promise<Map<string, { targetBranch?: string; familyId?: string }>> {
  const projects = params.project
    ? [params.project]
    : [...new Set(projectSlots.map((slot) => slot.project))];
  const entries = await Promise.all(
    projects.map(async (project) => {
      const targetBranch = await resolveDispatchTargetBranch(
        { ...params, project },
        {
          fleetSlots,
          projectSlots: projectSlots.filter((slot) => slot.project === project),
          logPrefix: 'dispatch.candidates',
        },
      );
      const family = resolveDispatchFamilyContext({ ...params, project, targetBranch });
      return [project, { targetBranch, familyId: family.familyId }] as const;
    }),
  );
  return new Map(entries);
}

export async function dispatchCandidates(
  params: DispatchCandidatesParams,
): Promise<DispatchCandidatesResult> {
  const [fleet, projectConfigList] = await Promise.all([loadFleetStatus(), loadProjectConfigs()]);
  const projectConfigs = projectConfigsFromProjects(projectConfigList);
  const projectSlots = selectDispatchCandidateSlots(fleet.slots, params);
  const refreshOpts = { force: params.forceRefresh === true };
  // Live-check branches for free slots so the UI shows accurate data.
  // TTL skips hosts already probed; forceRefresh (UI Refresh) bypasses it.
  const freeSlots = projectSlots.filter(isFreeSlot);
  if (freeSlots.length > 0) await refreshBranches(freeSlots, refreshOpts);

  const isPrFlow = params.flowType === 'pr-complete' || params.flowType === 'review-pr';
  const scoringByProject = await resolveDispatchScoringByProject(params, fleet.slots, projectSlots);
  // Explicit prepare only — profile-fit is advisory on dispatch.preview, not candidates.
  const requiredPrepareProfile = params.prepareProfile || null;
  const allRuns = getAllRuns();
  const activeSlotIds = activeRunSlotIds(allRuns);
  const activeOwnerIds = activeRunIds(allRuns);
  // ADR-054: a slot whose detached HEAD is a park's preserved workspace is
  // dispatchable, so it must not carry the stale-branch penalty here.
  const parkPreserved = parkPreservedSlotIds(allRuns);

  // PR-bound calls ALSO get the busy-slot branch-affinity nudge slice so the wizard can
  // surface "REUSE WORKER" rows. Refresh busy-slot branches first — without this, a slot
  // whose worker checked out the PR branch since last status flush is invisible to the
  // match logic. Production-lane and validation-lane only; comparison-lane suppression
  // is implemented inside `collectBranchAffinityNudgeCandidates` per ADR-024 §7.
  //
  // `loadFleetStatus()` returns the cached fleet by reference — `refreshBranches` mutates
  // each slot's `branch` field in place AND persists via `updateSlotStatus`. This is the
  // existing convention (the free-slot refresh above does the same). It's deliberate:
  // the cached fleet IS the source of truth for the next reader, so we want the live
  // branch to land there. Callers that need a guaranteed-fresh snapshot pass
  // `forceRefresh: true` to `loadFleetStatus`.
  let nudgeMetaBySlot: Map<string, BranchAffinityNudgeCandidate> = new Map();
  const nudgeProjects = [...scoringByProject.entries()].filter(
    ([, scoring]) => scoring.targetBranch,
  );
  if (isPrFlow && params.ticketOrPr && nudgeProjects.length > 0) {
    const busyMatching = selectBranchAffinityRefreshSlots(projectSlots);
    if (busyMatching.length > 0) await refreshBranches(busyMatching, refreshOpts);
    const candidatesList = (
      await Promise.all(
        nudgeProjects.map(([project, scoring]) =>
          collectBranchAffinityNudgeCandidates(fleet.slots, project, params.ticketOrPr!, {
            familyId: scoring.familyId ?? null,
            lane: params.lane ?? null,
            variant: params.variant ?? null,
            targetBranch: scoring.targetBranch ?? null,
            requiredPrepareProfile,
            activeRunIds: activeOwnerIds,
          }),
        ),
      )
    ).flat();
    nudgeMetaBySlot = new Map(candidatesList.map((c) => [c.slot.slot, c]));
  }

  // One deduplicated pressure capture for every machine in this request; each
  // slot row on a machine carries the same backend-owned decision. Rejected
  // machines disable their free rows the same way FIND_SLOT will refuse them.
  const pressureDecisions = await capturePressureAdmissionDecisions(
    [...new Set(projectSlots.map((s) => s.machine))],
    // Candidate rows stay on the in-memory admission path. Causes come from
    // the last explicit resource snapshot cache; a miss is shown as degraded
    // attribution instead of starting tmux/resource work during dispatch.
    {},
  );

  const candidates = projectSlots
    .map((s) => {
      const scoring = scoringByProject.get(s.project) ?? {};
      const nudge = nudgeMetaBySlot.get(s.slot);
      const pressureAdmission = pressureDecisions.get(s.machine);
      const replaceableWarm = isReplaceableWarmSlot(s, activeSlotIds, activeOwnerIds);
      const baseIneligibleReason = candidateIneligibilityReason(s, fleet.slots, {
        isNudgeRow: Boolean(nudge),
        replaceableWarm,
        targetBranch: scoring.targetBranch,
        requiredPrepareProfile,
      });
      // A pressure rejection gates every dispatchable row, fresh AND nudge.
      // a nudge still delivers a new task to the loaded machine. The wizard
      // renders its override affordance from ineligibilitySource +
      // pressureAdmission.overridable on the disabled row (preserving the
      // nudge intent); the reason text is display-only.
      const pressureBlocksDispatch =
        !baseIneligibleReason &&
        (Boolean(nudge) || isFreeSlot(s) || replaceableWarm) &&
        pressureAdmission?.outcome === 'rejected';
      const ineligibleReason =
        baseIneligibleReason ??
        (pressureBlocksDispatch && pressureAdmission?.outcome === 'rejected'
          ? formatPressureRejection(pressureAdmission)
          : null);
      const ineligibilitySource: 'slot' | 'pressure' | null = baseIneligibleReason
        ? 'slot'
        : pressureBlocksDispatch
          ? 'pressure'
          : null;
      return {
        slotId: s.slot,
        project: s.project,
        score:
          isFreeSlot(s) || replaceableWarm
            ? slotScore(s, scoring.targetBranch, {
                familyId: scoring.familyId,
                projectConfigs,
                parkPreservedSlotIds: parkPreserved,
              })
            : 999,
        cdpLive: isCdpLive(s.health.cdp),
        branch: s.branch || '',
        lifecycle: s.lifecycle,
        onMain: !isDispatchStaleBranch(s, projectConfigs, parkPreserved),
        hostLoad: s.hostLoad,
        free: isFreeSlot(s),
        ...(replaceableWarm ? { replaceableWarm: true } : {}),
        familyAffinity: Boolean(scoring.familyId && s.currentFamilyId === scoring.familyId),
        ...(ineligibleReason ? { ineligibleReason } : {}),
        ...(ineligibilitySource ? { ineligibilitySource } : {}),
        ...(pressureAdmission ? { pressureAdmission } : {}),
        ...(nudge
          ? {
              nudgeEligible: true,
              nudgeMeta: {
                uncommittedCount: nudge.uncommittedCount,
                uncommittedFiles: nudge.uncommittedFiles,
                nudgeCount: nudge.nudgeCount,
                ctxPct: nudge.ctxPct,
                prMatchKind: nudge.prMatchKind,
                riskFlags: nudge.riskFlags,
                canNudge: nudge.canNudge,
              },
            }
          : {}),
      };
    })
    .sort((a, b) => {
      // Nudge-eligible (busy branch-matched) first — they preserve loaded PR context, which
      // beats any free slot's prepare cost. Then free slots ordered by score; stale/non-free
      // non-eligible last.
      if (!!a.nudgeEligible !== !!b.nudgeEligible) return a.nudgeEligible ? -1 : 1;
      if (a.free !== b.free) return a.free ? -1 : 1;
      if (!!a.replaceableWarm !== !!b.replaceableWarm) return a.replaceableWarm ? -1 : 1;
      return a.score - b.score;
    });
  return { candidates };
}

// ─── Dispatch Preview ───

export async function dispatchPreview(
  params: DispatchPreviewParams,
  internalOptions: {
    /**
     * Gateway-internal only (never a wire param): principal persisted in a
     * run's override audit, for delayed run-engine previews. Direct RPC calls
     * must leave this unset so the session originator is the only authority.
     */
    overridePrincipalId?: string;
  } = {},
): Promise<DispatchPreviewResult> {
  await normalizeRunCreateMode(params, await loadProjectConfig(params.project));
  const fleet = await loadFleetStatus(true);
  const projectSlots = fleet.slots.filter(
    (s) => s.project === params.project && s.lifecycle !== 'disabled',
  );
  const resolvedTargetBranch = await resolveDispatchTargetBranch(params, {
    fleetSlots: fleet.slots,
    projectSlots,
    logPrefix: 'dispatch.preview',
  });
  const enriched = { ...params, targetBranch: resolvedTargetBranch };
  const projectConfigList = await loadProjectConfigs();
  const projectConfigs = projectConfigsFromProjects(projectConfigList);
  const previewRun = {
    id: 'dispatch-preview',
    familyId: 'dispatch-preview',
    lane: 'production',
    flowType: params.flowType as FlowType,
    status: 'created',
    project: params.project,
    ticketOrPr: params.ticketOrPr,
    slotId: params.slotId ?? null,
    branch: null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    prepareProfile: params.prepareProfile,
    app: params.app,
  } as Run;
  let ticketData: Awaited<ReturnType<typeof fetchTicketData>> | null = null;
  try {
    ticketData = await fetchTicketData(previewRun);
  } catch {
    // Ticket metadata is optional for preview. Without it, explicit app/profile inputs
    // still drive resource filtering and profile-fit suggestions are simply omitted.
  }
  // Explicit prepare only for resource eligibility; profileFit is attached later as non-binding advisory.
  const requiredPrepareProfile = params.prepareProfile || null;
  // One deduplicated pressure capture for every machine this preview can
  // touch; the same captured evidence drives auto-selection exclusion and the
  // explicit-slot decision. Override principal: run-engine passes the audit
  // recorded at run.create; direct RPC callers resolve the session originator.
  const explicitSlotMachine = params.slotId
    ? fleet.slots.find((s) => s.slot === params.slotId)?.machine
    : undefined;
  const pressureDecisions = await capturePressureAdmissionDecisions(
    [
      ...new Set([
        ...projectSlots.map((s) => s.machine),
        ...(explicitSlotMachine ? [explicitSlotMachine] : []),
      ]),
    ],
    {
      ...(params.pressureOverride
        ? {
            // Wire params never carry the audit principal. Extra JSON fields
            // must not be able to spoof it. Only the internal run-engine path
            // may supply a persisted audit principal.
            override: {
              machine: params.pressureOverride.machine,
              pressureGeneration: params.pressureOverride.pressureGeneration,
              reason: params.pressureOverride.reason,
            },
            principalId: internalOptions.overridePrincipalId ?? sessionPrincipalId(),
          }
        : {}),
    },
  );
  const allRuns = getAllRuns();
  const activeSlotIds = activeRunSlotIds(allRuns);
  const activeOwnerIds = activeRunIds(allRuns);
  const replaceableWarmSlotIds = new Set(
    projectSlots
      .filter(
        (slot) =>
          params.freshReuse &&
          slot.slot === params.slotId &&
          isReplaceableWarmSlot(slot, activeSlotIds, activeOwnerIds),
      )
      .map((slot) => slot.slot),
  );
  const result = resolveDispatchPreviewFromFleet(
    { ...enriched, ...resolveDispatchFamilyContext(enriched) },
    fleet.slots,
    projectConfigs,
    {
      requiredPrepareProfile,
      pressureDecisions,
      replaceableWarmSlotIds,
      // ADR-054: the same exception `dispatchCandidates` applies. Every
      // ranking path that has run context passes it, so a park-preserved slot
      // cannot be stale to one picker and idle to another.
      parkPreservedSlotIds: parkPreservedSlotIds(getAllRuns()),
      ...(params.pressureOverride
        ? { pressureOverrideMachine: params.pressureOverride.machine }
        : {}),
    },
  );
  const slotInfo = fleet.slots.find((s) => s.slot === result.preview.slotId);
  const configuredProject = projectConfigList.find(
    (project) => project.name === params.project,
  )?.executionTemplates;
  if (slotInfo && configuredProject) {
    const projectVars = await loadProjectVars(params.project);
    if (!projectUsesExecutionTemplateCatalog(projectVars)) {
      throw new Error(
        `Project "${params.project}" advertises execution templates but its validated configuration does not contain them.`,
      );
    }
    if (!params.mode) {
      throw new Error('Configured execution-template preview requires an explicit run mode.');
    }
    const slotVars = await loadSlotVars(slotInfo.slot);
    const selected = resolveConfiguredExecutionTemplateForSlot(projectVars, {
      flow: params.flowType,
      platform: slotVars.platform,
      runMode: params.mode,
      ...(params.domain ? { explicitDomain: params.domain } : {}),
      ...(slotVars.domain ? { slotDomain: slotVars.domain } : {}),
      ...(params.executionTemplateId ? { explicitId: params.executionTemplateId } : {}),
    });
    result.preview.executionTemplate = selected.reference;
    if (selected.effectiveDomain) result.preview.domain = selected.effectiveDomain;
    else delete result.preview.domain;
  }
  const profileFit = detectProfileFit(previewRun, ticketData, {
    prepareProfile: params.prepareProfile,
    app: params.app,
    slotPlatform: slotInfo?.platform ?? null,
  });
  if (profileFit) {
    result.preview.profileFit = profileFit;
  }
  return result;
}

export function resolveDispatchPreviewFromFleet(
  params: DispatchPreviewParams,
  slots: SlotStatus[],
  projectConfigs?: ReturnType<typeof projectConfigsFromProjects>,
  options?: {
    requiredPrepareProfile?: string | null;
    /** One captured pressure decision per machine (same evidence for every
     * slot on the machine). Automatic selection excludes rejected machines;
     * an explicit slot returns the same rejection on the result. */
    pressureDecisions?: ReadonlyMap<string, PressureAdmissionDecision>;
    replaceableWarmSlotIds?: ReadonlySet<string>;
    /** Machine the caller's override names, if any. A rejected SELECTED
     * machine that differs from it reports PRESSURE_OVERRIDE_MISMATCH; other
     * machines keep their own base decision. */
    pressureOverrideMachine?: string;
    /** Slots whose detached HEAD a park record preserves. Passed in rather than
     * derived: this function is pure over the slots it is given. */
    parkPreservedSlotIds?: ReadonlyMap<string, ParkPreservedWorkspace[]>;
  },
): DispatchPreviewResult {
  let slotInfo: SlotStatus;
  const requiredPrepareProfile = options?.requiredPrepareProfile ?? params.prepareProfile ?? null;
  const pressureDecisions = options?.pressureDecisions;
  const pressureRejectedMachines = new Set(
    [...(pressureDecisions ?? [])]
      .filter(([, decision]) => isPressureAdmissionRejected(decision))
      .map(([machine]) => machine),
  );
  const withPressure = (result: DispatchPreviewResult, machine: string): DispatchPreviewResult => {
    let decision = pressureDecisions?.get(machine);
    // An override naming a DIFFERENT machine than the selected one is a
    // misdirected operator intent: reject at the boundary regardless of the
    // selected machine's own state (green included). Only the disabled kill
    // switch, the deliberate global bypass, ignores it.
    if (
      decision &&
      options?.pressureOverrideMachine &&
      options.pressureOverrideMachine !== machine &&
      !(decision.outcome === 'admitted' && decision.state === 'disabled')
    ) {
      decision = {
        outcome: 'rejected',
        machine,
        state: isPressureAdmissionRejected(decision) ? decision.state : 'stale',
        code: 'PRESSURE_OVERRIDE_MISMATCH',
        reason: `Override is bound to machine ${options.pressureOverrideMachine} but the dispatch selected ${machine}; drop the override or submit one for this machine.`,
        causes: isPressureAdmissionRejected(decision) ? decision.causes : [],
        evidence: decision.evidence,
        overridable: isPressureAdmissionRejected(decision) ? decision.overridable : false,
      };
    }
    return decision ? { ...result, pressureAdmission: decision } : result;
  };

  if (params.slotId) {
    const found = slots.find((s) => s.slot === params.slotId);
    if (!found) throw new Error(`Slot ${params.slotId} not found`);
    const err = validateSlotForDispatch(found, slots, {
      targetBranch: params.targetBranch,
      requiredPrepareProfile,
      allowWorking: options?.replaceableWarmSlotIds?.has(found.slot),
    });
    if (err) throw new Error(`Slot ${params.slotId}: ${err}`);
    slotInfo = found;
  } else {
    // PR affinity: for pr-complete and review-pr, prefer slot already on this PR's branch
    if (params.flowType === 'pr-complete' || params.flowType === 'review-pr') {
      const affinitySlot = findAffinitySlot(slots, params.project, params.ticketOrPr, {
        familyId: params.familyId ?? null,
        lane: params.lane ?? null,
        variant: params.variant ?? null,
        allowedSlots: params.allowedSlots ?? null,
      });
      if (
        affinitySlot &&
        !pressureRejectedMachines.has(affinitySlot.machine) &&
        !validateSlotForDispatch(affinitySlot, slots, {
          targetBranch: params.targetBranch,
          requiredPrepareProfile,
        })
      ) {
        console.log(
          `[dispatch] ${params.flowType} affinity: reusing slot ${affinitySlot.slot} (lifecycle=${affinitySlot.lifecycle}, branch=${affinitySlot.branch})`,
        );
        slotInfo = affinitySlot;
        return withPressure(
          {
            preview: {
              slotId: slotInfo.slot,
              project: params.project,
              flowType: params.flowType as FlowType,
              branch: slotInfo.branch || null,
              runner: resolvePreviewRunner(slotInfo),
              model: resolvePreviewModel(slotInfo),
              taskId: params.ticketOrPr,
              ...(params.domain ? { domain: params.domain } : {}),
            },
          },
          slotInfo.machine,
        );
      }
    }

    const best = findBestSlot(slots, params.project, {
      allowedSlots: params.allowedSlots,
      targetBranch: params.targetBranch,
      familyId: params.familyId,
      lane: params.lane,
      variant: params.variant,
      requiredPrepareProfile,
      projectConfigs,
      pressureRejectedMachines,
      parkPreservedSlotIds: options?.parkPreservedSlotIds,
    });
    if (!best) {
      const allow =
        params.allowedSlots && params.allowedSlots.length > 0 ? new Set(params.allowedSlots) : null;
      const projectSlots = slots.filter(
        (s) => s.project === params.project && (!allow || allow.has(s.slot)),
      );
      if (projectSlots.length === 0) {
        const filterHint = allow ? ` within allowed slots (${[...allow].join(',')})` : '';
        throw new Error(`No slots found for project ${params.project}${filterHint}`);
      }
      if (prepareProfileNeedsCompanionResource(requiredPrepareProfile)) {
        const freeSlots = projectSlots.filter(isFreeSlot);
        const freeSlotsMissingCompanionResource = freeSlots.every((s) =>
          companionResourceBlocker(s, requiredPrepareProfile),
        );
        const eligibleFreeSlots = freeSlots.filter(
          (s) =>
            !validateSlotForDispatch(s, slots, {
              targetBranch: params.targetBranch,
              requiredPrepareProfile,
            }),
        );
        if (
          freeSlots.length > 0 &&
          eligibleFreeSlots.length === 0 &&
          freeSlotsMissingCompanionResource
        ) {
          throw new Error(
            `No free slots for project ${params.project} have resources required by prepare profile ${requiredPrepareProfile}`,
          );
        }
      }
      const reasons = projectSlots.map((s) => {
        const pressureDecision = pressureDecisions?.get(s.machine);
        const blocker =
          pressureDecision && isPressureAdmissionRejected(pressureDecision)
            ? formatPressureRejection(pressureDecision)
            : (validateSlotForDispatch(s, slots, {
                targetBranch: params.targetBranch,
                requiredPrepareProfile,
              }) ?? 'unknown blocker');
        return `${s.slot}: ${blocker} (lifecycle=${s.lifecycle}, phase=${s.phase}, agent=${s.agent})`;
      });
      throw new Error(
        `No dispatchable slots for project ${params.project}:\n${reasons.join('\n')}`,
      );
    }
    slotInfo = best;
  }

  return withPressure(
    {
      preview: {
        slotId: slotInfo.slot,
        project: params.project,
        flowType: params.flowType as FlowType,
        branch: null,
        runner: resolvePreviewRunner(slotInfo),
        model: resolvePreviewModel(slotInfo),
        taskId: params.ticketOrPr,
        ...(params.domain ? { domain: params.domain } : {}),
      },
    },
    slotInfo.machine,
  );
}

/** Authenticated origin for a direct RPC override; 'system' only for trusted
 * in-process callers that never enter through an ingress. */
function sessionPrincipalId(): string {
  const originator = currentSessionOriginator();
  return originator.kind === 'principal' ? originator.principalId : 'system';
}

export function resolvePreviewRunner(slotInfo: Pick<SlotStatus, 'runner'>): string {
  return normalizeRunner(slotInfo.runner || 'claude');
}

export function resolvePreviewModel(slotInfo: Pick<SlotStatus, 'runner' | 'model'>): string {
  const slotModel = slotInfo.model && slotInfo.model !== 'unknown' ? slotInfo.model : null;
  const runner = resolvePreviewRunner(slotInfo);
  return slotModel || runnerDefaultModel(runner) || DEFAULT_CLAUDE_MODEL;
}
