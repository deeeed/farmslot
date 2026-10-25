import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decisionEvidenceMediaItems } from './decision-evidence-media';

test('decision media keeps task artifacts and recipe artifacts in their separate source identities', () => {
  const [task, before, after] = decisionEvidenceMediaItems({
    runId: 'historical-run',
    slotId: 'historical-slot',
    gatewayUrl: 'ws://127.0.0.1:12345',
    artifacts: [{ path: 'artifacts/result.png', purpose: 'evidence' }],
    authHeaders: {},
    recipeFallbackPairs: [
      {
        stem: 'screen',
        before: {
          path: 'before.png',
          purpose: 'evidence',
          recipeRunId: 'recorded-recipe',
          url: 'https://files.example/before',
        },
        after: {
          path: 'after.png',
          purpose: 'evidence',
          recipeRunId: 'recorded-recipe',
          url: 'https://files.example/after',
        },
      },
    ],
  });
  assert.deepEqual(task?.sharedArtifact, {
    runId: 'historical-run',
    slotId: 'historical-slot',
    path: 'artifacts/result.png',
    recipeRunId: undefined,
  });
  assert.deepEqual(before?.sharedArtifact, {
    runId: 'historical-run',
    slotId: 'historical-slot',
    path: 'before.png',
    recipeRunId: 'recorded-recipe',
  });
  assert.equal(after?.uri, 'https://files.example/after');
  assert.equal(after?.sharedArtifact?.path, 'after.png');
  assert.deepEqual(
    decisionEvidenceMediaItems({
      runId: null,
      gatewayUrl: 'ws://127.0.0.1:12345',
      artifacts: [{ path: 'old.png', purpose: 'evidence' }],
      authHeaders: {},
      recipeFallbackPairs: [],
    }),
    [],
  );
});
