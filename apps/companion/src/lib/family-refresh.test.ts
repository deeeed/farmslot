import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldRefreshFamilySnapshotForRunEvent } from './family-refresh';

test('family refresh accepts run events for the current family before the run is in the snapshot', () => {
  assert.equal(
    shouldRefreshFamilySnapshotForRunEvent(
      { familyId: 'family-a', project: 'app-a', runIds: [] },
      { run: { id: 'run-new', familyId: 'family-a', project: 'app-a' } },
    ),
    true,
  );
});

test('family refresh accepts existing run id events that omit family metadata', () => {
  assert.equal(
    shouldRefreshFamilySnapshotForRunEvent(
      { familyId: 'family-a', project: 'app-a', runIds: ['run-1'] },
      { runId: 'run-1' },
    ),
    true,
  );
});

test('family refresh rejects unrelated family events', () => {
  assert.equal(
    shouldRefreshFamilySnapshotForRunEvent(
      { familyId: 'family-a', project: 'app-a', runIds: ['run-1'] },
      { run: { id: 'run-2', familyId: 'family-b', project: 'app-a' } },
    ),
    false,
  );
});

test('family refresh keeps project-scoped routes from refreshing on same family id in another project', () => {
  assert.equal(
    shouldRefreshFamilySnapshotForRunEvent(
      { familyId: 'family-a', project: 'app-a', runIds: [] },
      { run: { id: 'run-2', familyId: 'family-a', project: 'app-b' } },
    ),
    false,
  );
});
