import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, fork } from 'node:child_process';
import { closeSync, constants, createReadStream, openSync, writeSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, test as nodeTest, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { execLocal, signalProcessGroup } from '../../core/exec.js';

import { ForkedBackgroundHost } from './client.js';
import type { FixtureCommand } from './command-groups.test-support.js';

// The background child runs every command in its own process group and owns it: however the child
// goes away, none of its commands may outlive it, and the supervisor never signals a group. When
// the child exits it kills its commands itself; when it is killed outright, its command watchdog
// does. Tests of the child's own cleanup start it with no watchdog (FIXTURE_NO_WATCHDOG), so only
// the child can have killed the command.
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
/**
 * A fixture child's environment and the FIFO its commands hold: they write their pids to it,
 * and `closed()` resolves once every one of them has exited. No deadline of its own: the
 * commands sleep 300 s, past the runner's 180 s file timeout, so only a kill ends them in time.
 */
function fixtureEnv(mode: string, extra: NodeJS.ProcessEnv = {}) {
  const fifo = path.join(directory, `pipe-${++fixtures}`);
  execFileSync('mkfifo', [fifo]);
  const stream = createReadStream(fifo, { encoding: 'utf8' });
  const lines = createInterface({ input: stream })[Symbol.asyncIterator]();
  after(() => {
    // Wake a read still waiting on commands that never wrote or never exited, then stop.
    let writer: number | undefined;
    try {
      writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      writeSync(writer, '\n');
    } catch (error) {
      // ENXIO: no reader was left. EPIPE: the reader closed as this wrote. The stream ended.
      if (
        (error as NodeJS.ErrnoException).code !== 'ENXIO' &&
        (error as NodeJS.ErrnoException).code !== 'EPIPE'
      )
        throw error;
    } finally {
      if (writer !== undefined) closeSync(writer);
    }
    stream.destroy();
  });
  const line = async () => {
    const next = await lines.next();
    if (next.done) throw new Error('the command pipe closed before the expected line');
    return next.value;
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extra,
    FIXTURE_MODE: mode,
    FIXTURE_PIPE: fifo,
    FARMSLOT_GATEWAY_BACKGROUND: '1',
  };
  return {
    fifo,
    env,
    line,
    /** The pids a hanging command wrote: the command (its group leader), then a descendant. */
    async pids(count = 2): Promise<number[]> {
      const found: number[] = [];
      while (found.length < count) found.push(Number(await line()));
      for (const pid of found) started.add(pid);
      return found;
    },
    async closed(): Promise<void> {
      while (!(await lines.next()).done);
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

/** Polls until `condition` holds; the runner's file timeout is the only bound. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await condition())) await new Promise((resolve) => setTimeout(resolve, 20));
}

function processes(): { pid: number; ppid: number; pgid: number; command: string }[] {
  return execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, pgid, ...command] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        command: command.join(' '),
      };
    });
}

/** The group's shells other than its leader: a per-command guard, which commands no longer get. */
function groupShells(leader: number): number[] {
  return processes()
    .filter((p) => p.pgid === leader && p.pid !== leader && p.command.startsWith('/bin/sh'))
    .map((p) => p.pid);
}

/** The command watchdog the child started: a shell reading its registrations. */
function watchdogs(child: number): number[] {
  return processes()
    .filter((p) => p.ppid === child && p.command.includes('while IFS= read -r l'))
    .map((p) => p.pid);
}

/**
 * Every test here waits on processes dying, with no deadline of its own: one that never dies
 * fails its test at this bound instead of taking the whole file down at the file timeout.
 */
function test(name: string, fn: (t: TestContext) => void | Promise<void>): void {
  nodeTest(name, { timeout: 60_000 }, fn);
}

const probe = { entries: [], ssh: [] };

/**
 * Returns once the child has registered its running commands with its watchdog. The child
 * registers a command in the same synchronous step that spawns it (and re-registers every command
 * in the step that starts a replacement watchdog), so a command can already be running, and
 * writing its pids, before its registration (core/exec.ts names this window). A reply to a later
 * request means the child's event loop has moved past that step.
 */
async function registered(background: ForkedBackgroundHost): Promise<void> {
  await background.request(
    'commands.read',
    { command: 'true', cwd: '/', timeout: 30_000 },
    { deadlineMs: 30_000 },
  );
}

/** No watchdog: only the child can kill its commands. */
const ownCleanup = { FIXTURE_NO_WATCHDOG: '1' };

test('a command run by the child answers exactly as without the child, and leaves no process', async () => {
  const compared: FixtureCommand[] = [
    { command: 'echo out; echo err >&2; exit 0', timeout: 30_000 },
    { command: 'echo out; exit 3', timeout: 30_000 },
    { command: 'echo before; kill -TERM $$', timeout: 30_000 },
    { command: 'exit 137', timeout: 30_000 },
    // The child's own timeout path: the same 124 and the same error text as today.
    { command: 'sleep 30', timeout: 300 },
  ];
  const out = path.join(directory, 'results.json');
  const fixture = fixtureEnv('results', { FIXTURE_OUT: out });
  fixture.env.FIXTURE_COMMANDS = JSON.stringify([
    ...compared,
    { command: `echo $$ > '${fixture.fifo}'`, timeout: 30_000 },
  ]);
  const background = host(fixture.env);
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
  // Nothing of the finished command's group remains.
  const [leader] = await fixture.pids(1);
  await until(() => !alive(-leader));
});

test('a command that survives TERM dies with a child SIGKILLed between its TERM and KILL', async (t) => {
  const groupSignals = watchGroupSignals(t);
  // The timeout sends TERM to the group after 300 ms; KILL would follow 30 s later.
  const fixture = fixtureEnv('resistant', {
    FIXTURE_TIMEOUT_MS: '300',
    FIXTURE_CLOSEOUT_MS: '30000',
  });
  const background = host(fixture.env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  const [leader] = await fixture.pids(1);
  assert.equal(await fixture.line(), 'term', 'the timeout TERM');
  // TERM reached the whole group, and the command lived through it. The group holds no guard
  // process; the watchdog sits outside it, so the group TERM did not reach it.
  assert.equal(alive(leader), true);
  assert.deepEqual(groupShells(leader), [], 'commands start no per-command guard');
  const child = background.status().pid;
  assert.ok(child);
  const [watchdog] = watchdogs(child);
  assert.ok(watchdog, 'the child runs one command watchdog');
  process.kill(child, 'SIGKILL');
  await assert.rejects(pending, /signal SIGKILL/);
  // The command, and every sleep it started, died by the watchdog.
  await fixture.closed();
  await until(() => !alive(watchdog));
  groupSignals();
});

test('an untimed command and its descendant die with a SIGKILLed child', async (t) => {
  const groupSignals = watchGroupSignals(t);
  const fixture = fixtureEnv('untimed');
  const background = host(fixture.env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  await fixture.pids();
  await registered(background);
  const child = background.status().pid;
  assert.ok(child);
  process.kill(child, 'SIGKILL');
  await assert.rejects(pending, /signal SIGKILL/);
  // The command and its descendant died by the watchdog.
  await fixture.closed();
  groupSignals();
});

test('a watchdog that dies is replaced, and the replacement still kills the commands', async (t) => {
  const groupSignals = watchGroupSignals(t);
  const fixture = fixtureEnv('untimed');
  const background = host(fixture.env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  await fixture.pids();
  const child = background.status().pid;
  assert.ok(child);
  const [first] = watchdogs(child);
  assert.ok(first, 'the child runs one command watchdog');
  process.kill(first, 'SIGKILL');
  let replacement: number | undefined;
  await until(() => {
    replacement = watchdogs(child).find((pid) => pid !== first);
    return replacement !== undefined;
  });
  assert.ok(replacement);
  // The child starts the replacement and registers the running command with it in one step.
  await registered(background);
  process.kill(child, 'SIGKILL');
  await assert.rejects(pending, /signal SIGKILL/);
  // The command and its descendant died by the replacement.
  await fixture.closed();
  await until(() => !alive(replacement!));
  groupSignals();
});

test('stopping the child kills the commands it is running at once', async (t) => {
  const groupSignals = watchGroupSignals(t);
  const fixture = fixtureEnv('hang', ownCleanup);
  const background = host(fixture.env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  const found = await fixture.pids();
  assert.equal(alive(found[0]), true);
  await background.stop();
  await assert.rejects(pending, /exited/);
  // Killed by the child itself: it runs no watchdog.
  await fixture.closed();
  groupSignals();
});

test('a command with no timeout is killed when the child stops', async (t) => {
  const groupSignals = watchGroupSignals(t);
  const fixture = fixtureEnv('untimed', ownCleanup);
  const background = host(fixture.env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  await fixture.pids();
  await background.stop();
  await assert.rejects(pending, /exited/);
  // Killed by the child itself: it runs no watchdog.
  await fixture.closed();
  groupSignals();
});

test('a child whose process exits kills its commands on the way out', async (t) => {
  const groupSignals = watchGroupSignals(t);
  const fixture = fixtureEnv('hang', ownCleanup);
  const background = host(fixture.env);
  background.start();
  const pending = background.request('fleet.probeMachine', probe, { deadlineMs: 120_000 });
  await fixture.pids();
  await assert.rejects(background.request('decisions.scan', {}, { deadlineMs: 120_000 }), /code 3/);
  await assert.rejects(pending, /exited \(code 3/);
  // Killed by the child itself: it runs no watchdog.
  await fixture.closed();
  groupSignals();
});

test('a child whose gateway disconnects kills its commands itself', async () => {
  const fixture = fixtureEnv('hang', ownCleanup);
  // No supervisor: only the child can clean up.
  const child: ChildProcess = fork(entry, [], {
    env: fixture.env,
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
  await fixture.pids();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.disconnect();
  await exited;
  // Killed by the child itself: it runs no watchdog.
  await fixture.closed();
});

// The spy above must be able to see a group signal from the supervisor.
test('the group-signal watch catches a process group signal', (t) => {
  const groupSignals = watchGroupSignals(t);
  assert.equal(signalProcessGroup(2 ** 22 + 12_345, 'SIGCONT'), false);
  assert.throws(groupSignals, /the supervisor signalled a process group/);
});
