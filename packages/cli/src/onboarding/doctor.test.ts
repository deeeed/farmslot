import assert from 'node:assert/strict';
import test from 'node:test';

import { captureHelperResultCheck } from './doctor.js';

test('capture check surfaces env-override provenance on success', () => {
  const check = captureHelperResultCheck(
    '/opt/bin/capture-helper',
    'env:SITEED_CAPTURE_HELPER_BIN',
    {
      status: 0,
      stdout: '',
      stderr: '',
      error: undefined,
    },
  );
  assert.equal(check.ok, true);
  assert.equal(check.warn, undefined);
  assert.equal(
    check.detail,
    '/opt/bin/capture-helper doctor passed (via SITEED_CAPTURE_HELPER_BIN)',
  );
});

test('capture check surfaces env-override provenance on failure', () => {
  const check = captureHelperResultCheck('/opt/bin/capture-helper', 'env:CAPTURE_HELPER_PATH', {
    status: 1,
    stdout: '',
    stderr: 'permission denied',
    error: undefined,
  });
  assert.equal(check.ok, true);
  assert.equal(check.warn, true);
  assert.equal(
    check.detail,
    '/opt/bin/capture-helper doctor failed (via CAPTURE_HELPER_PATH): permission denied',
  );
});

test('capture check prints PATH resolution plainly, no provenance suffix', () => {
  const pass = captureHelperResultCheck('capture-helper', 'PATH', {
    status: 0,
    stdout: '',
    stderr: '',
  });
  assert.equal(pass.detail, 'capture-helper doctor passed');
  const fail = captureHelperResultCheck('capture-helper', 'PATH', {
    status: 1,
    stdout: '',
    stderr: 'boom',
  });
  assert.equal(fail.detail, 'capture-helper doctor failed: boom');
});
