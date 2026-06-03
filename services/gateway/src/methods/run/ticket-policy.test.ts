import assert from 'node:assert/strict';
import test from 'node:test';

import { isInternalArtifactOnlyEvalTicket } from './ticket-policy.js';

test('internal artifact-only eval tickets are limited to dev comparison task-file runs', () => {
  assert.equal(
    isInternalArtifactOnlyEvalTicket({
      ticketOrPr: 'EVAL-B961423B61FD',
      flowType: 'dev',
      lane: 'comparison',
      completionPolicy: 'artifact-only',
      taskFile: '/tmp/eval/TASK.md',
    }),
    true,
  );
  assert.equal(
    isInternalArtifactOnlyEvalTicket({
      ticketOrPr: 'EVAL-B961423B61FD',
      flowType: 'dev',
      lane: 'production',
      completionPolicy: 'artifact-only',
      taskFile: '/tmp/eval/TASK.md',
    }),
    false,
  );
  assert.equal(
    isInternalArtifactOnlyEvalTicket({
      ticketOrPr: 'EVAL-B961423B61FD',
      flowType: 'dev',
      lane: 'comparison',
      completionPolicy: 'artifact-only',
      taskFile: undefined,
    }),
    false,
  );
  assert.equal(
    isInternalArtifactOnlyEvalTicket({
      ticketOrPr: 'EVAL-B961423B61FD',
      flowType: 'fix-bug',
      lane: 'comparison',
      completionPolicy: 'artifact-only',
      taskFile: undefined,
      engineState: {
        evalExperiment: {
          experimentId: 'experiment-b961423b61fd',
          experimentKey: 'experiment-b961423b61fd',
          experimentManifestPath: '/tmp/eval/experiment-manifest.json',
          packagePath: '/tmp/eval/candidate.result-package.json',
          candidateStrategyFingerprint: 'fingerprint',
          trialId: 'trial-1',
        },
      },
    }),
    true,
  );
});
