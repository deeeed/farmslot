import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import type { ProjectVars, RawProjectJson, SlotVars } from '../../core/config.js';
await import('../../runtime/mock-pty.test-support.js');
const { assertSlotHealthForRecipeRerun } = await import('../recipe.js');

const {
  checkDefaultBranch,
  checkHealth,
  checkRunnerLaunch,
  isOptionalFixtureAbsence,
  runHealthCheck,
  runUnlockHook,
} = await import('./check.js');
const { verifyPrepareHealth } = await import('./prepare.js');
const { probeDefaultBranch } = await import('./slot-tracking.js');
const { checkPrepareRequirement } = await import('./prepare-profile.js');

function makeSlotVars(remoteRepo: string): SlotVars {
  return {
    slotId: 'health-test',
    machine: os.hostname(),
    platform: 'ios',
    host: 'localhost',
    sshUser: 'test',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: remoteRepo,
    session: 'health-test',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: '',
    remoteRepo,
    projectName: 'health-test',
    resourceVars: {},
  };
}

test('runHealthCheck ignores stdout from failed health commands', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'farmslot-health-'));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const result = await runHealthCheck(
    makeSlotVars(repo),
    `printf '%s\\n' '{"ready":true,"route":"WalletView"}'; exit 7`,
    'python3 -c "import json,sys; print(json.load(sys.stdin).get(\\"route\\", \\"\\"))"',
  );

  assert.equal(result, '');
});

test('runUnlockHook reports a failed unlock with its exit code and output tail', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'farmslot-unlock-'));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  const vars = makeSlotVars(repo);

  assert.equal(await runUnlockHook(vars, 'echo unlocked'), null);
  assert.equal(
    await runUnlockHook(vars, `printf '%s\\n' one two three 'call x: fail'; exit 4`),
    'unlock hook exited 4: two | three | call x: fail',
  );
});

// Health reads a state file the unlock hook may flip; the slot is ready when it says OK.
const HEALTH_HOOK = 'cat state';
const UNLOCKS = {
  // The unlock call loses a race (sandbox busy) while the app reaches ready on its own.
  failsButReady: "printf OK > state; echo 'checkout sandbox is busy'; exit 4",
  failsStillDown: "echo 'unlock failed (exit 1, APP_LOGIC_FAILURE): Timed out'; exit 1",
  succeeds: 'printf OK > state',
} as const;

async function lockedSlot(t: { after: (fn: () => Promise<void>) => void }) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'farmslot-unlock-health-'));
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
  });
  await writeFile(path.join(repo, 'state'), 'LOCKED');
  return makeSlotVars(repo);
}

function projectWithUnlock(unlock: string): RawProjectJson {
  return {
    hooks: { health_check: HEALTH_HOOK, unlock },
    health: { ready_indicator: 'OK' },
  } as unknown as RawProjectJson;
}

const NO_PROJECT_VARS = undefined as unknown as ProjectVars;

