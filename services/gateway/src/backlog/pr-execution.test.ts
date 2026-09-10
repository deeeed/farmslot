import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPRRepairExecutionAccess } from './pr-execution.js';

test('repair access requires the selected account, repository push rights and explicit branch policy', () => {
  const viewer = { login: 'REPAIRER' };
  const repository = { permissions: { push: true } };
  const branch = { protected: false };
  assert.doesNotThrow(() => assertPRRepairExecutionAccess('repairer', viewer, repository, branch));
  for (const invalid of [undefined, {}, { login: 'other' }])
    assert.throws(
      () => assertPRRepairExecutionAccess('repairer', invalid, repository, branch),
      /identity/,
    );
  for (const invalid of [
    undefined,
    {},
    { permissions: { pull: true } },
    { permissions: { push: false } },
  ])
    assert.throws(
      () => assertPRRepairExecutionAccess('repairer', viewer, invalid, branch),
      /push permission/,
    );
  for (const invalid of [undefined, {}, { protected: true }, { protected: 'false' }])
    assert.throws(
      () => assertPRRepairExecutionAccess('repairer', viewer, repository, invalid),
      /branch policy/,
    );
});
