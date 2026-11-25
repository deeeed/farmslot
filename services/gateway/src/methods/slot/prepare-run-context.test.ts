import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertRunMatchesSlotProject, withRunPrepareContext } from './prepare-run-context.js';

const run = { flowType: 'dev', domain: 'perps', app: 'extension' } as const;

test('a prepare for a run takes the run flow type, domain and app where they are missing', () => {
  assert.deepEqual(withRunPrepareContext({ slotId: 's', runId: 'r' }, run), {
    slotId: 's',
    runId: 'r',
    flowType: 'dev',
    domain: 'perps',
    app: 'extension',
  });
});

test('explicit prepare params win over the run', () => {
  assert.deepEqual(
    withRunPrepareContext(
      { slotId: 's', runId: 'r', flowType: 'qa', domain: 'money-movement', app: 'x' },
      run,
    ),
    { slotId: 's', runId: 'r', flowType: 'qa', domain: 'money-movement', app: 'x' },
  );
});

test('a prepare for no run, or a run without those fields, is unchanged', () => {
  assert.deepEqual(withRunPrepareContext({ slotId: 's' }, undefined), { slotId: 's' });
  assert.deepEqual(withRunPrepareContext({ slotId: 's', runId: 'r' }, { flowType: 'review-pr' }), {
    slotId: 's',
    runId: 'r',
    flowType: 'review-pr',
  });
});

test('blank prepare params count as unset and take the run values', () => {
  assert.deepEqual(
    withRunPrepareContext({ slotId: 's', runId: 'r', flowType: '', domain: '', app: '' }, run),
    {
      slotId: 's',
      runId: 'r',
      flowType: 'dev',
      domain: 'perps',
      app: 'extension',
    },
  );
  assert.deepEqual(
    withRunPrepareContext({ slotId: 's', runId: 'r', flowType: ' ', domain: ' ', app: '\t' }, run),
    { slotId: 's', runId: 'r', flowType: 'dev', domain: 'perps', app: 'extension' },
  );
});

test('a run of another project is refused; the same project or an unknown one passes', () => {
  assert.throws(
    () => assertRunMatchesSlotProject({ id: 'run-12345678', project: 'other' }, 'slot-1', 'mine'),
    /Run run-1234 belongs to project other, not slot-1's project mine/,
  );
  assert.doesNotThrow(() =>
    assertRunMatchesSlotProject({ id: 'r', project: 'mine' }, 'slot-1', 'mine'),
  );
  assert.doesNotThrow(() =>
    assertRunMatchesSlotProject({ id: 'r', project: '' }, 'slot-1', 'mine'),
  );
});
