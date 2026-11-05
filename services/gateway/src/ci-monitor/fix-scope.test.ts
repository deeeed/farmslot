import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import { makeVars } from '../runners/test-fixtures.js';

const root = mkdtempSync(path.join(tmpdir(), 'f415-completion-'));
process.env.FARMSLOT_RUNS_DIR = path.join(root, 'runs');
const templatePath = path.join(root, 'ci-fix.md');
writeFileSync(
  templatePath,
  '# Project override\n- [ ] Fix the issue\ngit push origin {{BRANCH}}\n',
);
const vars = makeVars({
  projectName: 'example-web-farm',
  remoteRepo: '/fixture/product',
  session: 'fixture',
});
const headSha = 'a'.repeat(40);
const fixedSha = 'b'.repeat(40);
const scope = { headSha, baseRef: 'main', ownedFiles: ['src/old.ts', 'src/product.ts'] };
const files = new Map<string, string>();
let completed = false;
let signal = true;
let deliveries = 0;
let verifications = 0;
let outside = true;
let scopeMissing = false;
const execModule = await import('../core/exec.js');
mock.module('../core/exec.js', {
  namedExports: {
    ...execModule,
    isLocal: () => true,
    execOnSlot: async (_vars: unknown, command: string) => {
      const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
      if (command.includes('rev-parse HEAD')) return ok(completed ? fixedSha : headSha);
      if (command.includes('pane_current_command')) return ok('fixture');
      if (command.includes('capture-ci-fix')) return ok(JSON.stringify(scope));
      if (command.includes('verify-ci-fix')) {
        verifications++;
        assert.ok(command.includes('src/product.ts'));
        return outside
          ? {
              exitCode: 2,
              stdout: '',
              stderr: JSON.stringify({
                code: 'CI_FIX_OUT_OF_SCOPE',
                message:
                  'Branch maintenance refused: CI_FIX_OUT_OF_SCOPE: .github/workflows/validate.yml',
              }),
            }
          : ok();
      }
      if (command.includes('CI-FIX-SIGNAL.json'))
        return ok(completed && signal ? JSON.stringify({ status: 'complete' }) : '');
      if (command.includes('ci-fix-scope.json'))
        return scopeMissing
          ? { exitCode: 1, stdout: '', stderr: 'missing' }
          : ok(JSON.stringify(scope));
      if (command.startsWith('cat ')) return ok('# CI fix\n- [x] Done');
      return ok();
    },
  },
});
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => vars,
    loadProjectVars: async () => ({
      projectName: 'example-web-farm',
      projectJson: {},
      runtimeDir: '.agent',
      artifactDir: 'artifacts',
    }),
  },
});
const slotConfig = await import('@farmslot/slot-config');
mock.module('@farmslot/slot-config', {
  namedExports: { ...slotConfig, projectSourceContext: async () => null },
});
mock.module('../core/worker-templates.js', {
  namedExports: { projectWorkerTemplatePath: async () => templatePath },
});
mock.module('../methods/dispatch/slot-file-write.js', {
  namedExports: {
    writeTextFileOnSlot: async (_vars: unknown, file: string, text: string) => {
      files.set(file, text);
    },
  },
});
mock.module('../tasks/agent-runtime-script.js', {
  namedExports: {
    agentRuntimeScriptForSlot: async () => '/fixture/branch-update.mjs',
    renderRoleTemplate: async (
      text: string,
      _vars: unknown,
      _pv: unknown,
      replacements: Record<string, string>,
    ) => text.replace(/\{\{(\w+)\}\}/g, (token, name) => replacements[name] ?? token),
  },
});
mock.module('../tasks/checklist-target.js', {
  namedExports: {
    CI_FIX_CHECKLIST: 'CI-FIX.md',
    CI_FIX_CHECKLIST_TARGET: { checklist: 'CI-FIX.md', signal: 'CI-FIX-SIGNAL.json' },
    restoreWorkerChecklistTargetFromSlot: async () => {},
    syncChecklistTargetForRole: async () => {},
    taskDirRelPath: (dir: string, file: string) => `${dir}/${file}`,
    slotTaskRelPath: (_vars: unknown, dir: string, file: string) =>
      `${vars.remoteRepo}/${dir}/${file}`,
  },
});
mock.module('../tasks/watcher.js', {
  namedExports: { watchContext: async () => {}, unwatchContext: async () => {} },
});
mock.module('../runners/prompt-delivery-evidence.js', {
  namedExports: { readLaunchAckSignalSnapshot: async () => null },
});
mock.module('../runners/worker-prompt.js', {
  namedExports: { resolveWorkerDispatchPrompt: async () => 'Read CI-FIX.md' },
});
mock.module('../review/worker-lifecycle.js', {
  namedExports: {
    rediscoverAcceptingWorkerPane: async () => null,
    ensureTmuxTargetReadyForRelaunch: async () => 'fixture:dev',
  },
});
mock.module('../runners/session-reactivation.js', {
  namedExports: {
    deliverPromptToLiveRunner: async () => {
      deliveries++;
      return { delivered: true, turnToken: 'fixture-turn' };
    },
  },
});
mock.module('../core/tmux.js', {
  namedExports: {
    shellQuote: (v: string) => "'" + v.replaceAll("'", "'\"'\"'") + "'",
    tmuxShellSnippet: (v: string) => v,
    TMUX_WINDOW_RESPAWN_SETTLE_MS: 0,
    respawnTmuxWindowWithCommand: async () => {},
    resolveExactTmuxWindowPane: async () => ({ panePid: '123', pane: 'fixture:dev.0' }),
  },
});
mock.module('../runners/registry.js', {
  namedExports: {
    normalizeRunner: () => 'fixture',
    runnerRetainedSessionHandoff: () => 'in-place',
    runnerProcessPatternSource: () => 'fixture',
    WORKER_ENV_PREFIX: '',
    readRunnerActivityFromObservability: async () => null,
    resolvePrimaryWorkerTarget: async () => 'fixture:dev',

    readRunnerTurnState: async () => ({
      value: 'complete',
      confidence: 'high',
      observedAt: Date.now(),
      source: 'signal',
    }),
  },
});
mock.module('../agents/contexts.js', {
  namedExports: {
    resolveAgentTarget: async () => ({
      session: 'fixture',
      target: 'fixture:dev',
      role: 'primary',
    }),
    selectAgentContext: () => null,
    upsertAgentContext: async () => null,
    markAgentContextStatus: async () => {},
  },
});
mock.module('../review/orchestrator.js', {
  namedExports: {
    retryDeferredFixDelivery: async () => {
      throw new Error('Unexpected retry');
    },
  },
});
mock.module('../run-engine/branch-maintenance.js', {
  namedExports: {
    runtimeOperation: async (vars: SlotVars, phase: string, input: unknown) => {
      const exec = await import('../core/exec.js');
      const result = await exec.execOnSlot(vars, phase + ' ' + JSON.stringify(input));
      if (result.exitCode !== 0) throw new Error(JSON.parse(result.stderr).message);
      return result.stdout ? JSON.parse(result.stdout) : undefined;
    },
    prepareBranchMaintenance: async () => undefined,
    pendingBranchMaintenance: () => undefined,
    completeBranchMaintenance: async () => {},
    abandonBranchMaintenance: async () => {},
  },
});
mock.module('../runners/session-process.js', {
  namedExports: {
    isRunnerAliveUnderPane: async () => true,
    resolveRunRetainedSessionBinding: () => ({
      binding: { runnerSessionId: 'fixture-session' },
      reason: null,
    }),
  },
});
mock.module('../runners/session-record.js', {
  namedExports: {
    captureAndRecordRunnerSession: async () => {},
    clearedRunnerSessionContextPatch: () => ({}),
    recordRunnerSessionForRole: async () => {},
    runnerSessionContextPatch: () => ({}),
  },
});
mock.module('../tasks/worker-terminal-contract.js', {
  namedExports: { validateTerminalSignalArtifacts: async () => ({ ok: true }) },
});
mock.module('../runners/launch-command.js', {
  namedExports: {
    buildLaunchCommand: () => '',
    modelQuestionsForRun: () => [],
    RUNNER_LAUNCH_READY_TIMEOUT_MS: 1,
  },
});
mock.module('../node-support/ensure.js', {
  namedExports: { ensureNodeSupportBundle: async () => undefined },
});
mock.module('../run-engine/stack-base.js', {
  namedExports: { publicationBaseForRun: async () => 'main' },
});
mock.module('../runners/scripted-config.js', {
  namedExports: { scriptedRelaunchOptions: async () => ({}) },
});
mock.module('../runners/observability-files.js', {
  namedExports: { runnerActivityIsBusy: () => false },
});
let currentRun: Run;
const getRun = (_id: string) => currentRun;
const updateRun = (_id: string, patch: Partial<Run>) => Object.assign(currentRun, patch);
mock.module('../runs/store.js', {
  namedExports: {
    getRun,
    updateRun,
    deleteRun: () => {},
    clearRunActiveTaskFile: () => {},
    updateRunStep: (_id: string, name: string, patch: Partial<Run['steps'][number]>) => {
      const step = currentRun.steps.find((s) => s.name === name);
      if (!step) throw new Error(`Missing step ${name}`);
      Object.assign(step, patch);
    },
  },
});
const { makeRun } = await import('../run-engine/test-fixtures.js');
const { tryInlineCIFix } = await import('./inline-fix.js');
after(() => rmSync(root, { recursive: true, force: true }));

