import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import '../runtime/mock-pty.test-support.js';

import type { ProjectVars, SlotVars } from '../core/config.js';
import { makeReadyGatePackage } from '../run-engine/test-fixtures.js';

import { makeRun } from './test-fixtures.js';

const head = 'a'.repeat(40);
const unsigned = 'b'.repeat(40);
const vars: SlotVars = {
  slotId: 'signature-boundary',
  machine: 'fixture',
  host: 'localhost',
  repo: '/fixture',
  remoteRepo: '/fixture',
  projectName: 'signature-proof',
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
const pv: ProjectVars = {
  projectName: vars.projectName,
  projectConfig: '/project/project.json',
  projectFixturesDir: '/project/fixtures',
  projectTemplatesDir: '/project/templates',
  runtimeDir: '.agent',
  artifactDir: '.task',
  projectJson: { default_branch: 'main' },
};
const run = makeRun({
  id: 'signature-boundary-run',
  flowType: 'dev',
  mode: 'autonomous',
  project: vars.projectName,
  slotId: vars.slotId,
  branch: 'feature',
  prNumber: undefined,
});
let commands: string[] = [];
let afterNudge = false;
let signatures = 0;
let inspections = 0;
const execute = async (_vars: SlotVars, command: string) => {
  commands.push(command);
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
  if (command.startsWith('for k in ')) return ok('commit.gpgsign\ttrue\n');
  if (command.startsWith('commits='))
    return ok(afterNudge && ++signatures === 1 ? '' : unsigned + '\n');
  if (command.includes('rev-parse HEAD')) return ok(head);
  if (!afterNudge)
    throw new Error('guard bypassed: unexpected worktree inspection or publication push');
  if (command.includes("'HEAD probe'")) {
    // One exec per inspection: tracked paths, staged paths, then the comparison.
    const tracked = ++inspections === 1 ? ['tracked'] : [];
    return ok([...tracked, '', '', 'remote', '0', ''].join('\0'));
  }
  throw new Error(`unexpected signature fixture command: ${command}`);
};
const execution = await import('../core/exec.js');
mock.module('../core/exec.js', { namedExports: { ...execution, execOnSlot: execute } });
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: { ...config, loadSlotVars: async () => vars, loadProjectVars: async () => pv },
});
const core = await import('../core/index.js');
mock.module('../core/index.js', { namedExports: { ...core, execOnSlot: execute } });
const store = await import('../runs/store.js');
mock.module('../runs/store.js', { namedExports: { ...store, getRun: () => run } });
const contexts = await import('../agents/contexts.js');
mock.module('../agents/contexts.js', {
  namedExports: {
    ...contexts,
    resolveAgentTarget: async () => {
      throw new Error('no worker in this fixture');
    },
  },
});
const { verifyWorkerPushedBranch } = await import('../run-engine/push-verification.js');
const { assertRunCommitSignatures } = await import('./commit-signatures.js');
const { createPrFromApprovedPackage } = await import('./orchestrator.js');
beforeEach(() => {
  commands = [];
  afterNudge = false;
  signatures = 0;
  inspections = 0;
});

test('completion rejects unsigned commits before accepting a complete signal', async () => {
  await assert.rejects(
    verifyWorkerPushedBranch(run.id, vars.slotId),
    /Unsigned outgoing commit\(s\): bbbbbbbbbbbb/,
  );
  assert.ok(commands.some((command) => command.startsWith('commits=')));
});

test('completion checks the new commit made after its commit nudge', async (t) => {
  afterNudge = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = verifyWorkerPushedBranch(run.id, vars.slotId);
  const rejected = assert.rejects(pending, /Unsigned outgoing commit\(s\): bbbbbbbbbbbb/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(20_000);
  await rejected;
  assert.equal(signatures, 2);
});

test('first publication refuses unsigned commits before any push', async () => {
  const prPackage = makeReadyGatePackage({ headSha: head, branch: 'feature' });
  await assert.rejects(
    createPrFromApprovedPackage(run, 'example/repo', prPackage),
    /Unsigned outgoing commit\(s\): bbbbbbbbbbbb/,
  );
  assert.ok(!commands.some((command) => command.includes(' push ')));
});

test('a blind eval trial checks its contribution from the frozen base, not a removed remote', async () => {
  const baseSha = 'c'.repeat(40);
  const blindRun = makeRun({
    ...run,
    flowType: 'fix-bug',
    engineState: {
      evalExperiment: {
        experimentId: 'experiment-blind',
        experimentKey: 'blind-key',
        experimentManifestPath: '/evals/experiment-manifest.json',
        packagePath: '/evals/candidate.result-package.json',
        candidateStrategyFingerprint: 'strategy',
        trialId: 'trial-blind',
        blind: {
          version: 1,
          baseSha,
          problemDigest: 'problem',
          referenceCommits: [],
          referencePatchId: 'reference',
          forbiddenInputs: [],
        },
      },
    },
  });
  await assert.rejects(assertRunCommitSignatures(blindRun), /Unsigned outgoing commit/);
  const probe = commands.find((command) => command.startsWith('commits='));
  assert.ok(probe?.includes(`${baseSha}..HEAD`));
  assert.ok(!probe?.includes('refs/remotes/origin'));
});
