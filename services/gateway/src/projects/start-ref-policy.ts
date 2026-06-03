import type {
  FlowType,
  RunLane,
  RunStartRefProvenance,
  RunStartRefSource,
} from '@farmslot/protocol';

import { sanitizeStartRef } from './start-ref-resolution.js';

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
  if (params.skipPrepare) {
    reject('startRef cannot be combined with skipPrepare');
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
