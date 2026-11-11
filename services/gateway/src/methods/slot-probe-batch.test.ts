import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseSlotProbeOutput, slotProbeScript } from './slot-probe-batch.js';

const run = promisify(execFile);
const probes = [
  'echo out; echo err >&2; exit 3',
  "printf 'two\\nlines'",
  'sleep 5; echo late',
  `test -f /no-such-file && echo yes || echo 'quoted "and" it'"'"'s'`,
];

// Slot commands run under bash, or zsh -f for macOS nodes on the node link, or sh.
for (const shell of [
  ['/bin/bash', '--noprofile', '--norc', '-c'],
  ['/bin/zsh', '-f', '-c'],
  ['/bin/sh', '-c'],
]) {
  test(`one ${shell[0]} reports each probe and times out only the slow one`, async () => {
    const started = Date.now();
    const { stdout } = await run(shell[0], [...shell.slice(1), slotProbeScript(probes, 0.3)]);
    assert.ok(Date.now() - started < 3_000, 'the slow probe is stopped at the deadline');
    assert.deepEqual(parseSlotProbeOutput(stdout, probes.length), [
      { stdout: 'out\n', stderr: 'err\n', exitCode: 3 },
      { stdout: 'two\nlines', stderr: '', exitCode: 0 },
      undefined,
      { stdout: `quoted "and" it's\n`, stderr: '', exitCode: 0 },
    ]);
  });
}

test('a probe the batch never reported reads as unavailable', () => {
  assert.deepEqual(parseSlotProbeOutput('', 2), [undefined, undefined]);
});
