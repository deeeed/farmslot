import { randomUUID } from 'node:crypto';

import {
  DEFAULT_BRANCH,
  isTerminalRunStatus,
  parksSlotCommits,
  sameSlotWorkspace,
  type SlotParkedCommits,
  slotParkedDetail,
  type SlotRecovery,
  slotRecoveryEligibility,
  type SlotRecoveryPhase,
  type SlotRecoveryRefusal,
  type SlotRefreshParams,
  type SlotRefreshResult,
  type SlotResetExpectation,
  type SlotWorkspaceIdentity,
  slotWorkspaceIdentity,
} from '@farmslot/protocol';

import {
  execOnSlot,
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
import { shellQuote } from '../../core/tmux.js';
import { excludeSlotScaffolding } from '../../fleet/slot-scaffolding.js';
import { loadFleetStatus } from '../../fleet/state.js';
import {
  beginTerminalTeardown,
  endTerminalTeardown,
} from '../../run-engine/terminal-teardown-registry.js';
import { parkSlotBranch, parkSlotCommits } from '../../run-lifecycle/validation-run-commits.js';
import { getRun, getRunWithArchived } from '../../runs/store.js';
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

interface SlotRecoveryOptions {
  /** Automatic reuse/settlement keeps the runtime cold; manual RPCs keep their existing policy. */
  skipRecycle?: boolean;
  /** A finished artifact-only run whose own branch commits the release parks before resetting. */
  parkRunId?: string;
  /** The exact head an ownerless return to idle may park. */
  parkHeadSha?: string;
  /** An operator release parks unpushed commits when no live run owns the checkout. */
  parkOwnerlessCommits?: boolean;
}

export async function recoverSlotWorkspace(
  params: SlotRefreshParams,
  emit: EventEmitter,
  signal?: AbortSignal,
  options?: SlotRecoveryOptions,
): Promise<SlotRefreshResult> {
  const requestId = params.requestId ?? `refresh-${randomUUID()}`;
  const started = Date.now();
  let parked: SlotParkedCommits[] = [];
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
    finish({
      requestId,
      refreshed: false,
      reason,
      detail: parked.length ? `${detail}; ${slotParkedDetail(parked)}` : detail,
      branch,
      advanced: false,
      ...(parked.length ? { parked } : {}),
    });
  if (!params.expectedWorkspace && !params.recover)
    return refuse('identity-changed', 'Inspect the workspace before releasing');
  if (activePrepareSlots.has(params.slotId))
    return refuse('protected', 'Slot is preparing or refreshing');
  assertNoNativeWorkerRecovery(params.slotId);
  activePrepareSlots.add(params.slotId);
  beginTerminalTeardown(params.slotId);
  let recovery: SlotRecovery | undefined;
  let claimed = false;
  try {
    const vars = await loadSlotVars(params.slotId);
    await assertSlotNotOperatorRoot(vars, 'refresh');
    const project = await loadProjectVars(vars.projectName);
    const defaultBranch = getProjectField(project.projectJson, 'default_branch') || DEFAULT_BRANCH;
    const entryRow = await readSlotRow(params.slotId);
    const pendingRecovery = entryRow?.workspace_recovery;
    if (params.recover) {
      if (!entryRow || !pendingRecovery)
        return refuse('protected', 'Slot has no pending workspace recovery');
      if (owner(entryRow, 'cleanup_run_id') || owner(entryRow, 'handoff_run_id'))
        return refuse('protected', 'Slot has a cleanup or handoff owner');
      const protectedReason = await workspaceProtectedReason(params.slotId, entryRow);
      if (protectedReason) return refuse('protected', protectedReason);
    }
    let workspace = await inspectSlotWorkspace(params.slotId, {
      timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
    });
    let authorized = slotWorkspaceIdentity(workspace);
    const initialHeadSha = workspace.headSha;
    // Invalid persisted progress cannot authorize skipped phases. Re-inspect and start over.
    if (pendingRecovery && !workspace.recovery)
      workspace.recovery = {
        id: randomUUID(),
        identity: authorized,
        completed: [],
        phase: 'inspect',
      };
    parked = workspace.recovery?.parked?.slice() ?? [];
    if (params.expectedWorkspace && !sameSlotWorkspace(workspace, params.expectedWorkspace))
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
    if (eligibility.confirmationRequired && (params.mode !== 'force' || !params.expectedWorkspace))
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
      parked,
    };
    const marker = recovery;
    const entryEpoch = workspace.epoch;
    const entryRun = workspace.currentRunId
      ? await getRunWithArchived(workspace.currentRunId)
      : undefined;
    let guardRefusal: string | undefined;
    const mark = await markSlotStatusIf(
      params.slotId,
      (row) => {
        const ownerRun = workspace.currentRunId
          ? (getRun(workspace.currentRunId) ?? entryRun)
          : undefined;
        if (
          !identityOwnsRow(row, workspace) ||
          row.phase === 'releasing' ||
          row.lifecycle === 'manual' ||
          row.lifecycle === 'disabled' ||
          (row.agent === 'working' && !(pendingRecovery && workspace.terminalOwner)) ||
          (pendingRecovery &&
            (JSON.stringify(row.workspace_recovery) !== JSON.stringify(pendingRecovery) ||
              owner(row, 'cleanup_run_id') ||
              owner(row, 'handoff_run_id') ||
              (workspace.currentRunId && (!ownerRun || !isTerminalRunStatus(ownerRun.status)))))
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
        current.currentRunId !== authorized.currentRunId ||
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
    // Preserve unpublished work before teardown when no live run owns the recovery.
    const parkOwnerless =
      !!options?.parkOwnerlessCommits && !options.parkRunId && parksSlotCommits(workspace);
    if (
      (workspace.dirtyCount > 0 || (workspace.publication === 'unpushed' && !parkOwnerless)) &&
      params.mode !== 'force'
    )
      throw new Error('Local work requires discard confirmation');
    const resetLinked = await detectLinkedWorktree(vars);
    const targetBranch = resetLinked
      ? resolveSlotTrackingBranchFromProject(project.projectJson, vars, project, resetLinked)
      : defaultBranch;
    const targetHead = await execOnSlot(
      vars,
      `git -C ${shellQuote(vars.remoteRepo)} rev-parse --verify --quiet ${shellQuote(`refs/heads/${targetBranch}`)}`,
      { noRetry: true },
    );
    if (targetHead.exitCode !== 0 && targetHead.exitCode !== 1)
      throw new Error('Cannot inspect the reset branch');
    const expect: SlotResetExpectation = {
      headSha: authorized.headSha,
      branches: { [targetBranch]: targetHead.exitCode === 0 ? targetHead.stdout.trim() : null },
    };
    const recordPark = async (entry: SlotParkedCommits | null) => {
      if (!entry) return;
      if (!parked.some((item) => item.ref === entry.ref)) parked.push(entry);
      marker.parked = parked;
      await save('inspect');
      output('park', slotParkedDetail([entry]));
    };
    if (parkOwnerless) {
      await verifyWork();
      const entry = await parkSlotCommits(vars, execOnSlot, {
        headSha: authorized.headSha,
        defaultBranch,
      });
      if (!entry) throw new Error('Unpushed commits changed before parking; inspect again');
      await recordPark(entry);
    }
    if (
      options?.parkOwnerlessCommits &&
      (!workspace.currentRunId || workspace.terminalOwner) &&
      targetBranch !== workspace.branch &&
      expect.branches?.[targetBranch]
    )
      await recordPark(
        await parkSlotBranch(vars, execOnSlot, {
          branch: targetBranch,
          defaultBranch,
          headSha: authorized.headSha,
        }),
      );
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
      // Parking happens only in the release below; an idle-branch reset would skip it.
      if (baseline && options?.parkRunId)
        throw new Error('A checkout on the idle branch holds no run branch commits to park');
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
              skipRecycle: options?.skipRecycle,
              expect,
              parked: parked.length > 0,
              ...(options?.parkRunId
                ? { parkRunId: options.parkRunId, parkHeadSha: options.parkHeadSha }
                : {}),
            },
          },
        );
        if (!released.released) throw new Error(released.reason ?? 'Cleanup did not finish');
        keepWarm = false;
        // Completed teardown must stay cold even if cancellation arrived during release.
        if (!(await updateSlotStatusIf(params.slotId, ownsFence, { warm: false })))
          throw new Error('Recovery fence changed');
        if (signal?.aborted) throw new Error('Recovery cancelled; retry to finish verification');
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
          : parked.length
            ? 'Unpushed commits are parked'
            : 'Verified published work',
      );
      await resetSlotRepoToIdle(vars, project.projectJson, project, defaultBranch, {
        discardLocalWork: params.mode === 'force',
        expect,
        verifyWork,
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
    let verified = await inspectSlotWorkspace(params.slotId, {
      fetch: true,
      timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
    });
    let fixtures = await checkFixtures(vars, project, project.projectJson);
    const linked = await detectLinkedWorktree(vars);
    const tracking = resolveSlotTrackingBranchFromProject(
      project.projectJson,
      vars,
      project,
      linked,
    );
    for (let attempt = 0; ; attempt++) {
      const failures: string[] = [];
      const headMoved = verified.headSha !== verified.remoteDefaultSha;
      if (headMoved)
        failures.push(`headSha=${verified.headSha}, remoteDefaultSha=${verified.remoteDefaultSha}`);
      if (!isSlotIdleBranch(verified.branch, tracking, defaultBranch, linked))
        failures.push(`branch=${verified.branch}, expected=${targetBranch}`);
      if (verified.dirtyCount) failures.push(`dirtyCount=${verified.dirtyCount}`);
      if (verified.currentRunId !== authorized.currentRunId)
        failures.push(`currentRunId=${verified.currentRunId}, expected=${authorized.currentRunId}`);
      if (verified.cleanupRunId) failures.push(`cleanupRunId=${verified.cleanupRunId}`);
      if (verified.handoffRunId) failures.push(`handoffRunId=${verified.handoffRunId}`);
      if (!['OK', 'not-required'].includes(fixtures)) failures.push(`fixtures=${fixtures}`);
      if (!failures.length) break;
      if (
        !headMoved ||
        failures.length !== 1 ||
        attempt >= 2 ||
        !sameSlotWorkspace(verified, authorized) ||
        verified.publication !== 'merged'
      )
        throw new Error(`Recovery verification failed: ${failures.join('; ')}`);
      // Only an unchanged, clean idle checkout already contained in the new default may retry.
      await resetSlotRepoToIdle(vars, project.projectJson, project, defaultBranch, {
        expect: { headSha: verified.headSha, branches: { [targetBranch]: verified.headSha } },
        verifyWork,
      });
      await advanceIdentity();
      await save('fixtures', 'reset');
      await slotFixtureRefresh({ slotId: params.slotId, requestId }, emit);
      await advanceIdentity();
      await save('verify', 'fixtures');
      await assertFence();
      verified = await inspectSlotWorkspace(params.slotId, {
        fetch: true,
        timeoutMs: RECOVERY_PROBE_TIMEOUT_MS,
      });
      fixtures = await checkFixtures(vars, project, project.projectJson);
    }
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
      advanced: initialHeadSha !== verified.headSha,
      ...(parked.length ? { parked } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (claimed && recovery) {
      const failed = { ...recovery, error: detail };
      await updateSlotStatusIf(
        params.slotId,
        (row) =>
          (Number(row.slot_epoch) || 0) === failed.identity.epoch &&
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
    return refuse(
      'failed-phase',
      detail,
      recovery?.identity.branch ?? params.expectedWorkspace?.branch ?? '',
    );
  } finally {
    invalidateSlotWorkspaceObservations(params.slotId);
    activePrepareSlots.delete(params.slotId);
    endTerminalTeardown(params.slotId);
  }
}
