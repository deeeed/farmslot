import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecResult } from '@farmslot/protocol';

import { makeVars } from '../runners/test-fixtures.js';

import { ParkedWorkError, readParkedGitWork } from './parked-work.js';

const vars = makeVars({ slotId: 'boundary-proof' });
const read = (result: ExecResult) => readParkedGitWork(vars, vars.slotId, async () => result);

test('failed parked child reports its exit and stderr instead of a JSON error', async () => {
  await assert.rejects(
    read({ stdout: '', stderr: 'command timed out after 120000ms', exitCode: 124 }),
    (error) => {
      assert.ok(error instanceof ParkedWorkError);
      assert.equal(error.code, 'PARKED_WORK_PARK_FAILED');
      assert.match(error.message, /boundary-proof/);
      assert.match(error.message, /list/);
      assert.match(error.message, /124/);
      assert.match(error.message, /timed out/);
      assert.doesNotMatch(error.message, /not valid JSON/);
      return true;
    },
  );
});

test('valid parked domain failure retains its code on a nonzero child exit', async () => {
  await assert.rejects(
    read({
      stdout: JSON.stringify({
        ok: false,
        code: 'WORK_CHANGED',
        message: 'Work changed during capture',
      }),
      stderr: '',
      exitCode: 42,
    }),
    (error) =>
      error instanceof ParkedWorkError &&
      error.code === 'PARKED_WORK_WORK_CHANGED' &&
      error.message === 'Work changed during capture',
  );
});

test('a successful parked envelope cannot hide a failed process', async () => {
  await assert.rejects(
    read({
      stdout: JSON.stringify({ ok: true, value: {} }),
      stderr: 'node aborted',
      exitCode: 134,
    }),
    (error) => {
      assert.ok(error instanceof ParkedWorkError);
      assert.equal(error.code, 'PARKED_WORK_PARK_FAILED');
      assert.match(error.message, /134.*node aborted/);
      return true;
    },
  );
});

test('invalid stored receipt JSON names the ref rather than the transport response', async () => {
  const ref = 'refs/farmslot/parked/boundary-proof/old';
  await assert.rejects(
    read({
      stdout: JSON.stringify({
        ok: true,
        value: {
          repoKey: 'a'.repeat(64),
          namespace: 'refs/farmslot/parked/boundary-proof/',
          items: [{ ref, headSha: 'b'.repeat(40), metadata: 'not-json' }],
        },
      }),
      stderr: '',
      exitCode: 0,
    }),
    (error) => {
      assert.ok(error instanceof ParkedWorkError);
      assert.equal(error.code, 'PARKED_WORK_INVALID_METADATA');
      assert.ok(error.message.includes(ref));
      assert.match(error.message, /receipt/);
      return true;
    },
  );
});

test('parked child diagnostics are redacted before bounding the message', async () => {
  await assert.rejects(
    read({ stdout: '', stderr: 'x'.repeat(2200) + ' token=private-value', exitCode: 1 }),
    (error) => {
      assert.ok(error instanceof ParkedWorkError);
      assert.equal(error.code, 'PARKED_WORK_PARK_FAILED');
      assert.doesNotMatch(error.message, /private-value/);
      assert.match(error.message, /token=\[REDACTED\]/);
      assert.ok(error.message.length < 1800);
      return true;
    },
  );
});
