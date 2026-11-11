import assert from 'node:assert/strict';
import { type ChildProcess, fork } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { signalProcessGroup } from '../../core/exec.js';

import { ForkedBackgroundHost } from './client.js';

// Commands the background child starts run in their own process groups, whose timeouts the child
// owns. However the child goes away, none of those commands may outlive it.
const entry = fileURLToPath(new URL('./command-groups.test-support.ts', import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), 'background-groups-'));
after(() => rm(directory, { recursive: true, force: true }));

/** Every command pid this file started; killed (by group) on every exit path. */
const started = new Set<number>();
after(() => {
  for (const pid of started) signalProcessGroup(pid, 'SIGKILL');
});

let fixtures = 0;
function fixtureEnv(): { env: NodeJS.ProcessEnv; pidFile: string } {
  const pidFile = path.join(directory, `pids-${++fixtures}`);
  return {
    pidFile,
    env: { ...process.env, FIXTURE_PID_FILE: pidFile, FARMSLOT_GATEWAY_BACKGROUND: '1' },
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function pids(pidFile: string, count: number): Promise<number[]> {
  let found: number[] = [];
  await until(async () => {
    const text = await readFile(pidFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
      // The command has not written its pid yet.
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    found = text.split('\n').filter(Boolean).map(Number);
    return found.length >= count;
  }, `${count} running command(s)`);
  for (const pid of found) started.add(pid);
  return found;
}

const probe = { entries: [], ssh: [] };

test('stopping the child kills the commands it is running', async () => {
  const { env, pidFile } = fixtureEnv();
  const background = host(env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  const [pid] = await pids(pidFile, 1);
  assert.equal(alive(pid), true);
  await background.stop();
  await assert.rejects(pending, /exited/);
  await until(() => !alive(pid), 'the command to die after stop');
});

test('a child whose gateway disconnects kills its commands itself', async () => {
  const { env, pidFile } = fixtureEnv();
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
  const [pid] = await pids(pidFile, 1);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.disconnect();
  await exited;
  await until(() => !alive(pid), 'the command to die after the disconnect');
});

test('a child killed by the wedge detector leaves no command behind', async () => {
  const { env, pidFile } = fixtureEnv();
  const background = host(env);
  background.start();
  // Two probes that never answer in time: the second missed deadline SIGKILLs the child.
  const first = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  const [pid] = await pids(pidFile, 1);
  await assert.rejects(
    background.request('fleet.probeMachine', probe, { deadlineMs: 50 }),
    /did not answer/,
  );
  await assert.rejects(
    background.request('fleet.probeMachine', probe, { deadlineMs: 50 }),
    /did not answer/,
  );
  await assert.rejects(first, /exited \(code null, signal SIGKILL\)/);
  assert.equal(background.status().lastExit?.signal, 'SIGKILL');
  await until(() => !alive(pid), 'the command to die after SIGKILL');
});

test('a child that crashes leaves no command behind', async () => {
  const { env, pidFile } = fixtureEnv();
  const background = host(env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  const [pid] = await pids(pidFile, 1);
  await assert.rejects(background.request('decisions.scan', {}, { deadlineMs: 120_000 }), /code 3/);
  await assert.rejects(pending, /exited \(code 3/);
  await until(() => !alive(pid), 'the command to die after the crash');
});
