import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import type { BlindGitSpec } from '../../evals/blind-git.js';

// TAT-4162: a failed blind trial is detached from its slot, so the operator's
// unowned `slot.release { forceReset }` must find it from the slot repo itself.
// Git runs for real against a temp repo, isolated by the real blind-git.py; the
// slot row lives in memory and tmux, process and runtime probes stay inert.
// Every mock is registered before release.js loads: the real runtime-capability and
// native-worker modules import it, so they stay real (no pool slot, no native run).
const root = mkdtempSync(path.join(tmpdir(), 'release-blind-'));
const runRoot = path.join(root, 'runs');
for (const dir of [runRoot, path.join(root, 'home'), path.join(root, 'pool')]) mkdirSync(dir);
process.env.FARMSLOT_RUNS_DIR = runRoot;
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_POOL_DIR = path.join(root, 'pool');
after(() => rmSync(root, { recursive: true, force: true }));

const SLOT_ID = 'mini-mmt-3';
const BRANCH = 'eval/trial';
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
let repo = '';
let slotRow: Record<string, unknown>;
let markerWrites = 0;
let afterMarkerRead: (() => void) | undefined;

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const applies = (
  predicate: (slot: Record<string, unknown>) => boolean,
  fields: Record<string, unknown>,
) => {
  if (!predicate(slotRow)) return false;
  slotRow = { ...slotRow, ...fields };
  return true;
};
const execForTest = async (_vars: unknown, cmd: string) => {
  if (/\btmux\b/.test(cmd)) return { stdout: '', stderr: 'no server running', exitCode: 1 };
  // Only the fixture repository's Git commands run; prepare and process probes find nothing.
  if (!cmd.includes(repo) || cmd.startsWith('identityfile=')) return ok();
  const result = spawnSync('bash', ['-c', cmd], {
    cwd: repo,
    env: gitEnv,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (cmd.includes('farmslot.blindRun')) afterMarkerRead?.();
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
};

await import('../../runtime/mock-pty.test-support.js');
// Blind restoration fences on the slot epoch through core/state directly.
const realState = await import('../../core/state.js');
mock.module('../../core/state.js', {
  namedExports: { ...realState, readSlotRow: async () => slotRow },
});
const realExec = await import('../../core/exec.js');
mock.module('../../core/exec.js', { namedExports: { ...realExec, execOnSlot: execForTest } });
const realScaffolding = await import('../../fleet/slot-scaffolding.js');
mock.module('../../fleet/slot-scaffolding.js', {
  namedExports: {
    ...realScaffolding,
    excludeSlotScaffolding: async () => undefined,
    archiveSlotScaffolding: async (
      _vars: unknown,
      _project: unknown,
      options: { destination: string; beforeRemove?: () => Promise<void> },
    ) => {
      await options.beforeRemove?.();
      return { roots: 0, directory: options.destination };
    },
  },
});
const realCore = await import('../../core/index.js');
mock.module('../../core/index.js', {
  namedExports: {
    ...realCore,
    loadSlotVars: async () => ({
      slotId: SLOT_ID,
      remoteRepo: repo,
      host: 'mini',
      machine: 'mini',
      projectName: 'fixture',
      resourceVars: {},
    }),
    loadProjectVars: async () => ({
      runtimeDir: '.agent',
      projectJson: { default_branch: 'main' },
    }),
    readSlotField: async (_slotId: string, field: string) => slotRow[field] ?? null,
    readSlotRow: async () => slotRow,
    markSlotStatusIf: async (
      _slotId: string,
      predicate: (slot: Record<string, unknown>) => boolean,
      fields: Record<string, unknown>,
    ) => {
      const applied = applies(predicate, fields);
      if (applied) markerWrites += 1;
      return { applied, epoch: Number(slotRow.slot_epoch) };
    },
    updateSlotStatusIf: async (
      _slotId: string,
      predicate: (slot: Record<string, unknown>) => boolean,
      fields: Record<string, unknown>,
    ) => applies(predicate, fields),
    resetSlotIf: async (_id: string, predicate: (row: Record<string, unknown>) => boolean) => {
      if (!predicate(slotRow)) return false;
      slotRow = { ...slotRow, current_run_id: null, lifecycle: 'ready', phase: null };
      return true;
    },
    execOnSlot: execForTest,
  },
});
const realStorage = await import('../../fleet/slot-storage-cleanup.js');
mock.module('../../fleet/slot-storage-cleanup.js', {
  namedExports: {
    ...realStorage,
    cleanupSlotStorage: async () => ({ deleted: [], skipped: [] }),
  },
});
const realTmux = await import('../../core/tmux.js');
mock.module('../../core/tmux.js', {
  namedExports: { ...realTmux, resolveTmuxSession: async () => SLOT_ID },
});
const realAttachments = await import('../terminal-attachment.js');
mock.module('../terminal-attachment.js', {
  namedExports: { ...realAttachments, terminalAttachmentCleanup: async () => ({ removed: [] }) },
});

const realRuns = await import('../../runs/store.js');
const { buildBlindGitCommand } = await import('../../evals/blind-git.js');
const { slotRelease } = await import('./release.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' }).trim();
}
function gitStatus(...args: string[]): number | null {
  return spawnSync('git', ['-C', repo, ...args], { env: gitEnv }).status;
}
function commit(cwd: string, message: string): string {
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** A slot repo on main, isolated by the real blind-git.py, with one candidate commit. */
function blindSlot(label: string, runId: string) {
  const dir = path.join(root, label);
  repo = path.join(dir, 'repo');
  const upstream = path.join(dir, 'upstream.git');
  mkdirSync(repo, { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', upstream);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, 'value.txt'), 'base\n');
  const baseSha = commit(repo, 'base');
  writeFileSync(path.join(repo, 'value.txt'), 'reference\n');
  const reference = commit(repo, 'reference answer');
  git(repo, 'remote', 'add', 'origin', upstream);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const spec: BlindGitSpec = {
    slotId: SLOT_ID,
    slotEpoch: 3,
    repo,
    capsule: path.join(dir, 'capsule'),
    runId,
    branch: BRANCH,
    baseSha,
    referenceCommits: [reference],
  };
  const isolated: unknown = JSON.parse(
    execFileSync('bash', ['-c', buildBlindGitCommand('isolate', spec)], {
      env: gitEnv,
      encoding: 'utf8',
    }),
  );
  assert.deepEqual(isolated, { status: 'isolated', baseSha, runId });
  writeFileSync(path.join(repo, 'value.txt'), 'candidate\n');
  const candidate = commit(repo, 'candidate');
  // The production strand: refresh sees no origin fetch refspec.
  assert.equal(gitStatus('config', '--get', 'remote.origin.fetch'), 1);
  assert.equal(git(repo, 'config', '--get', 'farmslot.blindRun'), runId);
  return { spec, candidate, reference };
}

/** The failed trial as the store holds it after its slot pointer was cleared. */
async function detachedTrial(spec: BlindGitSpec, overrides: Partial<Run> = {}): Promise<void> {
  const created = realRuns.createRun(
    { flowType: 'dev', project: 'fixture', ticketOrPr: 'EVAL-TAT-4162' },
    { deferBackgroundPersist: true },
  );
  const trial: Run = {
    ...created,
    id: spec.runId,
    status: 'failed',
    slotId: null,
    branch: spec.branch,
    engineState: {
      evalExperiment: {
        experimentId: 'experiment',
        experimentKey: 'key',
        experimentManifestPath: path.join(root, 'experiment.json'),
        packagePath: path.join(root, 'candidate.json'),
        candidateStrategyFingerprint: 'fingerprint',
        trialId: spec.runId,
        blind: {
          version: 1,
          baseSha: spec.baseSha,
          problemDigest: 'problem',
          referenceCommits: spec.referenceCommits,
          referencePatchId: 'reference',
          forbiddenInputs: [],
          isolation: {
            slotId: spec.slotId,
            slotEpoch: spec.slotEpoch,
            capsulePath: spec.capsule,
            verifiedAt: '2026-10-30T00:00:00.000Z',
          },
        },
      },
    },
    ...overrides,
  };
  writeFileSync(path.join(runRoot, `${trial.id}.json`), JSON.stringify(trial));
  await realRuns.loadAllRuns();
}

beforeEach(() => {
  // Ready again after the stale releasing fence was reclaimed: no run pointer.
  slotRow = { slot: SLOT_ID, lifecycle: 'ready', phase: null, slot_epoch: 9 };
  markerWrites = 0;
  afterMarkerRead = undefined;
});

test('an unowned force release restores a detached blind trial Git before resetting', async () => {
  const { spec, candidate, reference } = blindSlot('restore', 'trial-detached');
  await detachedTrial(spec);
  assert.equal(realRuns.getRun(spec.runId)?.slotId, null);

  const result = await slotRelease({ slotId: SLOT_ID, forceReset: true }, () => {});

  assert.deepEqual(result, { released: true });
  assert.equal(
    git(repo, 'config', '--get', 'remote.origin.fetch'),
    '+refs/heads/*:refs/remotes/origin/*',
  );
  assert.equal(gitStatus('config', '--get', 'farmslot.blindRun'), 1);
  assert.equal(gitStatus('config', '--get', 'protocol.allow'), 1);
  assert.equal(git(repo, 'rev-parse', `refs/heads/${BRANCH}`), candidate);
  // The reset only moved HEAD back to main; the candidate branch survives it.
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), reference);
  assert.equal(
    JSON.parse(readFileSync(path.join(spec.capsule, 'state.json'), 'utf8')).phase,
    'restored',
  );
  assert.equal(slotRow.lifecycle, 'ready');
});

test('an unowned release refuses a blind repo whose trial record is missing', async () => {
  const { candidate } = blindSlot('unknown', 'trial-missing');

  await assert.rejects(
    slotRelease({ slotId: SLOT_ID, forceReset: true }, () => {}),
    /isolated for blind trial trial-missing, which has no restorable run record/,
  );

  assert.equal(markerWrites, 0, 'the slot was never fenced');
  assert.equal(slotRow.phase, null);
  assert.equal(git(repo, 'config', '--get', 'farmslot.blindRun'), 'trial-missing');
  assert.equal(gitStatus('config', '--get', 'remote.origin.fetch'), 1);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), candidate);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), BRANCH);
});

