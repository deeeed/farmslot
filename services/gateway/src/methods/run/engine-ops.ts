import {
  Events,
  type RunAutoRecoveryStopParams,
  type RunAutoRecoveryStopResult,
  type RunCIWatchPokeParams,
  type RunCIWatchPokeResult,
  type RunRefreshMirrorParams,
  type RunRefreshMirrorResult,
  type RunRefreshPublishPackageParams,
  type RunRefreshPublishPackageResult,
  type RunRefreshReviewGateParams,
  type RunRefreshReviewGateResult,
} from '@farmslot/protocol';

import { pokeCIPoll } from '../../ci-monitor/service.js';
import { refreshArtifactMirror } from '../../run-completion/artifact-mirror.js';
import { refreshPublishPackage } from '../../run-engine/publish-package-refresh.js';
import { refreshReviewGate } from '../../run-engine/review-gate.js';
import { getRun, updateRun } from '../../runs/store.js';

type Emit = (event: string, payload: unknown) => void;

export function runAutoRecoveryStop(
  params: RunAutoRecoveryStopParams,
  emit: Emit,
): RunAutoRecoveryStopResult {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  const updated = updateRun(params.runId, {
    autoRecoveryDisabled: true,
    recoveryProposal: { status: 'disabled', generation: run.engineState?.generation ?? 0 },
  });
  emit(Events.RUN_UPDATED, { run: updated });
  return { run: updated };
}

export function runCIWatchPoke(params: RunCIWatchPokeParams): RunCIWatchPokeResult {
  const run = getRun(params.runId);
  if (!run) throw new Error(`Run not found: ${params.runId}`);
  const res = pokeCIPoll(params.runId);
  if (!res.ok) return { ok: false, reason: res.reason ?? 'poke failed' };
  return { ok: true, woken: res.woken === true };
}

export async function runRefreshReviewGate(
  params: RunRefreshReviewGateParams,
  _emit: Emit,
): Promise<RunRefreshReviewGateResult> {
  const run = await refreshReviewGate(params.runId);
  return { run };
}

export async function runRefreshPublishPackage(
  params: RunRefreshPublishPackageParams,
  _emit: Emit,
): Promise<RunRefreshPublishPackageResult> {
  return refreshPublishPackage(params);
}

export async function runRefreshMirror(
  params: RunRefreshMirrorParams,
  _emit: Emit,
): Promise<RunRefreshMirrorResult> {
  const run = getRun(params.runId);
  if (!run) return { ok: false, reason: `Run not found: ${params.runId}` };
  if (!run.slotId) return { ok: false, reason: 'Run not attached to a slot' };
  try {
    const copied = await refreshArtifactMirror(run);
    return { ok: true, copied };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
