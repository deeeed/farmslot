import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import type { Reaper } from '../lib/isolated-stack.mjs';

import type { CheckResult } from './outcome.mjs';
import {
  exitDifferences,
  killProofTree,
  processesUsing,
  proofEnv,
  reapProof,
  runProofs,
  dismissReaper,
  stopProofTree,
} from './proofs.mjs';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40 && alive(pid); attempt++) await delay(50);
  return !alive(pid);
}

function privateTmp(t: test.TestContext): string {
  const tmp = mkdtempSync('/tmp/fsp-test-');
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  return tmp;
}

test('a stopped proof takes the detached processes it started with it', async (t) => {
  const tmp = privateTmp(t);
  // A proof that starts a detached grandchild in its own group, as its gateway is started.
  const proof = spawn(
    process.execPath,
    [
      '-e',
      `const { spawn } = require('node:child_process');
       const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
       console.log(child.pid);
       setInterval(() => {}, 1000);`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let grandchild: number | undefined;
  t.after(() => {
    for (const pid of [proof.pid, grandchild])
      if (pid !== undefined && alive(pid)) process.kill(pid, 'SIGKILL');
  });
  grandchild = await Promise.race([
    new Promise<number>((resolve) =>
      proof.stdout.once('data', (chunk: Buffer) => resolve(Number(String(chunk).trim()))),
    ),
    delay(5_000, undefined, { ref: false }).then(() => {
      throw new Error('the proof did not report its grandchild');
    }),
  ]);
  assert.equal(alive(grandchild), true);
  assert.deepEqual(await killProofTree(proof.pid, tmp), []);
  assert.equal(await gone(grandchild), true, 'the detached grandchild died with the proof');
  assert.equal(await gone(proof.pid!), true);
});

test('a process that only holds a file under the proof TMPDIR is found and killed', async (t) => {
  const tmp = privateTmp(t);
  // Like a gateway that names its fixture only in its environment, with its log open there.
  const holder = spawn('sh', ['-c', `exec 3>'${tmp}/gateway.log'; sleep 60`], {
    detached: true,
    stdio: 'ignore',
  });
  t.after(() => {
    if (alive(holder.pid!)) process.kill(holder.pid!, 'SIGKILL');
  });
  for (let attempt = 0; attempt < 40 && !processesUsing(tmp).includes(holder.pid!); attempt++)
    await delay(50);
  assert.ok(processesUsing(tmp).includes(holder.pid!), 'lsof finds the open file');
  assert.deepEqual(await killProofTree(undefined, tmp), []);
  assert.equal(await gone(holder.pid!), true);
});

test('a proof gets no live farm path, test runner state or token from the canary', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      FARMSLOT_HOME: '/live/home',
      FARMSLOT_BACKLOG_FILE: '/live/backlog.json',
      GATEWAY_PORT: '7801',
      TSX_TSCONFIG_PATH: 'services/gateway/tsconfig.json',
      NODE_TEST_CONTEXT: '1',
      TMUX: '/tmp/tmux-live',
      GH_TOKEN: 'secret',
      LITELLM_API_KEY: 'secret',
      CODEX_LB_API_KEY: 'lb-key',
    });
    const env = proofEnv('/tmp/fsp-x', { FARMSLOT_WARM_PROOF_MODEL: 'model' });
    for (const key of [
      'FARMSLOT_HOME',
      'FARMSLOT_BACKLOG_FILE',
      'GATEWAY_PORT',
      'TSX_TSCONFIG_PATH',
      'NODE_TEST_CONTEXT',
      'TMUX',
      'GH_TOKEN',
      'LITELLM_API_KEY',
    ])
      assert.equal(env[key], undefined, key);
    assert.equal(env.CODEX_LB_API_KEY, 'lb-key', 'the reviewer reaches its model through the LB');
    assert.equal(env.TMPDIR, '/tmp/fsp-x');
    assert.equal(env.FARMSLOT_WARM_PROOF_MODEL, 'model', 'the proof spec sets its own');
    assert.equal(env.PATH, saved.PATH);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('a proof killed by a signal is not reported as a timeout', () => {
  assert.deepEqual(exitDifferences({ code: 0, signal: null, timedOut: false }), []);
  assert.deepEqual(exitDifferences({ code: 3, signal: null, timedOut: false }), ['exited 3']);
  assert.deepEqual(exitDifferences({ code: null, signal: 'SIGSEGV', timedOut: false }), [
    'killed by SIGSEGV',
  ]);
  assert.deepEqual(exitDifferences({ code: null, signal: 'SIGKILL', timedOut: true }, 60_000), [
    'did not finish within 60 s',
  ]);
});

function fakeReaper() {
  const entries: Array<{ kind: string; value: unknown }> = [];
  const reaper: Reaper = {
    group: (pid) => entries.push({ kind: 'group', value: pid }),
    command: (argv, env) => entries.push({ kind: 'command', value: { argv, env } }),
    path: (value) => entries.push({ kind: 'path', value }),
    done: () => entries.push({ kind: 'done', value: undefined }),
  };
  return { reaper, entries };
}

async function proofsRun(
  t: test.TestContext,
  options: {
    argv: string[];
    timeoutMs?: number;
    cleaning?: () => boolean;
    removeTemp?: (tmp: string) => Promise<void>;
    killTree?: typeof killProofTree;
  },
) {
  const evidence = mkdtempSync('/tmp/fsp-test-evidence-');
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  const checks: CheckResult[] = [];
  const { reaper, entries } = fakeReaper();
  // Should the code under test fail to stop a proof, the test still leaves nothing running.
  t.after(() => {
    for (const { kind, value } of entries)
      if (kind === 'group' && typeof value === 'number')
        for (const target of [-value, value])
          try {
            process.kill(target, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
  });
  await runProofs({
    root: process.cwd(),
    evidence,
    reviewModel: 'unused',
    reaper,
    proofs: ['node-handshake'],
    cleaning: options.cleaning ?? (() => false),
    onCleanup: () => {},
    log: async () => {},
    onCheck: (check) => checks.push(check),
    seams: {
      spec: () => ({ argv: options.argv, model: 'none' }),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.removeTemp ? { removeTemp: options.removeTemp } : {}),
      ...(options.killTree ? { killTree: options.killTree } : {}),
    },
  });
  return { checks, entries };
}

// A short deadline; exitDifferences reports it in whole seconds.
const DEADLINE_MS = 500;
const deadlineDifference = `did not finish within ${Math.round(DEADLINE_MS / 1000)} s`;

test(
  'a proof past its deadline is killed and reported as a timeout',
  { timeout: 10_000 },
  async (t) => {
    const { checks } = await proofsRun(t, {
      argv: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: DEADLINE_MS,
    });
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'fail');
    assert.deepEqual(checks[0].differences, [deadlineDifference]);
  },
);

test('a TMPDIR that cannot be removed is noted on the check, not lost with it', async (t) => {
  const kept: string[] = [];
  t.after(() => {
    for (const tmp of kept) rmSync(tmp, { recursive: true, force: true });
  });
  const { checks } = await proofsRun(t, {
    argv: ['-e', ''],
    removeTemp: async (tmp) => {
      kept.push(tmp);
      throw new Error('ENOTEMPTY');
    },
  });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'pass');
  assert.ok(checks[0].observations.some((line) => /could not remove .*ENOTEMPTY/.test(line)));
});