// Each case owns its slot dir, and the unlock settle waits are real, so run them side by side.
describe('unlock hook and health re-check', { concurrency: true }, () => {
  test('checkHealth re-reads health after a failed unlock and passes when ready', async (t) => {
    const vars = await lockedSlot(t);
    const progress: unknown[] = [];
    const step = await checkHealth(
      vars,
      projectWithUnlock(UNLOCKS.failsButReady),
      undefined,
      'OK',
      '',
      { onProgress: (p) => progress.push(p) },
    );
    assert.deepEqual(step, { name: 'health', status: 'pass', detail: 'Health after unlock — OK' });
    // Streaming clients (CLI no-activity timeout) see a step before the unlock runs.
    assert.deepEqual(progress, [
      {
        name: 'health',
        status: 'warn',
        detail: 'Health not ready (value=LOCKED) — trying unlock...',
      },
    ]);
  });

  test('checkHealth heartbeats through the unlock and re-read, and stops when it returns', async (t) => {
    const vars = await lockedSlot(t);
    const heartbeatMs = 200;
    const heartbeats: { at: number; detail: string }[] = [];
    // The hook records when it exits, so the assertions use time, not tick counts.
    const unlock = `sleep 1; printf OK > state; node -e "require('fs').writeFileSync('unlock-exited-at', String(Date.now()))"`;
    const step = await checkHealth(vars, projectWithUnlock(unlock), undefined, 'OK', '', {
      onProgress: (p) => {
        if (p.detail !== 'Health not ready (value=LOCKED) — trying unlock...') {
          heartbeats.push({ at: Date.now(), detail: p.detail });
        }
      },
      heartbeatMs,
    });
    const returnedAt = Date.now();
    assert.deepEqual(step, { name: 'health', status: 'pass', detail: 'Health after unlock — OK' });
    const unlockExitedAt = Number(
      await readFile(path.join(vars.remoteRepo, 'unlock-exited-at'), 'utf8'),
    );

    assert.ok(
      heartbeats.some(
        (h) => h.at < unlockExitedAt && h.detail.startsWith('Unlock still running ('),
      ),
      `expected a heartbeat while the unlock ran: ${JSON.stringify(heartbeats)}`,
    );
    // The 3 s settle wait and health re-read after the hook stay covered too.
    assert.ok(
      heartbeats.some(
        (h) =>
          h.at > unlockExitedAt + heartbeatMs &&
          h.detail.startsWith('Re-checking health after unlock ('),
      ),
      `expected a heartbeat after the unlock exited: ${JSON.stringify(heartbeats)}`,
    );
    // Nothing fires once checkHealth has returned.
    await new Promise((r) => setTimeout(r, heartbeatMs * 3));
    const late = heartbeats.filter((h) => h.at > returnedAt);
    assert.deepEqual(late, [], 'heartbeat kept running after checkHealth returned');
  });

  test('checkHealth appends the unlock failure when health stays down', async (t) => {
    const vars = await lockedSlot(t);
    const step = await checkHealth(
      vars,
      projectWithUnlock(UNLOCKS.failsStillDown),
      undefined,
      'OK',
      '',
    );
    assert.equal(step?.status, 'fail');
    assert.equal(
      step?.detail,
      'Health responds but value=LOCKED (expected OK); unlock hook exited 1: unlock failed (exit 1, APP_LOGIC_FAILURE): Timed out',
    );
  });

  test('recipe replay health re-reads after a failed unlock and passes when ready', async (t) => {
    const vars = await lockedSlot(t);
    await assertSlotHealthForRecipeRerun(
      vars,
      projectWithUnlock(UNLOCKS.failsButReady),
      NO_PROJECT_VARS,
    );
  });

  test('recipe replay health reports the unlock failure when health stays down', async (t) => {
    const vars = await lockedSlot(t);
    await assert.rejects(
      assertSlotHealthForRecipeRerun(
        vars,
        projectWithUnlock(UNLOCKS.failsStillDown),
        NO_PROJECT_VARS,
      ),
      /health=LOCKED, expected OK; unlock hook exited 1: unlock failed \(exit 1, APP_LOGIC_FAILURE\): Timed out\)/,
    );
  });

  test('prepare health passes after a successful unlock and after a failed one when ready', async (t) => {
    for (const unlock of [UNLOCKS.succeeds, UNLOCKS.failsButReady]) {
      const vars = await lockedSlot(t);
      const steps: string[] = [];
      const value = await verifyPrepareHealth(
        vars,
        { health: HEALTH_HOOK, unlock, parse: '', failedCommand: HEALTH_HOOK },
        'OK',
        (_name, detail) => steps.push(detail),
      );
      assert.equal(value, 'OK');
      // A recovered prepare carries no unlock-failure step.
      assert.deepEqual(steps, ['Trying unlock...']);
    }
  });

  test('prepare health reports the unlock failure when health stays down', async (t) => {
    const vars = await lockedSlot(t);
    const steps: string[] = [];
    await assert.rejects(
      verifyPrepareHealth(
        vars,
        {
          health: HEALTH_HOOK,
          unlock: UNLOCKS.failsStillDown,
          parse: '',
          failedCommand: HEALTH_HOOK,
        },
        'OK',
        (_name, detail) => steps.push(detail),
      ),
      {
        message:
          'Health not ready (value=LOCKED, expected OK); unlock hook exited 1: unlock failed (exit 1, APP_LOGIC_FAILURE): Timed out',
        failedCommand: HEALTH_HOOK,
      },
    );
    assert.ok(
      steps.includes(
        'Unlock failed — unlock hook exited 1: unlock failed (exit 1, APP_LOGIC_FAILURE): Timed out',
      ),
    );
  });
});

