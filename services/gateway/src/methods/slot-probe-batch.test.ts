import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parseSlotProbeOutput, slotProbeScript } from './slot-probe-batch.js';

const run = promisify(execFile);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: the process is gone, which is what these tests wait for.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};
const pidFile = (t: test.TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'slot-probe-batch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'pid');
};
const readPid = async (file: string) => {
  for (let i = 0; i < 100; i += 1) {
    const text = readFileSync(file, { encoding: 'utf8', flag: 'a+' }).trim();
    if (text) return Number(text);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no pid in ${file}`);
};
const gone = async (pid: number) => {
  for (let i = 0; i < 100 && alive(pid); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return !alive(pid);
};
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

  test(
    `one ${shell[0]} kills a timed-out probe's grandchildren`,
    { timeout: 10_000 },
    async (t) => {
      const file = pidFile(t);
      // probe subshell -> sh -> sleep: the sleep is a grandchild of the probe.
      const probe = `sh -c 'sleep 30 & echo $! >${file}; wait'`;
      const { stdout } = await run(shell[0], [...shell.slice(1), slotProbeScript([probe], 0.3)]);
      assert.deepEqual(parseSlotProbeOutput(stdout, 1), [undefined]);
      const grandchild = await readPid(file);
      t.after(() => alive(grandchild) && process.kill(grandchild, 'SIGKILL'));
      assert.equal(await gone(grandchild), true, 'the grandchild died with its probe');
    },
  );

  test(
    `one ${shell[0]} terminated mid-batch kills a probe that ignores SIGTERM`,
    { timeout: 10_000 },
    async (t) => {
      const file = pidFile(t);
      const probe = `sh -c 'trap "" TERM; echo $$ >${file}; while :; do sleep 1; done'`;
      const batch = spawn(shell[0], [...shell.slice(1), slotProbeScript([probe], 30)], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const output = new Promise<void>((resolve) => batch.stdout.on('close', resolve));
      const resistant = await readPid(file);
      t.after(() => alive(resistant) && process.kill(resistant, 'SIGKILL'));
      batch.kill('SIGTERM');
      await output;
      assert.equal(await gone(resistant), true, 'the resistant probe died with its batch');
    },
  );
}

test('a probe the batch never reported reads as unavailable', () => {
  assert.deepEqual(parseSlotProbeOutput('', 2), [undefined, undefined]);
});
