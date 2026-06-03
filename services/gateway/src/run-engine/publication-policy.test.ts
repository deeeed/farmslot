import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ciRequiresPublishedPr,
  requiresPublicationApproval,
  shouldPrepareLocalFirstPackage,
} from './publication-policy.js';
import { makeRun } from './test-fixtures.js';

test('local-first publication policy includes autonomous dev and excludes interactive/artifact/no-code', () => {
  const autonomousDev = makeRun({ flowType: 'dev', mode: 'autonomous' });
  assert.equal(shouldPrepareLocalFirstPackage(autonomousDev), true);
  assert.equal(requiresPublicationApproval(autonomousDev), true);
  assert.equal(ciRequiresPublishedPr(autonomousDev), true);

  assert.equal(
    shouldPrepareLocalFirstPackage(makeRun({ flowType: 'dev', mode: 'interactive' })),
    false,
  );
  assert.equal(
    shouldPrepareLocalFirstPackage(
      makeRun({ flowType: 'dev', mode: 'autonomous', completionPolicy: 'artifact-only' }),
    ),
    false,
  );
  assert.equal(
    shouldPrepareLocalFirstPackage(
      makeRun({
        flowType: 'fix-bug',
        metrics: {
          nudgeCount: 0,
          model: 'gpt-5.5',
          runner: 'codex',
          runnerSessionId: null,
          runnerSessionPath: null,
          disposition: 'already_fixed',
        },
      }),
    ),
    false,
  );
});