test('isOptionalFixtureAbsence tolerates optional entries and unresolved placeholders', () => {
  assert.equal(
    isOptionalFixtureAbsence(
      { src: 'domains/blue/notes.md', optional: true },
      'domains/blue/notes.md',
    ),
    true,
  );
  assert.equal(
    isOptionalFixtureAbsence({ src: 'domains/{{domain}}/notes.md' }, 'domains/{{domain}}/notes.md'),
    true,
  );
  assert.equal(
    isOptionalFixtureAbsence({ src: 'sentry.debug.properties' }, 'sentry.debug.properties'),
    false,
  );
});

test('checkDefaultBranch fails a single-branch clone and passes once main is fetchable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-default-branch-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        '-c',
        'init.defaultBranch=main',
        ...args,
      ],
      { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  const upstream = path.join(root, 'upstream');
  git(root, 'init', '-q', upstream);
  git(upstream, 'commit', '-q', '--allow-empty', '-m', 'main');
  git(upstream, 'checkout', '-q', '-b', 'release/8.14.0');
  git(upstream, 'commit', '-q', '--allow-empty', '-m', 'release');
  const single = path.join(root, 'single');
  git(root, 'clone', '-q', '--single-branch', '--branch', 'release/8.14.0', upstream, single);
  const full = path.join(root, 'full');
  git(root, 'clone', '-q', upstream, full);

  const blocked = await checkDefaultBranch(makeSlotVars(single), 'main');
  assert.equal(blocked.status, 'fail');
  assert.match(
    blocked.detail,
    /^origin fetch refspec \+refs\/heads\/release\/8\.14\.0:refs\/remotes\/origin\/release\/8\.14\.0 does not fetch default branch 'main'/,
  );
  // Prepare's own explicit fetch does not rescue it: checkout cannot DWIM origin/main.
  git(single, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  assert.equal((await checkDefaultBranch(makeSlotVars(single), 'main')).status, 'fail');
  assert.throws(() => git(single, 'checkout', '-q', 'main'), /pathspec 'main' did not match/);

  assert.equal((await checkDefaultBranch(makeSlotVars(full), 'main')).status, 'pass');
  // A full clone without the configured default branch names the missing ref.
  const missing = await checkDefaultBranch(makeSlotVars(full), 'develop');
  assert.equal(missing.status, 'fail');
  assert.match(missing.detail, /no default branch 'develop'/);

  // A refspec without a destination fetches main only into FETCH_HEAD: still blocked.
  git(single, 'config', '--add', 'remote.origin.fetch', '+refs/heads/main');
  assert.equal((await checkDefaultBranch(makeSlotVars(single), 'main')).status, 'fail');
  assert.throws(() => git(single, 'checkout', '-q', 'main'), /pathspec 'main' did not match/);

  // The operator repair: widen the refspec; the slot passes and checkout works.
  git(
    single,
    'config',
    '--add',
    'remote.origin.fetch',
    '+refs/heads/main:refs/remotes/origin/main',
  );
  assert.equal((await checkDefaultBranch(makeSlotVars(single), 'main')).status, 'pass');
  git(single, 'checkout', '-q', 'main');

  const absent = await checkDefaultBranch(makeSlotVars(path.join(root, 'absent')), 'main');
  assert.equal(absent.status, 'warn');

  // An unreadable packed-refs makes for-each-ref fail: no verdict, never "missing".
  git(full, 'pack-refs', '--all');
  const packedRefs = path.join(full, '.git', 'packed-refs');
  // The temp-dir removal registered above deletes it regardless of its mode.
  await chmod(packedRefs, 0o000);
  const unreadable = await checkDefaultBranch(makeSlotVars(full), 'main');
  assert.equal(unreadable.status, 'warn');
  assert.match(unreadable.detail, /^No verdict: .*git for-each-ref exited/);
  assert.equal((await probeDefaultBranch(makeSlotVars(full), 'main')).readable, false);
});

