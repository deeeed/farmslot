import { isTerminalRunStatus, type Run } from '@farmslot/protocol';

import { readPRCompletionHead } from '../review/acceptance-coverage.js';
import { getRun } from '../runs/store.js';

export interface PRCompletionTransactionIdentity {
  registrationRevision: number;
  contractRevision: number;
  headSha: string;
  generation: number;
}

function completionProofMatches(run: Run, proof: PRCompletionTransactionIdentity): boolean {
  return (
    run.flowType === 'pr-complete' &&
    run.acceptanceContractVersion === 1 &&
    (run.acceptanceRegistration?.revision ?? 0) === proof.registrationRevision &&
    run.acceptanceExecutionContract?.revision === proof.contractRevision
  );
}

export async function assertPRCompletionIdentity(
  runId: string,
  expected: PRCompletionTransactionIdentity,
): Promise<void> {
  const run = getRun(runId);
  if (
    !run ||
    isTerminalRunStatus(run.status) ||
    run.status === 'paused' ||
    (run.engineState?.generation ?? 0) !== expected.generation ||
    !completionProofMatches(run, expected) ||
    run.acceptanceRegistration?.units.some(({ result }) => !result) ||
    (await readPRCompletionHead(run)) !== expected.headSha ||
    !getRun(runId) ||
    isTerminalRunStatus(getRun(runId)!.status) ||
    getRun(runId)!.status === 'paused' ||
    (getRun(runId)!.engineState?.generation ?? 0) !== expected.generation ||
    !completionProofMatches(getRun(runId)!, expected)
  )
    throw new Error(
      'PR completion acceptance or pushed head changed; settle the current criteria before completing',
    );
}