test('no proof starts once cleanup has begun', { timeout: 10_000 }, async (t) => {
  // Cleanup begins after the first check of the loop, while the proof is being set up.
  let calls = 0;
  const { checks } = await proofsRun(t, {
    argv: ['-e', 'setInterval(() => {}, 1000)'],
    cleaning: () => calls++ > 0,
    // Were it to start, it fails quickly rather than running to the default deadline.
    timeoutMs: DEADLINE_MS,
  });
  assert.deepEqual(checks, []);
});

test(
  'a proof whose tree cannot be read is still killed at its deadline',
  { timeout: 10_000 },
  async (t) => {
    const { checks } = await proofsRun(t, {
      argv: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: DEADLINE_MS,
      killTree: async () => {
        throw new Error('ps: EAGAIN');
      },
    });
    assert.equal(checks.length, 1);
    assert.ok(checks[0].differences.includes(deadlineDifference));
    assert.ok(checks[0].differences.some((line) => /timeout kill failed: .*EAGAIN/.test(line)));
    assert.ok(checks[0].differences.some((line) => /could not stop .*EAGAIN/.test(line)));
  },
);

test('a failed stop is a cleanup error, not a lost result', async () => {
  const errors = await stopProofTree(undefined, '/tmp/fsp-x', async () => {
    throw new Error('lsof: not found');
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not stop the proof's processes under \/tmp\/fsp-x: .*lsof/);
});

test('the sweep keeps killing until nothing uses the TMPDIR', async (t) => {
  const tmp = privateTmp(t);
  // A gateway shutting down starts a child after the first scan; the third scan finds none.
  const scans = [[2 ** 22 + 1], [2 ** 22 + 2], []];
  let calls = 0;
  const survived = await killProofTree(undefined, tmp, () => scans[Math.min(calls++, 2)]);
  assert.deepEqual(survived, []);
  assert.equal(calls, 3, 'scanned again after each kill until empty');
});

test('the reaper can stop and remove a proof the canary did not clean up', () => {
  const { reaper, entries } = fakeReaper();
  reapProof(reaper, '/tmp/fsp-reap');
  const commands = entries.filter((entry) => entry.kind === 'command');
  assert.equal(commands.length, 2);
  for (const { value } of commands) {
    const { env } = value as { env: NodeJS.ProcessEnv };
    // The reaper runs them with only this environment; lsof is in /usr/sbin.
    assert.match(env.PATH ?? '', /(^|:)\/usr\/sbin(:|$)/);
  }
  assert.deepEqual(
    entries.filter((entry) => entry.kind === 'path'),
    [{ kind: 'path', value: '/tmp/fsp-reap' }],
  );
});

test('the reaper stays armed unless every stop was clean', () => {
  for (const [errors, dismissed] of [
    [[[], []], true],
    [[[], ['proof processes survived SIGKILL under /tmp/fsp-x: 4242']], false],
    [[["could not stop the proof's processes under /tmp/fsp-x: ps: EAGAIN"], []], false],
  ] as const) {
    const { reaper, entries } = fakeReaper();
    assert.equal(dismissReaper(reaper, ...errors), dismissed);
    assert.equal(
      entries.some((entry) => entry.kind === 'done'),
      dismissed,
      JSON.stringify(errors),
    );
  }
});