// asdf 0.19 shim: resolves node from the cwd's .tool-versions and refuses a
// pinned version the host has not installed, as on the F67 slots.
const FAKE_NODE = `#!/bin/sh
if ! grep -qx 'nodejs 22.15.0' .tool-versions 2>/dev/null; then
  echo "No version is set for command node"
  echo "Consider adding one of the following versions in your config file at $PWD/.tool-versions"
  echo "nodejs 22.15.0"
  echo "nodejs 20.18.0"
  exit 126
fi
echo v22.15.0
`;
// npm-installed runner: a node script, so it inherits the shim's refusal.
const FAKE_RUNNER = `#!/bin/sh
out=$(node) || { echo "$out"; exit 1; }
echo 1.0.0
`;

async function runnerSlot(
  t: { after: (fn: () => Promise<void>) => void },
  nodePin: string,
  claudeBody = FAKE_RUNNER,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-runner-launch-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const bin = path.join(root, 'bin');
  const repo = path.join(root, 'repo');
  await mkdir(bin, { recursive: true });
  await mkdir(repo, { recursive: true });
  for (const [name, body] of [
    ['node', FAKE_NODE],
    ['codex', FAKE_RUNNER],
    ['claude', claudeBody],
  ]) {
    await writeFile(path.join(bin, name), body);
    await chmod(path.join(bin, name), 0o755);
  }
  await writeFile(path.join(repo, '.tool-versions'), `nodejs ${nodePin}\n`);
  return {
    ...makeSlotVars(repo),
    codexPath: path.join(bin, 'codex'),
    machineEnv: { PATH: `${bin}:/usr/bin:/bin` },
  };
}

test('checkRunnerLaunch fails when the slot repo pins a node version the host lacks', async (t) => {
  const vars = await runnerSlot(t, '22.22.1');
  const steps = await checkRunnerLaunch(vars, {} as RawProjectJson);

  assert.deepEqual(
    steps.map((s) => [s.name, s.status]),
    [
      ['runner.node', 'fail'],
      ['runner.claude', 'fail'],
      ['runner.codex', 'fail'],
    ],
  );
  for (const step of steps) {
    assert.match(step.detail, /No version is set for command node \| Consider adding/);
    assert.match(
      step.detail,
      /; \.tool-versions pins nodejs 22\.22\.1\. Fix: install nodejs 22\.22\.1 on .*`asdf install`/,
    );
  }
});

test('checkRunnerLaunch passes when node and the runners resolve in the slot repo', async (t) => {
  const vars = await runnerSlot(t, '22.15.0');
  const steps = await checkRunnerLaunch(vars, {} as RawProjectJson);

  assert.deepEqual(steps, [
    { name: 'runner.node', status: 'pass', detail: 'node v22.15.0' },
    { name: 'runner.claude', status: 'pass', detail: 'claude 1.0.0' },
    { name: 'runner.codex', status: 'pass', detail: `${vars.codexPath} 1.0.0` },
  ]);
});

