import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { SlotVars } from '../core/config.js';

const nativeExec = await import('../core/exec.js');
const calls: unknown[][] = [];
let result = { stdout: 'turns=3\ntotal_tokens=124\n', stderr: '', exitCode: 0 };
mock.module('../core/exec.js', {
  namedExports: {
    ...nativeExec,
    isLocal: () => false,
    execOnSlot: async (...args: unknown[]) => {
      calls.push(args);
      return result;
    },
  },
});
const { extractRunnerSessionUsage } = await import('./session-usage.js');

test('remote usage uses supported node execution and preserves slot support selection', async () => {
  const vars = { host: 'remote.example', machine: 'remote-test' } as SlotVars;
  const usage = await extractRunnerSessionUsage({
    slotId: 'slot-1',
    vars,
    runner: 'codex',
    runnerSessionPath: "/tmp/native session's.jsonl",
  });
  assert.equal(usage.turns, 3);
  assert.equal(usage.totalTokens, 124);
  assert.equal(calls[0][0], vars);
  assert.match(String(calls[0][1]), /bash ~\/farmslot-node\/scripts\/session-usage.sh/);
  assert.deepEqual(calls[0][2], {
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    selectNodeSupport: false,
  });
  result = { stdout: '', stderr: 'node transcript unavailable', exitCode: 1 };
  const failed = await extractRunnerSessionUsage({
    slotId: 'slot-1',
    vars,
    runner: 'codex',
    runnerSessionPath: '/tmp/native.jsonl',
  });
  assert.equal(failed.source, 'unavailable');
  assert.match(failed.error ?? '', /node transcript unavailable/);
  assert.equal(failed.turns, undefined);
});
