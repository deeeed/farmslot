import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { exitDifferences, killProofTree, processesUsing, proofEnv } from './proofs.mjs';

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
  const grandchild = await new Promise<number>((resolve) =>
    proof.stdout.once('data', (chunk: Buffer) => resolve(Number(String(chunk).trim()))),
  );
  t.after(() => {
    for (const pid of [proof.pid!, grandchild]) if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
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
    'did not finish within 1 min',
  ]);
});
