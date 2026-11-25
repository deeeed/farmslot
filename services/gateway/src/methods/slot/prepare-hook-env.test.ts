import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { prepareHookEnvExports } from './prepare-hook-env.js';

test('prepare hooks see the profile and the flow type; a flowless prepare unsets it', () => {
  assert.deepEqual(prepareHookEnvExports('full', 'dev'), [
    "export FARMSLOT_PREPARE_PROFILE='full'",
    "export FARMSLOT_FLOW_TYPE='dev'",
  ]);
  assert.deepEqual(prepareHookEnvExports('ensure-js-runtime'), [
    "export FARMSLOT_PREPARE_PROFILE='ensure-js-runtime'",
    'unset FARMSLOT_FLOW_TYPE',
  ]);
  assert.deepEqual(prepareHookEnvExports('full', ''), [
    "export FARMSLOT_PREPARE_PROFILE='full'",
    'unset FARMSLOT_FLOW_TYPE',
  ]);
  assert.deepEqual(prepareHookEnvExports("o'dd", 'fix-bug'), [
    "export FARMSLOT_PREPARE_PROFILE='o'\\''dd'",
    "export FARMSLOT_FLOW_TYPE='fix-bug'",
  ]);
});

// The lines run in the hook's shell: a flowless prepare drops a value the gateway's own
// environment carries, and a flow replaces it.
test('in a shell, the exports replace or drop an inherited FARMSLOT_FLOW_TYPE', () => {
  const seen = (flowType?: string) =>
    spawnSync(
      'bash',
      ['-c', `${prepareHookEnvExports('full', flowType).join('; ')}; printf '%s' "\${FARMSLOT_FLOW_TYPE-unset}"`],
      { encoding: 'utf8', env: { ...process.env, FARMSLOT_FLOW_TYPE: 'inherited-from-the-gateway' } },
    ).stdout;
  assert.equal(seen('dev'), 'dev');
  assert.equal(seen(), 'unset');
});
