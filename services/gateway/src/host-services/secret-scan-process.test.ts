import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import secretScan from './secret-scan.js';

const secret = `private_key = ${'1'.repeat(64)}`;
const childEntry = fileURLToPath(new URL('./secret-scan-child.ts', import.meta.url));
// A scan or exit that never settles is the failure these tests guard against.
const settles = { timeout: 30_000 };
let unique = 0;
/** A clean log large enough that its scan is still running when the test acts. */
const largeCleanLog = () => `run ${unique++}\n${'clean diagnostic line\n'.repeat(250_000)}`;

/** Pids of this process's scan children. */
function scanChildren(): number[] {
  return execFileSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([, ppid, ...command]) =>
        Number(ppid) === process.pid && command.join(' ').includes('secret-scan-child'),
    )
    .map(([pid]) => Number(pid));
}

async function poll<T>(read: () => T, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    assert(Date.now() < deadline, what);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

after(async () => {
  await secretScan.stop();
  for (const pid of scanChildren()) process.kill(pid, 'SIGKILL');
});

test(
  'a scan process killed mid-scan refuses that scan and the next scan starts a new one',
  settles,
  async () => {
    const pending = secretScan.publication(largeCleanLog());
    const refused = assert.rejects(pending, /exited with code SIGKILL/);
    const [killed] = await poll(
      scanChildren,
      (pids) => pids.length === 1,
      'the scan process started',
    );
    assert.ok(killed !== undefined);
    process.kill(killed, 'SIGKILL');
    await refused;
    assert.deepEqual(
      (await secretScan.publication(secret)).map((hit) => hit.kind),
      ['private-key'],
    );
    const [next] = scanChildren();
    assert.ok(next !== undefined && next !== killed, 'a new scan process answered');
  },
);

test('stopping during a scan refuses it and ends the scan process', settles, async () => {
  const refused = assert.rejects(secretScan.publication(largeCleanLog()), /stopped/);
  await poll(scanChildren, (pids) => pids.length === 1, 'the scan process is running');
  await secretScan.stop();
  await refused;
  await poll(scanChildren, (pids) => pids.length === 0, 'the scan process exited');
});

test('the scan process exits when the gateway channel disconnects', settles, async () => {
  const child = fork(childEntry, [], {
    execArgv: process.execArgv,
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  try {
    const reply = await new Promise((resolve) => {
      child.once('message', resolve);
      child.send({ id: 1, texts: ['clean'] });
    });
    assert.deepEqual(reply, { id: 1, hits: [] });
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.disconnect();
    assert.equal(await exited, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