test('an unowned release that preserves agents refuses before restoring a blind trial', async () => {
  const { spec, candidate } = blindSlot('preserve', 'trial-preserve');
  await detachedTrial(spec);

  await assert.rejects(
    slotRelease({ slotId: SLOT_ID, keepWork: true, preserveAgents: true }, () => {}),
    /Blind trial cleanup must stop its worker before restoring Git metadata/,
  );

  assert.equal(markerWrites, 0, 'the slot was never fenced');
  assert.equal(slotRow.phase, null);
  assert.equal(git(repo, 'config', '--get', 'farmslot.blindRun'), 'trial-preserve');
  assert.equal(gitStatus('config', '--get', 'remote.origin.fetch'), 1);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), candidate);
});

test('an unowned keepWork release restores a blind trial and keeps its checkout', async () => {
  const { spec, candidate } = blindSlot('keep-work', 'trial-keep-work');
  await detachedTrial(spec);
  writeFileSync(path.join(repo, 'notes.txt'), 'uncommitted candidate note\n');

  const result = await slotRelease({ slotId: SLOT_ID, keepWork: true }, () => {});

  assert.deepEqual(result, { released: true });
  assert.equal(
    git(repo, 'config', '--get', 'remote.origin.fetch'),
    '+refs/heads/*:refs/remotes/origin/*',
  );
  assert.equal(gitStatus('config', '--get', 'farmslot.blindRun'), 1);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), BRANCH);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), candidate);
  assert.equal(readFileSync(path.join(repo, 'notes.txt'), 'utf8'), 'uncommitted candidate note\n');
  assert.equal(slotRow.lifecycle, 'ready');
});

