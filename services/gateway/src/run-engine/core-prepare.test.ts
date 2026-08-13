import assert from 'node:assert/strict';
import test from 'node:test';

import { loadProjectVars } from '../core/config.js';
import { resolvePrepareProfile } from '../methods/slot/prepare-profile.js';

test('Farmslot state-only default completes core phases without visual or native launch hooks', async () => {
  const project = await loadProjectVars('farmslot-farm');
  const profile = resolvePrepareProfile(project.projectJson);

  assert.equal(profile.name, 'core');
  assert.deepEqual([...profile.phases], ['git', 'fixtures', 'deps']);
  assert.equal(profile.phases.has('preflight'), false);
  assert.equal(profile.phases.has('health'), false);
  assert.deepEqual(profile.hooks, {});

  const serialized = JSON.stringify(profile).toLowerCase();
  for (const processName of ['chrome', 'cdp', 'metro', 'companion', 'simctl boot', 'adb']) {
    assert.equal(
      serialized.includes(processName),
      false,
      `${processName} leaked into core prepare`,
    );
  }
});