function fixture() {
  completed = false;
  signal = outside = true;
  scopeMissing = false;
  files.clear();
  deliveries = verifications = 0;
  currentRun = makeRun({
    flowType: 'dev',
    project: 'example-web-farm',
    ticketOrPr: 'F415',
    slotId: 'fixture-slot',
    branch: 'fix/product',
    taskFile: '/fixture/tasks/f415/TASK.md',
    steps: [{ name: 'ci-watch', status: 'running', outputs: {} }],
  });
  return currentRun;
}

async function finishFix(t: import('node:test').TestContext, runId: string) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deadline = AbortSignal.timeout(1500);
  const fixing = tryInlineCIFix(
    runId,
    'fixture-slot',
    [],
    ['lint'],
    42,
    'example/product',
    deadline,
  );
  while (
    getRun(runId)?.steps.find((s) => s.name === 'ci-watch')?.outputs?.phase !== 'waiting_for_worker'
  ) {
    assert.equal(deadline.aborted, false, 'CI fix did not reach its completion wait');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  completed = true;
  t.mock.timers.tick(30_000);
  return fixing;
}

test(
  'project override receives the engine scope block and scoped push',
  { timeout: 2000 },
  async (t) => {
    const run = fixture();
    await finishFix(t, run.id);
    const document = files.get('.task/f415/CI-FIX.md') ?? '';
    assert.ok(
      document.includes(
        '## CI fix scope\n\nChange only these files. Never edit CI configuration, workflows or timeouts. If a real fix needs any other file, or a failure is infrastructure, do not patch it. Mark blocked with the reason.\n\n- "src/old.ts"\n- "src/product.ts"',
      ),
    );
    assert.deepEqual(JSON.parse(files.get('.task/f415/inputs/ci-fix-scope.json') ?? '{}'), scope);
    assert.ok(document.includes(JSON.stringify(scope).replaceAll("'", "'\"'\"'")));
  },
);

