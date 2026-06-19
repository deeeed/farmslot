import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ciRequiresPublishedPr,
  requiresPublicationApproval,
  shouldPrepareLocalFirstPackage,
} from './publication-policy.js';
import { makeRun } from './test-fixtures.js';

test('local-first publication policy includes autonomous and reviewed dev but excludes lightweight/artifact/no-code', () => {
  const autonomousDev = makeRun({ flowType: 'dev', mode: 'autonomous' });
  assert.equal(shouldPrepareLocalFirstPackage(autonomousDev), true);
  assert.equal(requiresPublicationApproval(autonomousDev), true);
  assert.equal(ciRequiresPublishedPr(autonomousDev), true);

  assert.equal(
    shouldPrepareLocalFirstPackage(makeRun({ flowType: 'dev', mode: 'interactive' })),
    false,
  );
  const reviewedInteractiveDev = makeRun({
    flowType: 'dev',
    mode: 'interactive',
    devInteractiveProfile: 'reviewed',
  });
  assert.equal(shouldPrepareLocalFirstPackage(reviewedInteractiveDev), true);
  assert.equal(requiresPublicationApproval(reviewedInteractiveDev), true);
  assert.equal(ciRequiresPublishedPr(reviewedInteractiveDev), true);
  assert.equal(
    shouldPrepareLocalFirstPackage(
      makeRun({
        flowType: 'dev',
        mode: 'interactive',
        engineState: { interactiveDev: { profile: 'reviewed' } },
      }),
    ),
    true,
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
