import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import type { ExecResult } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import type { ProjectVars, SlotVars } from '../core/config.js';

import { makeRun } from './test-fixtures.js';

// F327: a worker renamed the run branch (`git branch -m`) and push verification crashed.
// The completion path now names the state and tells the worker how to put the work back.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CEILING_DIRECTORIES: realpathSync(os.tmpdir()),
};
const dir = mkdtempSync(path.join(os.tmpdir(), 'push-verification-off-branch-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' }).trim();

const vars: SlotVars = {
  slotId: 'off-branch-slot',
  machine: 'fixture',
  host: 'localhost',
  repo: dir,
  remoteRepo: dir,
  projectName: 'off-branch-proof',
  platform: 'cli',
  sshUser: '',
  osType: 'linux',
  claudePath: '',
  codexPath: '',
  cursorPath: '',
  grokPath: '',
  opencodePath: '',
  dispatchCmd: '',
  recycleCmd: '',
  session: 'fixture',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: '',
  resourceVars: {},
};
const projectVars: ProjectVars = {
  projectName: vars.projectName,
  projectConfig: '/project/project.json',
  projectFixturesDir: '/project/fixtures',
  projectTemplatesDir: '/project/templates',
  runtimeDir: '.agent',
  artifactDir: '.task',
  projectJson: { default_branch: 'main' },
};
const run = makeRun({
  id: 'off-branch-run',
  flowType: 'pr-complete',
  project: vars.projectName,
  slotId: vars.slotId,
  branch: 'feature',
});

const instructions: string[] = [];
// What the worker does with the instruction.
let onNudge: ((text: string) => void) | undefined;
const execOnSlot = async (_vars: SlotVars, command: string): Promise<ExecResult> => {
  const { stdout, stderr, status } = spawnSync('bash', ['-c', command], {
    cwd: dir,
    env: gitEnv,
    encoding: 'utf8',
  });
  return { stdout, stderr, exitCode: status ?? 1 };
};
const execution = await import('../core/exec.js');
mock.module('../core/exec.js', { namedExports: { ...execution, execOnSlot } });
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => vars,
    loadProjectVars: async () => projectVars,
  },
});
const store = await import('../runs/store.js');
mock.module('../runs/store.js', { namedExports: { ...store, getRun: () => run } });
const contexts = await import('../agents/contexts.js');
mock.module('../agents/contexts.js', {
  namedExports: { ...contexts, resolveAgentTarget: async () => ({ target: 'fixture:0.0' }) },
});
const registry = await import('../runners/registry.js');
mock.module('../runners/registry.js', {
  namedExports: {
    ...registry,
    sendRunnerInstructionSafely: async (
      _vars: SlotVars,
      _target: string,
      _runner: string,
      text: string,
    ) => {
      instructions.push(text);
      onNudge?.(text);
      return true;
    },
  },
});
const { verifyWorkerPushedBranch } = await import('./push-verification.js');

const settled = async (until: () => boolean) => {
  // Event-loop turns, not time: setTimeout is mocked. The first call also loads modules.
  for (let turn = 0; turn < 200_000 && !until(); turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(until(), 'the verification reached the expected point');
};

beforeEach(() => {
  rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  git('init', '-q', '-b', 'feature');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'feat: pushed',
  );
  // Pushed, and nothing outgoing from main for the signature check to inspect.
  git('update-ref', 'refs/remotes/origin/feature', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  // The worker renamed the run branch to carry the marker.
  git('branch', '-m', 'feature', 'do-not-merge-feature');
  instructions.length = 0;
  onNudge = undefined;
});

test('a renamed run branch gets an instruction to rename it back, and passes once it is', async (t) => {
  onNudge = () => git('branch', '-m', 'do-not-merge-feature', 'feature');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = verifyWorkerPushedBranch(run.id, vars.slotId);
  await settled(() => instructions.length === 1);
  assert.match(
    instructions[0]!,
    /the run branch feature no longer exists; HEAD is on do-not-merge-feature\./,
  );
  assert.match(
    instructions[0]!,
    /rename the branch back with: git branch -m 'do-not-merge-feature' 'feature', then publish it with: git push -u origin 'feature'/,
  );
  assert.match(instructions[0]!, /DO NOT MERGE belongs in the PR title or description/);
  t.mock.timers.tick(20_000);
  const result = await pending;
  assert.equal(result.verified, true);
  assert.equal(result.nudged, true);
});

test('a run branch still missing after the nudge blocks with what to do, not a git error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const pending = verifyWorkerPushedBranch(run.id, vars.slotId);
  await settled(() => instructions.length === 1);
  let result: Awaited<typeof pending> | undefined;
  void pending.then((value) => (result = value));
  // The bounded wait re-inspects every 20 s for 5 minutes.
  for (let step = 0; step < 16 && !result; step++) {
    t.mock.timers.tick(20_000);
    await settled(() => true);
    for (let turn = 0; turn < 50 && !result; turn++)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(result);
  assert.equal(result.verified, false);
  assert.equal(
    result.reason,
    "worker signaled complete but the run branch feature no longer exists; HEAD is on do-not-merge-feature after publish nudge; rename the branch back with: git branch -m 'do-not-merge-feature' 'feature', then push it",
  );
});

// R1: a recreated branch has no upstream, so a bare `git push` fails and verification stays blocked.
test('a detached worker that runs the instruction as written publishes to a real remote', async (t) => {
  const remote = mkdtempSync(path.join(os.tmpdir(), 'push-verification-off-branch-remote-'));
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--bare', remote], { env: gitEnv });
  git('remote', 'add', 'origin', remote);
  git('update-ref', '-d', 'refs/remotes/origin/feature');
  git('checkout', '-q', '--detach');
  git('branch', '-D', 'do-not-merge-feature');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = verifyWorkerPushedBranch(run.id, vars.slotId);
  await settled(() => instructions.length === 1);
  const [, recreate, publish] =
    /with: (git checkout -b \S+), then publish it with: (git push -u origin \S+)\./.exec(
      instructions[0]!,
    ) ?? [];
  assert.ok(recreate && publish, instructions[0]);
  for (const command of [recreate, publish])
    execFileSync('bash', ['-c', command], { cwd: dir, env: gitEnv, stdio: 'pipe' });
  t.mock.timers.tick(20_000);
  const result = await pending;
  assert.equal(result.verified, true);
  assert.match(
    execFileSync('git', ['ls-remote', '--heads', remote, 'feature'], {
      env: gitEnv,
      encoding: 'utf8',
    }),
    /refs\/heads\/feature/,
  );
});