for (const hasSignal of [true, false]) {
  test(
    `out-of-scope completion is blocked with ${hasSignal ? 'signal' : 'HEAD change'}`,
    { timeout: 2000 },
    async (t) => {
      const run = fixture();
      signal = hasSignal;
      const result = await finishFix(t, run.id);
      assert.equal(result?.success, false);
      assert.equal(result?.blocked, true);
      assert.equal(
        result?.blockedReason,
        'Branch maintenance refused: CI_FIX_OUT_OF_SCOPE: .github/workflows/validate.yml',
      );
      assert.equal(verifications, 1);
      assert.equal(deliveries, 1);
      const next = await tryInlineCIFix(
        run.id,
        'fixture-slot',
        [],
        ['lint'],
        42,
        'example/product',
        new AbortController().signal,
      );
      assert.equal(next?.blockedReason, result?.blockedReason);
      assert.equal(deliveries, 1);
    },
  );
}

test('an owned fix completes after the shared scope verification', { timeout: 2000 }, async (t) => {
  const run = fixture();
  outside = false;
  const result = await finishFix(t, run.id);
  assert.equal(result?.success, true);
  assert.equal(verifications, 1);
  assert.equal(run.ciWatchState?.fixScopeRefusal, undefined);
});

function recoverFixture() {
  const run = fixture();
  run.agentContexts = [
    {
      id: 'ci-fix',
      role: 'ci-fix',
      label: 'CI fix',
      status: 'working',
      slotId: run.slotId,
      runId: run.id,
      runner: 'fixture',
      taskFile: '.task/f415/CI-FIX.md',
      signalFile: '.task/f415/CI-FIX-SIGNAL.json',
      promptDeliveryStartedAt: '2026-11-01T00:00:00Z',
      deliveryBaselineRef: headSha,
      deliveryBaselinePanePid: '123',
      target: { session: 'fixture', target: 'fixture:dev' },
    },
  ];
  return run;
}

test(
  'recovered completion uses the original scope without rewriting the task',
  { timeout: 2000 },
  async (t) => {
    const run = recoverFixture();
    const result = await finishFix(t, run.id);
    assert.equal(result?.success, false);
    assert.equal(
      result?.blockedReason,
      'Branch maintenance refused: CI_FIX_OUT_OF_SCOPE: .github/workflows/validate.yml',
    );
    assert.equal(verifications, 1);
    assert.equal(files.size, 0);
  },
);

test('recovery with missing scope blocks before a new nudge', { timeout: 2000 }, async () => {
  const run = recoverFixture();
  scopeMissing = true;
  const result = await tryInlineCIFix(
    run.id,
    'fixture-slot',
    [],
    ['lint'],
    42,
    'example/product',
    AbortSignal.timeout(1500),
  );
  assert.equal(result?.success, false);
  assert.equal(result?.blockedReason, 'Cannot recover CI fix scope: CI_FIX_SCOPE_MISSING');
  assert.equal(deliveries, 0);
  assert.equal(files.size, 0);
});
