import assert from 'node:assert/strict';
import test from 'node:test';

import { metroBundleProgress } from '../src/metro-progress.js';

test('metroBundleProgress reads percent and module counts from Metro and Expo lines', () => {
  assert.deepEqual(
    metroBundleProgress(
      'iOS ./index.js ▓▓▓▓▓▓░░░░ 61.3% (4210/6900) [metro-progress 2026-10-07T10:00:00.000Z]',
    ),
    { message: 'bundling', percent: 61.3, current: 4210, total: 6900, unit: 'modules' },
  );
  assert.deepEqual(metroBundleProgress('Android Bundling ░░░░░░░░ 0.0% (  0/1)'), {
    message: 'bundling',
    percent: 0,
    current: 0,
    total: 1,
    unit: 'modules',
  });
  assert.deepEqual(metroBundleProgress('iOS Bundling 12.5%'), {
    message: 'bundling',
    percent: 12.5,
  });
  assert.equal(metroBundleProgress('Metro waiting on exp://127.0.0.1:8081'), null);
  assert.equal(metroBundleProgress('iOS Bundled 1234ms index.js (6900 modules)'), null);
});
