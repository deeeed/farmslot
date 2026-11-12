import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, fork } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { execLocal, signalProcessGroup } from '../../core/exec.js';

import { ForkedBackgroundHost } from './client.js';
import type { FixtureCommand } from './command-groups.test-support.js';

// The background child runs every command in its own process group and owns it: however the child
// goes away, none of its commands may outlive it, and the supervisor never signals a group. When
// the child exits it kills its commands itself; when it is killed outright, each command's guard
// does, within about a second. Tests of the child's own cleanup point the guards at this process
// (FIXTURE_GUARD_OWNER), so only the child can have killed the command.
const entry = fileURLToPath(new URL('./command-groups.test-support.ts', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'background-groups-'));
after(() => rm(directory, { recursive: true, force: true }));

/** Every command pid this file started; killed on every exit path, by group or else alone. */
const started = new Set<number>();
after(() => {
  for (const pid of started)
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch (error) {
        // Gone, or only an adopted zombie is left (see alive()): nothing of ours to clean up.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH' && code !== 'EPERM') throw error;
      }
    }
});

let fixtures = 0;
function fixtureEnv(
  mode: string,
  extra: NodeJS.ProcessEnv = {},
): { env: NodeJS.ProcessEnv; pidFile: string } {
  const pidFile = path.join(directory, `pids-${++fixtures}`);
  return {
    pidFile,
    env: {
      ...process.env,
      ...extra,
      FIXTURE_MODE: mode,
      FIXTURE_PID_FILE: pidFile,
      FARMSLOT_GATEWAY_BACKGROUND: '1',
    },
  };
}

function host(env: NodeJS.ProcessEnv): ForkedBackgroundHost {
  const instance = new ForkedBackgroundHost({
    entry,
    execArgv: ['--import', 'tsx'],
    env,
    // A restarted child would start nothing here; keep it from restarting during the test.
    restartDelaysMs: [600_000],
    shutdownGraceMs: 2_000,
  });
  after(() => instance.stop());
  return instance;
}

/** process.kill calls this test makes (the supervisor runs in this process); none may name a group. */
function watchGroupSignals(t: TestContext): () => void {
  const kill = t.mock.method(process, 'kill');
  return () =>
    assert.deepEqual(
      kill.mock.calls.filter((call) => Number(call.arguments[0]) < 0).map((call) => call.arguments),
      [],
      'the supervisor signalled a process group',
    );
}

/** Whether `target` (a pid, or a negated group id) still names a live process of ours. */
function alive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    // ESRCH: none left. EPERM: only a process we may not signal, which is none of ours: macOS
    // reports it for a zombie launchd has adopted but not yet reaped.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw error;
  }
}

async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  ceilingMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + ceilingMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readOptional(file: string): Promise<string> {
  return readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    // Not written yet.
    if (error.code === 'ENOENT') return '';
    throw error;
  });
}

/** The pids a hanging command wrote: the command (its group leader) and a descendant. */
async function pids(pidFile: string, count = 2): Promise<number[]> {
  let found: number[] = [];
  await until(async () => {
    found = (await readOptional(pidFile)).split('\n').filter(Boolean).map(Number);
    return found.length >= count;
  }, `${count} running process(es)`);
  for (const pid of found) started.add(pid);
  return found;
}

/** The group's processes other than its leader and the leader's own children: the guard. */
function guards(leader: number): number[] {
  return execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([pid, , pgid, command]) =>
        Number(pgid) === leader && Number(pid) !== leader && command === '/bin/sh',
    )
    .map(([pid]) => Number(pid));
}

/** Killed by the child itself (the guards watch this process), within the 5 s ceiling. */
async function goneAtOnce(found: number[], cause: string): Promise<void> {
  for (const pid of found) await until(() => !alive(pid), `${pid} to die after ${cause}`, 5_000);
}

const probe = { entries: [], ssh: [] };
/** The guards watch this process, which outlives the child: only the child can kill its commands. */
const ownCleanup = { FIXTURE_GUARD_OWNER: String(process.pid) };

