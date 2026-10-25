import { randomUUID } from 'node:crypto';

import {
  DEFAULT_BRANCH,
  sameSlotWorkspace,
  type SlotRecovery,
  slotRecoveryEligibility,
  type SlotRecoveryPhase,
  type SlotRecoveryRefusal,
  type SlotRefreshParams,
  type SlotRefreshResult,
  type SlotWorkspaceIdentity,
  slotWorkspaceIdentity,
} from '@farmslot/protocol';

import {
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  markSlotStatusIf,
  readSlotRow,
  resetSlotIf,
  slotReleasingFenceFields,
  updateSlotStatusIf,
} from '../../core/index.js';
import { assertNoNativeWorkerRecovery } from '../../core/native-worker-exclusion.js';
import { excludeSlotScaffolding } from '../../fleet/slot-scaffolding.js';
import { loadFleetStatus } from '../../fleet/state.js';
import {
  beginTerminalTeardown,
  endTerminalTeardown,
} from '../../run-engine/terminal-teardown-registry.js';
import { checkFixtures } from '../fleet.js';

import { slotFixtureRefresh } from './fixtures.js';
import { assertReleaseRunGuards, slotRelease } from './release.js';
import { activePrepareSlots, type EventEmitter } from './shared.js';
import {
  assertSlotNotOperatorRoot,
  detectLinkedWorktree,
  isSlotIdleBranch,
  resetSlotRepoToIdle,
  resolveSlotTrackingBranchFromProject,
} from './slot-tracking.js';
import {
  inspectSlotWorkspace,
  invalidateSlotWorkspaceObservations,
  recoveryFromRow,
  workspaceProtectedReason,
} from './workspace.js';

const owner = (row: Readonly<Record<string, unknown>>, field: string): string | null =>
  typeof row[field] === 'string' && row[field] ? String(row[field]) : null;
const RECOVERY_PROBE_TIMEOUT_MS = 120_000;
function identityOwnsRow(
  row: Readonly<Record<string, unknown>>,
  expected: SlotWorkspaceIdentity,
): boolean {
  return (
    (Number(row.slot_epoch) || 0) === expected.epoch &&
    owner(row, 'current_run_id') === expected.currentRunId &&
    owner(row, 'cleanup_run_id') === expected.cleanupRunId &&
    owner(row, 'handoff_run_id') === expected.handoffRunId &&
    (recoveryFromRow(row)?.id ?? null) === expected.recoveryId
  );
}