test('a done blind trial whose slot pointer was cleared releases its own isolated Git', async () => {
  const { spec, candidate } = blindSlot('done', 'trial-done');
  await detachedTrial(spec, { status: 'done', slotId: SLOT_ID });

  const result = await slotRelease(
    { slotId: SLOT_ID, expectedRunId: spec.runId, forceReset: true },
    () => {},
  );

  assert.deepEqual(result, { released: true });
  assert.equal(
    git(repo, 'config', '--get', 'remote.origin.fetch'),
    '+refs/heads/*:refs/remotes/origin/*',
  );
  assert.equal(gitStatus('config', '--get', 'farmslot.blindRun'), 1);
  assert.equal(git(repo, 'rev-parse', `refs/heads/${BRANCH}`), candidate);
});

test('a release for another run leaves a blind slot it does not own untouched', async () => {
  const { spec, candidate } = blindSlot('foreign', 'trial-foreign');
  await detachedTrial(spec, { status: 'done', slotId: SLOT_ID });

  const result = await slotRelease({ slotId: SLOT_ID, expectedRunId: 'other-run' }, () => {});

  assert.deepEqual(result, {
    released: false,
    reason: `Slot ${SLOT_ID} is held by no run, not run other-run`,
  });
  assert.equal(markerWrites, 0);
  assert.equal(git(repo, 'config', '--get', 'farmslot.blindRun'), 'trial-foreign');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), candidate);
});

test('a done blind trial does not take a slot another run holds for cleanup', async () => {
  const { spec, candidate } = blindSlot('foreign-cleanup', 'trial-held');
  await detachedTrial(spec, { status: 'done', slotId: SLOT_ID });
  slotRow = { ...slotRow, cleanup_run_id: 'follow-up' };

  const result = await slotRelease(
    { slotId: SLOT_ID, expectedRunId: spec.runId, forceReset: true },
    () => {},
  );

  assert.deepEqual(result, {
    released: false,
    reason: `Slot ${SLOT_ID} is held by no run, not run ${spec.runId}`,
  });
  assert.equal(markerWrites, 0);
  assert.equal(git(repo, 'config', '--get', 'farmslot.blindRun'), 'trial-held');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), candidate);
});

test('a cleanup hold that lands after preflight stops a done blind trial at the fence', async () => {
  const { spec, candidate } = blindSlot('late-cleanup', 'trial-late');
  await detachedTrial(spec, { status: 'done', slotId: SLOT_ID });
  afterMarkerRead = () => {
    slotRow = { ...slotRow, cleanup_run_id: 'follow-up' };
  };

  const result = await slotRelease(
    { slotId: SLOT_ID, expectedRunId: spec.runId, forceReset: true },
    () => {},
  );

  assert.deepEqual(result, {
    released: false,
    reason: `Slot ${SLOT_ID} is held by no run, not run ${spec.runId}`,
  });
  assert.equal(markerWrites, 0);
  assert.equal(git(repo, 'config', '--get', 'farmslot.blindRun'), 'trial-late');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), candidate);
});