test('a command run by the child answers exactly as without the child, and leaves no process', async () => {
  const strayFile = path.join(directory, 'stray');
  const compared: FixtureCommand[] = [
    { command: 'echo out; echo err >&2; exit 0', timeout: 30_000 },
    { command: 'echo out; exit 3', timeout: 30_000 },
    { command: 'echo before; kill -TERM $$', timeout: 30_000 },
    { command: 'exit 137', timeout: 30_000 },
    // The child's own timeout path: the same 124 and the same error text as today.
    { command: 'sleep 30', timeout: 300 },
  ];
  const out = path.join(directory, 'results.json');
  const { env } = fixtureEnv('results', {
    FIXTURE_OUT: out,
    FIXTURE_COMMANDS: JSON.stringify([
      ...compared,
      { command: `echo $$ >> '${strayFile}'`, timeout: 30_000 },
    ]),
  });
  const background = host(env);
  background.start();
  await background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  const results = JSON.parse(await readFile(out, 'utf8'));
  // This process has no command owner: commands start as they always have.
  const expected = [];
  for (const { command, timeout } of compared)
    expected.push(await execLocal(command, { timeout, closeoutTimeoutMs: 200 }));
  assert.deepEqual(results.slice(0, compared.length), expected);
  assert.equal(expected[2].exitCode, 1, 'a signalled command reads as exit 1');
  assert.equal(expected[4].exitCode, 124);
  // The guard leaves with its command: nothing of the group remains.
  const [leader] = await pids(strayFile, 1);
  await until(() => !alive(-leader), 'the finished command group to empty');
});

test('a command that survives TERM dies with a child SIGKILLed between its TERM and KILL', async (t) => {
  const groupSignals = watchGroupSignals(t);
  // The timeout sends TERM to the group after 300 ms; KILL would follow 30 s later.
  const { env, pidFile } = fixtureEnv('resistant', {
    FIXTURE_TIMEOUT_MS: '300',
    FIXTURE_CLOSEOUT_MS: '30000',
  });
  const background = host(env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  const [leader] = await pids(pidFile, 1);
  await until(async () => (await readOptional(`${pidFile}.term`)) !== '', 'the timeout TERM');
  // TERM reached the whole group: the command lived through it, and so did its guard.
  assert.equal(alive(leader), true);
  assert.equal(guards(leader).length, 1, 'the guard survives the group TERM');
  const child = background.status().pid;
  assert.ok(child);
  process.kill(child, 'SIGKILL');
  await assert.rejects(pending, /signal SIGKILL/);
  await until(() => !alive(leader), 'the command to die by its guard', 5_000);
  groupSignals();
});

test('an untimed command and its descendant die with a SIGKILLed child', async (t) => {
  const groupSignals = watchGroupSignals(t);
  const { env, pidFile } = fixtureEnv('untimed');
  const background = host(env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  const found = await pids(pidFile);
  const child = background.status().pid;
  assert.ok(child);
  process.kill(child, 'SIGKILL');
  await assert.rejects(pending, /signal SIGKILL/);
  for (const pid of found) await until(() => !alive(pid), `${pid} to die by its guard`, 5_000);
  groupSignals();
});

test('stopping the child kills the commands it is running at once', async (t) => {
  const groupSignals = watchGroupSignals(t);
  const { env, pidFile } = fixtureEnv('hang', ownCleanup);
  const background = host(env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  const found = await pids(pidFile);
  assert.equal(alive(found[0]), true);
  await background.stop();
  await assert.rejects(pending, /exited/);
  await goneAtOnce(found, 'stop');
  groupSignals();
});

test('a command with no timeout is killed when the child stops', async (t) => {
  const groupSignals = watchGroupSignals(t);
  const { env, pidFile } = fixtureEnv('untimed', ownCleanup);
  const background = host(env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  const found = await pids(pidFile);
  await background.stop();
  await assert.rejects(pending, /exited/);
  await goneAtOnce(found, 'stop');
  groupSignals();
});

test('a child whose process exits kills its commands on the way out', async (t) => {
  const groupSignals = watchGroupSignals(t);
  const { env, pidFile } = fixtureEnv('hang', ownCleanup);
  const background = host(env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  const found = await pids(pidFile);
  await assert.rejects(background.request('decisions.scan', {}, { deadlineMs: 120_000 }), /code 3/);
  await assert.rejects(pending, /exited \(code 3/);
  await goneAtOnce(found, 'process.exit');
  groupSignals();
});

test('a child whose gateway disconnects kills its commands itself', async () => {
  const { env, pidFile } = fixtureEnv('hang', ownCleanup);
  // No supervisor: only the child can clean up.
  const child: ChildProcess = fork(entry, [], {
    env,
    execArgv: ['--import', 'tsx'],
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await new Promise<void>((resolve, reject) => {
    child.on('message', (message: { type: string }) => {
      if (message.type === 'ready') resolve();
    });
    child.once('exit', (code) => reject(new Error(`child exited before ready (code ${code})`)));
  });
  child.send({ type: 'request', id: 1, operation: 'fleet.probeMachine', params: probe });
  const found = await pids(pidFile);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.disconnect();
  await exited;
  await goneAtOnce(found, 'the disconnect');
});

// The spy above must be able to see a group signal from the supervisor.
test('the group-signal watch catches a process group signal', (t) => {
  const groupSignals = watchGroupSignals(t);
  assert.equal(signalProcessGroup(2 ** 22 + 12_345, 'SIGCONT'), false);
  assert.throws(groupSignals, /the supervisor signalled a process group/);
});
