import assert from 'node:assert/strict';
import { type ChildProcess, fork } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { execLocal, signalProcessGroup } from '../../core/exec.js';

import { ForkedBackgroundHost } from './client.js';
import type { FixtureCommand } from './command-groups.test-support.js';

// The background child runs every command in its own process group and owns it: however the child
// goes away, none of its commands may outlive it, and the supervisor never signals a group.
const entry = fileURLToPath(new URL('./command-groups.test-support.ts', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'background-groups-'));
after(() => rm(directory, { recursive: true, force: true }));

/** Every command pid this file started; killed on every exit path, by group or else alone. */
const started = new Set<number>();
after(() => {
  for (const pid of started) {
    if (signalProcessGroup(pid, 'SIGKILL')) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      // Already exited: nothing to clean up.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
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

/** Killed by the child itself, so at once: well before any watchdog could act. */
async function goneAtOnce(found: number[], cause: string): Promise<void> {
  for (const pid of found) await until(() => !alive(pid), `${pid} to die after ${cause}`, 5_000);
}

const probe = { entries: [], ssh: [] };

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
  // The watchdog leaves with its command: nothing of the group remains.
  const [leader] = await pids(strayFile, 1);
  await until(() => {
    try {
      process.kill(-leader, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw error;
    }
  }, 'the finished command group to empty');
});

test('a command outlives a SIGKILLed child only until its timeout and grace', async (t) => {
  const groupSignals = watchGroupSignals(t);
  // Watchdog after ceil((1 500 + 200 closeout + 200 grace) / 1 000) = 2 s.
  const timeoutMs = 1_500;
  const { env, pidFile } = fixtureEnv('hang', { FIXTURE_TIMEOUT_MS: String(timeoutMs) });
  const background = host(env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  const found = await pids(pidFile);
  const startedAt = Date.now();
  const child = background.status().pid;
  assert.ok(child);
  process.kill(child, 'SIGKILL');
  await assert.rejects(pending, /signal SIGKILL/);
  // Killed before the command's own timeout: from here only its watchdog can stop it.
  assert.ok(Date.now() - startedAt < timeoutMs, 'the child died before the timeout');
  assert.equal(alive(found[0]), true);
  for (const pid of found) await until(() => !alive(pid), `${pid} to die by its watchdog`, 6_000);
  groupSignals();
});

test('stopping the child kills the commands it is running at once', async (t) => {
  const groupSignals = watchGroupSignals(t);
  const { env, pidFile } = fixtureEnv('hang');
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
  const { env, pidFile } = fixtureEnv('untimed');
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
  const { env, pidFile } = fixtureEnv('hang');
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
  const { env, pidFile } = fixtureEnv('hang');
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
