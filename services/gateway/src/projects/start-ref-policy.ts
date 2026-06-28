import type {
  FlowType,
  RunCreateParams,
  RunLane,
  RunStartRefProvenance,
  RunStartRefSource,
} from '@farmslot/protocol';

import { execOnSlot } from '../core/exec.js';
import { loadSlotVars } from '../core/index.js';
import { shellQuote } from '../core/tmux.js';

import { resolveStartRefInRepo, sanitizeStartRef } from './start-ref-resolution.js';

type UnsupportedStartRefSource = { kind: 'prior-run'; runId?: string };

interface StartRefPolicyParams {
  flowType: FlowType;
  lane?: RunLane;
  variant?: string | null;
  completionPolicy?: 'default' | 'artifact-only';
  mode?: 'interactive' | 'autonomous' | 'validation';
  familyId?: string | null;
  parentRunId?: string | null;
  startRef?: string;
  startRefSource?: RunStartRefSource | UnsupportedStartRefSource;
  skipPrepare?: boolean;
  /** Set by run.create after verifying slot HEAD matches the resolved startRef SHA. */
  startRefSkipPrepareVerified?: boolean;
  nudgeReuse?: boolean;
  freshReuse?: boolean;
}

export class StartRefPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartRefPolicyError';
  }
}

export function isStartRefPolicyError(error: unknown): boolean {
  return (
    error instanceof StartRefPolicyError ||
    (error instanceof Error && error.name === 'StartRefPolicyError')
  );
}

function resolvedLane(params: Pick<StartRefPolicyParams, 'mode' | 'lane'>): RunLane {
  if (params.lane) return params.lane;
  if (params.mode === 'validation') return 'validation';
  return 'production';
}

function reject(message: string): never {
  throw new StartRefPolicyError(message);
}

export function normalizeStartRefRequest(
  params: StartRefPolicyParams,
): RunStartRefProvenance | null {
  const rawStartRef = params.startRef;
  if (rawStartRef === undefined || rawStartRef === null || rawStartRef.trim() === '') return null;

  const requestedRef = (() => {
    try {
      return sanitizeStartRef(rawStartRef);
    } catch (error) {
      reject((error as Error).message);
    }
  })();

  const lane = resolvedLane(params);
  const variant = params.variant?.trim() ?? '';
  if (params.flowType !== 'dev' && params.flowType !== 'fix-bug') {
    reject(
      `startRef is only supported for dev/fix-bug comparison runs (got ${params.flowType as FlowType})`,
    );
  }
  if (lane !== 'comparison') {
    reject(`startRef requires lane=comparison (got ${lane})`);
  }
  if (!variant) {
    reject('startRef comparison runs require an explicit variant');
  }
  if (params.completionPolicy !== 'artifact-only') {
    reject('startRef requires completionPolicy=artifact-only');
  }
  if (params.skipPrepare && !params.startRefSkipPrepareVerified) {
    reject(
      'startRef cannot be combined with skipPrepare unless slot HEAD already matches the requested startRef',
    );
  }
  if (params.nudgeReuse) {
    reject('startRef cannot be combined with nudgeReuse');
  }
  if (params.freshReuse) {
    reject('startRef cannot be combined with freshReuse');
  }
  if (params.startRefSource?.kind === 'prior-run') {
    reject(
      'startRef prior-run replay must use eval.experiment.create + eval.trial.start; direct prior-run parent binding is not supported',
    );
  }

  return {
    requestedRef,
    source: params.startRefSource ?? { kind: 'manual' },
  };
}

export async function assertStartRefSkipPrepareEligible(
  params: Pick<RunCreateParams, 'startRef' | 'skipPrepare' | 'slotId'>,
): Promise<void> {
  if (!params.startRef?.trim() || !params.skipPrepare) return;
  if (!params.slotId?.trim()) {
    throw new StartRefPolicyError(
      'startRef with skipPrepare requires slotId so slot HEAD can be verified against the requested startRef',
    );
  }
  const vars = await loadSlotVars(params.slotId);
  const requestedRef = sanitizeStartRef(params.startRef);
  const resolution = await resolveStartRefInRepo({
    repo: vars.remoteRepo,
    requestedRef,
    exec: (command) => execOnSlot(vars, command, { timeout: 30_000 }),
  });
  const head = await execOnSlot(
    vars,
    `git -C ${shellQuote(vars.remoteRepo)} rev-parse HEAD`,
    { timeout: 10_000 },
  );
  if (head.exitCode !== 0) {
    throw new StartRefPolicyError(
      `Could not read slot HEAD for startRef skipPrepare verification: ${head.stderr.slice(-200) || head.stdout.slice(-200)}`,
    );
  }
  const headSha = head.stdout.trim();
  if (headSha !== resolution.resolvedSha) {
    throw new StartRefPolicyError(
      `startRef skipPrepare requires slot HEAD ${headSha.slice(0, 12)} to match startRef ${resolution.resolvedSha.slice(0, 12)} (${requestedRef})`,
    );
  }
}

export function assertStartRefWorkBranchIsLocalOnly(params: {
  branch: string;
  remoteExists: boolean;
  startRef?: Pick<RunStartRefProvenance, 'requestedRef'> | null;
}): void {
  if (!params.startRef || !params.remoteExists) return;
  throw new StartRefPolicyError(
    `startRef artifact-only replay refuses to mutate or reuse existing remote branch '${params.branch}' for base '${params.startRef.requestedRef}'. Choose a unique variant/branch before retrying.`,
  );
}