test('checkRunnerLaunch names a runner binary missing from the worker PATH', async (t) => {
  const vars = await runnerSlot(t, '22.15.0');
  const steps = await checkRunnerLaunch(
    { ...vars, codexPath: path.join(vars.remoteRepo, 'missing-codex') },
    {} as RawProjectJson,
  );

  const codex = steps.find((s) => s.name === 'runner.codex');
  assert.equal(codex?.status, 'fail');
  assert.match(codex.detail, /\(exit 127\).*Fix: install .*missing-codex/);
  // An unrelated failure does not cite the repo's Node pin.
  assert.doesNotMatch(codex.detail, /pins nodejs/);
});

test('checkRunnerLaunch streams each probe and heartbeats while one is pending', async (t) => {
  // claude answers only once a heartbeat names it after node has finished (5 s ceiling).
  const gatedClaude = `#!/bin/sh
i=0; while [ ! -e claude-gate ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
echo 1.0.0
`;
  const vars = await runnerSlot(t, '22.15.0', gatedClaude);
  const heartbeatMs = 20;
  const progress: { name: string; detail: string }[] = [];
  const steps = await checkRunnerLaunch(vars, {} as RawProjectJson, undefined, {
    onProgress: (step) => {
      progress.push({ name: step.name, detail: step.detail });
      const waitingOnClaudeOnly =
        step.name === 'runner' &&
        step.detail.includes('runner.claude') &&
        !step.detail.includes('runner.node');
      if (waitingOnClaudeOnly) {
        writeFileSync(path.join(vars.remoteRepo, 'claude-gate'), '');
      }
    },
    heartbeatMs,
  });
  const afterReturn = progress.length;

  assert.equal(steps.map((s) => s.status).join(), 'pass,pass,pass');
  const claudeAt = progress.findIndex((p) => p.name === 'runner.claude');
  assert.ok(progress.findIndex((p) => p.name === 'runner.node') < claudeAt);
  assert.ok(
    progress
      .slice(0, claudeAt)
      .some(
        (p) => p.name === 'runner' && /^Still probing .*runner\.claude.* \(\d+ s\)$/.test(p.detail),
      ),
  );
  // The heartbeat stops once the probes return.
  await new Promise((resolve) => setTimeout(resolve, heartbeatMs * 3));
  assert.equal(progress.length, afterReturn);
});

test('checkRunnerLaunch reports an unbuildable worker env once', async (t) => {
  const vars = await runnerSlot(t, '22.15.0');
  const steps = await checkRunnerLaunch(vars, {
    command_env: { set: { 'BAD-NAME': 'x' } },
  } as RawProjectJson);

  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.name, 'runner');
  assert.equal(steps[0]!.status, 'fail');
  assert.match(steps[0]!.detail, /^Worker env cannot be built: .*BAD-NAME/);
});

test('health and unlock hooks receive configured pool tools in real child shells', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'pool-health '));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const vars = { ...makeSlotVars(repo), machineEnv: { AUDIOLAB_NODE_BIN: repo } };
  const condition = 'test "$AUDIOLAB_NODE_BIN" = "$PWD"';
  assert.equal(await runHealthCheck(vars, `${condition} && printf OK`, ''), 'OK');
  assert.equal(await runUnlockHook(vars, condition), null);
});

test('prepare profile artifact and dev-server probes receive pool paths', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'profile pool env '));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const vars = { ...makeSlotVars(repo), machineEnv: { FARMSLOT_WORKSPACE: repo } };
  const context = {
    vars,
    runtimeDir: '.agent',
    projectJson: {
      command_env: { set: { FARMSLOT_WORKSPACE: '/wrong' } },
      hooks: {
        artifact_check: 'test "$FARMSLOT_WORKSPACE" = "$PWD"',
        dev_server_check: 'test "$FARMSLOT_WORKSPACE" = "$PWD"',
        health_check: 'test "$FARMSLOT_WORKSPACE" = "$PWD" && printf OK',
      },
    },
  };
  assert.equal((await checkPrepareRequirement('artifact_available', context)).ok, true);
  assert.equal((await checkPrepareRequirement('dev_server_up', context)).ok, true);
  assert.equal((await checkPrepareRequirement('health_ok', context)).ok, true);
});
