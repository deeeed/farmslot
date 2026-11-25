import assert from 'node:assert/strict';
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