export async function recoverSlotWorkspace(
  params: SlotRefreshParams,
  emit: EventEmitter,
  signal?: AbortSignal,
): Promise<SlotRefreshResult> {
  const requestId = params.requestId ?? `refresh-${randomUUID()}`;
  const started = Date.now();
  const output = (name: string, detail: string) => {
    emit('slot.refresh.step', { requestId, slotId: params.slotId, name, detail });
    emit('script.output', {
      requestId,
      stream: 'stdout',
      data: `[${name}] ${detail}\n`,
      timestamp: Date.now(),
    });
  };
  const finish = (result: SlotRefreshResult) => {
    emit('script.complete', {
      requestId,
      exitCode: result.refreshed ? 0 : 1,
      duration: Date.now() - started,
      ...(result.detail ? { error: result.detail } : {}),
    });
    return result;
  };
  const refuse = (reason: SlotRecoveryRefusal, detail: string, branch = ''): SlotRefreshResult =>
    finish({ requestId, refreshed: false, reason, detail, branch, advanced: false });
  if (!params.expectedWorkspace)
    return refuse('identity-changed', 'Inspect the workspace before releasing');
  if (activePrepareSlots.has(params.slotId))
    return refuse('protected', 'Slot is preparing or refreshing');
  assertNoNativeWorkerRecovery(params.slotId);
  activePrepareSlots.add(params.slotId);
  beginTerminalTeardown(params.slotId);
  let recovery: SlotRecovery | undefined;
  let claimed = false;
  let authorized: SlotWorkspaceIdentity = params.expectedWorkspace;
  try {
    const vars = await loadSlotVars(params.slotId);
    await assertSlotNotOperatorRoot(vars, 'refresh');
    const project = await loadProjectVars(vars.projectName);
    const defaultBranch = getProjectField(project.projectJson, 'default_branch') || DEFAULT_BRANCH;
    let workspace = await inspectSlotWorkspace(params.slotId, {
      timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
    });
    if (!sameSlotWorkspace(workspace, params.expectedWorkspace))
      return refuse(
        'identity-changed',
        'Workspace changed; inspect and confirm again',
        workspace.branch,
      );
    const fleet = await loadFleetStatus(true);
    const status = fleet.slots.find((slot) => slot.slot === params.slotId);
    let keepWarm = status?.warm ?? false;
    const eligibility = slotRecoveryEligibility(status ? { ...status, workspace } : undefined);
    if (!eligibility.allowed)
      return refuse(
        eligibility.reason ?? 'protected',
        eligibility.detail ?? 'Slot is protected',
        workspace.branch,
      );
    if (eligibility.confirmationRequired && params.mode !== 'force')
      return refuse(
        eligibility.reason ?? 'dirty',
        'Confirm discarding the current local work',
        workspace.branch,
      );
    const existing = workspace.recovery;
    recovery = {
      id: existing?.id ?? randomUUID(),
      identity: slotWorkspaceIdentity(workspace),
      completed:
        existing && sameSlotWorkspace(existing.identity, workspace)
          ? existing.completed
          : existing?.completed.includes('cleanup')
            ? ['cleanup']
            : [],
      phase: 'inspect',
    };
    const marker = recovery;
    const entryEpoch = workspace.epoch;
    let guardRefusal: string | undefined;
    const mark = await markSlotStatusIf(
      params.slotId,
      (row) => {
        if (
          !identityOwnsRow(row, workspace) ||
          row.phase === 'releasing' ||
          row.lifecycle === 'manual' ||
          row.lifecycle === 'disabled' ||
          row.agent === 'working'
        )
          return false;
        // A guard refusal is a typed no-op; no fence or teardown was acquired.
        try {
          assertReleaseRunGuards({ slotId: params.slotId }, workspace.currentRunId);
        } catch (error) {
          guardRefusal = error instanceof Error ? error.message : String(error);
          return false;
        }
        return (
          row.lifecycle === 'ready' ||
          (row.lifecycle === 'held' && !!existing) ||
          (!!workspace.terminalOwner &&
            ['busy', 'held'].includes(String(row.lifecycle)) &&
            row.phase !== 'occupied' &&
            !row.held_reason)
        );
      },
      { ...slotReleasingFenceFields(), workspace_recovery: marker },
    );
    if (!mark.applied)
      return refuse(
        guardRefusal ? 'protected' : 'identity-changed',
        guardRefusal ?? 'Slot ownership or state changed',
        workspace.branch,
      );
    claimed = true;
    authorized = { ...slotWorkspaceIdentity(workspace), recoveryId: marker.id };
    const ownsFence = (row: Readonly<Record<string, unknown>>): boolean =>
      (Number(row.slot_epoch) || 0) === entryEpoch &&
      recoveryFromRow(row)?.id === marker.id &&
      row.phase === 'releasing';
    const assertFence = async () => {
      if (signal?.aborted) throw new Error('Recovery cancelled; retry to finish verification');
      const row = await readSlotRow(params.slotId);
      if (!row || !ownsFence(row) || !identityOwnsRow(row, authorized))
        throw new Error('Recovery ownership changed');
      const protectedReason = await workspaceProtectedReason(params.slotId, row);
      if (protectedReason) throw new Error(protectedReason);
      assertReleaseRunGuards({ slotId: params.slotId }, authorized.currentRunId);
    };
    const save = async (phase: SlotRecoveryPhase, complete?: SlotRecoveryPhase) => {
      if (signal?.aborted) throw new Error('Recovery cancelled; retry to finish verification');
      marker.phase = phase;
      if (complete && !marker.completed.includes(complete))
        marker.completed = [...marker.completed, complete];
      marker.identity = authorized;
      if (
        !(await updateSlotStatusIf(params.slotId, ownsFence, {
          workspace_recovery: { ...marker },
          warm: keepWarm,
        }))
      )
        throw new Error('Recovery fence changed');
      output(phase, complete ? `${complete} verified` : phase);
    };
    const advanceIdentity = async () => {
      const current = await inspectSlotWorkspace(params.slotId, {
        network: false,
        timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
      });
      if (
        current.epoch !== entryEpoch ||
        current.recoveryId !== marker.id ||
        current.currentRunId ||
        current.cleanupRunId ||
        current.handoffRunId
      )
        throw new Error('Recovery ownership changed during phase');
      authorized = slotWorkspaceIdentity(current);
    };
    const verifyWork = async () => {
      await assertFence();
      const current = await inspectSlotWorkspace(params.slotId, {
        network: false,
        timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
      });
      if (!sameSlotWorkspace(current, authorized))
        throw new Error('Workspace changed; renew discard confirmation');
    };
    await save('inspect');
    workspace = await inspectSlotWorkspace(params.slotId, {
      fetch: true,
      timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
    });
    if (!sameSlotWorkspace(workspace, authorized))
      throw new Error('Workspace changed during publication verification');
    if (workspace.publication === 'unknown')
      throw new Error(workspace.error ?? 'Publication is unknown');
    if (marker.completed.includes('reset') && workspace.headSha !== workspace.remoteDefaultSha)
      marker.completed = marker.completed.filter(
        (phase) => phase === 'cleanup' || phase === 'inspect',
      );
    if (
      (workspace.dirtyCount > 0 || workspace.publication === 'unpushed') &&
      params.mode !== 'force'
    )
      throw new Error('Local work requires discard confirmation');
    await save('cleanup', 'inspect');
    if (!marker.completed.includes('cleanup')) {
      const linked = await detectLinkedWorktree(vars);
      const tracking = resolveSlotTrackingBranchFromProject(
        project.projectJson,
        vars,
        project,
        linked,
      );
      const baseline =
        !authorized.currentRunId &&
        isSlotIdleBranch(workspace.branch, tracking, defaultBranch, linked);
      if (!baseline) {
        await verifyWork();
        const released = await slotRelease(
          { slotId: params.slotId, requestId, detachRuns: true },
          emit,
          {
            workspaceRecovery: {
              id: marker.id,
              epoch: authorized.epoch,
              verifyWork,
              discardLocalWork: params.mode === 'force',
            },
          },
        );
        if (!released.released) throw new Error(released.reason ?? 'Cleanup did not finish');
        keepWarm = false;
        await save('cleanup');
        // The existing release clears its own ownership fields and resets Git.
        await advanceIdentity();
        await save('fixtures', 'cleanup');
        await save('fixtures', 'reset');
      } else {
        await save('reset', 'cleanup');
      }
    }
    if (!marker.completed.includes('reset')) {
      await excludeSlotScaffolding(vars, project.projectJson);
      await verifyWork();
      output(
        'discard',
        params.mode === 'force'
          ? `Confirmed work on ${authorized.branch} at ${authorized.headSha}`
          : 'Verified published work',
      );
      await resetSlotRepoToIdle(vars, project.projectJson, project, defaultBranch, {
        discardLocalWork: params.mode === 'force',
      });
      await advanceIdentity();
      await save('fixtures', 'reset');
    }
    // A retry re-syncs fixtures, but never repeats a verified destructive cleanup/reset.
    await assertFence();
    await save('fixtures');
    await slotFixtureRefresh({ slotId: params.slotId, requestId }, emit);
    await advanceIdentity();
    await save('verify', 'fixtures');
    await assertFence();
    const verified = await inspectSlotWorkspace(params.slotId, {
      fetch: true,
      timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
    });
    const fixtures = await checkFixtures(vars, project, project.projectJson);
    const linked = await detectLinkedWorktree(vars);
    const tracking = resolveSlotTrackingBranchFromProject(
      project.projectJson,
      vars,
      project,
      linked,
    );
    if (
      verified.headSha !== verified.remoteDefaultSha ||
      !isSlotIdleBranch(verified.branch, tracking, defaultBranch, linked) ||
      verified.dirtyCount ||
      verified.currentRunId ||
      verified.cleanupRunId ||
      verified.handoffRunId ||
      !['OK', 'not-required'].includes(fixtures)
    )
      throw new Error('Checkout, free ownership or fixtures did not verify');
    await save('verify', 'verify');
    if (
      !(await updateSlotStatusIf(params.slotId, ownsFence, {
        branch: verified.branch,
        head_sha: verified.headSha,
        fixtures,
        workspace: null,
        workspace_error: null,
        last_error_at: null,
        last_error_msg: null,
      }))
    )
      throw new Error('Recovery fence changed');
    if (!(await resetSlotIf(params.slotId, ownsFence, keepWarm, marker.id)))
      throw new Error('Recovery ready transition refused');
    await loadFleetStatus(true);
    output('done', `${verified.branch} is ready at origin/${defaultBranch}`);
    return finish({
      requestId,
      refreshed: true,
      branch: verified.branch,
      advanced: params.expectedWorkspace.headSha !== verified.headSha,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (claimed && recovery) {
      const failed = { ...recovery, error: detail };
      await updateSlotStatusIf(
        params.slotId,
        (row) =>
          (Number(row.slot_epoch) || 0) === authorized.epoch &&
          recoveryFromRow(row)?.id === failed.id,
        {
          lifecycle: 'held',
          phase: 'occupied',
          held_reason: `Recovery ${failed.phase}: ${detail}`,
          workspace: null,
          workspace_error: detail,
          workspace_recovery: failed,
          releasing_since: null,
        },
      );
    }
    return refuse('failed-phase', detail, authorized.branch);
  } finally {
    invalidateSlotWorkspaceObservations(params.slotId);
    activePrepareSlots.delete(params.slotId);
    endTerminalTeardown(params.slotId);
  }
}
