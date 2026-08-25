import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runnerPromptDigest } from './lib/digest.mjs';
import { turnBoundaryOrdered } from './lib/hooks.mjs';
import { detectLaunchBlocker } from './lib/pane-blockers.mjs';
import { paneShowsBusyComposer, paneShowsBypassPermissions } from './lib/pane-patterns.mjs';
import {
  ATTRIBUTION_MODELS,
  grokCwdMatches,
  modelsMatch,
  selfTestChooseRunnerSessionPath,
  STALE_MODELS,
} from './lib/session-attribution.mjs';
import { usageExtractedOk } from './lib/session-usage-harness.mjs';
import { listRunners, resolveRunnerList } from './runners/index.mjs';
import { listScenarios } from './scenarios/index.mjs';
import {
  runBinding as machinePauseRunBinding,
  runScenario as runMachinePauseScenario,
} from './scenarios/machine-pause-restore-smoke.mjs';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/panes');

test('runner-validation catalog includes four runners and twenty-one scenarios', () => {
  assert.deepEqual(listRunners().sort(), ['claude', 'codex', 'cursor', 'grok']);
  assert.equal(listScenarios().length, 21);
  assert.ok(listScenarios().includes('review-recovery-terminal-contract'));
  assert.ok(listScenarios().includes('self-review-fix-turn-lease'));
  assert.ok(listScenarios().includes('hook-smoke'));
  assert.ok(listScenarios().includes('pane-smoke'));
  assert.ok(listScenarios().includes('interaction-smoke'));
  assert.ok(listScenarios().includes('machine-pause-restore-smoke'));
  assert.ok(listScenarios().includes('dispatch-prompt-trust'));
  assert.ok(listScenarios().includes('retained-handoff-smoke'));
  assert.ok(listScenarios().includes('copilot-runtime-smoke'));
  assert.ok(listScenarios().includes('retained-safe-send-smoke'));
  assert.ok(listScenarios().includes('session-attribution-smoke'));
  assert.ok(listScenarios().includes('token-usage-smoke'));
  assert.ok(listScenarios().includes('monitor-stuck-smoke'));
});

test('self-review routes argv-relaunch handoffs to cold process replacement', () => {
  const source = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../services/gateway/src/self-review/review-agent.ts',
    ),
    'utf8',
  );
  assert.match(source, /runnerRetainedSessionHandoff\(runner\) === 'argv-relaunch'/);
});

test('run-monitor stuck path calls production observability evaluator, not pane progress scrape', () => {
  const source = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../services/gateway/src/run-engine/run-monitor.ts',
    ),
    'utf8',
  );
  assert.match(source, /evaluateMonitorStuckForRunner/);
  assert.doesNotMatch(source, /runnerPaneShowsCurrentInteractiveProgress/);
});

test('machine pause/restore scenario uses production RPCs and structured continuity proof only', () => {
  const source = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'scenarios/machine-pause-restore-smoke.mjs',
    ),
    'utf8',
  );
  for (const method of [
    'machine.pause.preview',
    'machine.pause.execute',
    'machine.pause.status',
    'machine.pause.restore',
  ]) {
    assert.match(source, new RegExp(`['"]${method.replaceAll('.', '[.]')}['"]`));
  }
  assert.match(source, /recoveryProof/);
  assert.match(source, /acknowledgement[?][.]kind === 'structured'/);
  assert.match(source, /fleetStatus[.]fleet[.]slots[.]find/);
  assert.match(source, /const cleanupStatus = rpc\('machine[.]pause[.]status'/);
  assert.doesNotMatch(source, /report[.]machine && report[.]parkedRecord/);
  assert.doesNotMatch(source, /capture-pane|paneTail|innerText/);
});

test('machine pause/restore unsupported runner is a non-green skip', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-pause-skip-'));
  try {
    const result = await runMachinePauseScenario({
      runnerAdapter: { RUNNER_ID: 'cursor' },
      timeoutMs: 100,
      outDir,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.pass, false);
    assert.equal(result.report.pass, false);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('machine pause/restore missing run id is a non-green skip', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-pause-missing-run-'));
  const previous = process.env.FARMSLOT_MACHINE_PAUSE_RUN_ID;
  delete process.env.FARMSLOT_MACHINE_PAUSE_RUN_ID;
  try {
    const result = await runMachinePauseScenario({
      runnerAdapter: { RUNNER_ID: 'codex' },
      timeoutMs: 100,
      outDir,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.pass, false);
    assert.equal(result.report.pass, false);
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_MACHINE_PAUSE_RUN_ID;
    else process.env.FARMSLOT_MACHINE_PAUSE_RUN_ID = previous;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('machine pause/restore binding resolves the dev flow primary atomically', () => {
  const binding = machinePauseRunBinding({
    flowType: 'dev',
    metrics: {
      runner: 'codex',
      runnerSessionId: 'metrics-session',
      runnerSessionPath: '/sessions/metrics.jsonl',
    },
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        runner: 'codex',
        runnerSessionId: 'dev-session',
        runnerSessionPath: null,
        target: { session: 'ff-1', window: 'dev', target: 'ff-1:dev' },
      },
      {
        id: 'legacy-primary',
        role: 'primary',
        runnerSessionId: 'wrong-session',
        runnerSessionPath: '/sessions/wrong.jsonl',
      },
    ],
  });
  assert.deepEqual(binding, {
    runnerId: 'codex',
    sessionId: 'dev-session',
    sessionPath: null,
    contextId: 'dev',
    target: { session: 'ff-1', window: 'dev', target: 'ff-1:dev' },
  });
});

test('runner groups reserve pane-only for runners without structured observability', () => {
  assert.deepEqual(resolveRunnerList('pane-only'), ['cursor']);
  assert.ok(resolveRunnerList('all').includes('grok'));
});

test('grok project-directory blocker detection matches gateway contract', () => {
  const pane = `
  Run Grok Build in a project directory?
  1 (○) probe (current)
  Enter:submit
`;
  assert.equal(detectLaunchBlocker(pane, 'grok')?.kind, 'project-directory');
  assert.equal(detectLaunchBlocker(pane, 'cursor'), null);
});

test('grok directory-trust fixture matches project-directory blocker contract', () => {
  const pane = fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures/grok-project-directory-trust.txt',
    ),
    'utf8',
  );
  const blocker = detectLaunchBlocker(pane, 'grok');
  assert.equal(blocker?.kind, 'project-directory');
  assert.equal(blocker?.autoAction, 'grok-select-current-project');
});

test('cursor workspace-trust blocker detection matches gateway contract', () => {
  const pane = `[a] trust this workspace
[q] quit
use arrow keys to navigate`;
  assert.equal(detectLaunchBlocker(pane, 'cursor')?.kind, 'workspace-trust');
  assert.equal(detectLaunchBlocker(pane, 'grok'), null);
});

test('busy-composer fixture distinguishes composing vs idle', () => {
  const composing = fs.readFileSync(path.join(FIXTURE_DIR, 'claude-composing.txt'), 'utf8');
  const idle = fs.readFileSync(path.join(FIXTURE_DIR, 'claude-idle.txt'), 'utf8');
  assert.equal(paneShowsBusyComposer(composing), true);
  assert.equal(paneShowsBusyComposer(idle), false);
  assert.equal(paneShowsBypassPermissions(idle), true);
});

test('turn-boundary ordering requires Stop after UserPromptSubmit', () => {
  const pass = turnBoundaryOrdered([
    { hook_event_name: 'UserPromptSubmit', observedAt: 100 },
    { hook_event_name: 'Stop', observedAt: 200 },
  ]);
  assert.equal(pass.pass, true);
  const fail = turnBoundaryOrdered([
    { hook_event_name: 'Stop', observedAt: 100 },
    { hook_event_name: 'UserPromptSubmit', observedAt: 200 },
  ]);
  assert.equal(fail.pass, false);
});

test('runnerPromptDigest matches gateway normalization contract', () => {
  const a = runnerPromptDigest('Reply with exactly TMUX_HOOK_OK and nothing else.');
  const b = runnerPromptDigest('Reply   with exactly TMUX_HOOK_OK and nothing else.');
  assert.equal(a, b);
});

test('grok session paths use realpath repo key on macOS', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-validate-grok-key-'));
  const summaryCwd = fs.realpathSync.native(repo);
  assert.notEqual(repo, summaryCwd);
  assert.equal(grokCwdMatches(summaryCwd, repo), true);
  assert.equal(grokCwdMatches('/tmp/other', repo), false);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('session-attribution modelsMatch aligns with protocol aliases', () => {
  assert.equal(modelsMatch('opus', 'claude-opus-4-8'), true);
  assert.equal(modelsMatch('opus', 'claude-haiku-4-5'), false);
  assert.equal(ATTRIBUTION_MODELS.grok, 'grok-4.6');
  assert.equal(STALE_MODELS.grok, 'grok-4.5');
  assert.equal(modelsMatch(ATTRIBUTION_MODELS.grok, STALE_MODELS.grok), false);
  selfTestChooseRunnerSessionPath();
});

test('session-usage harness usageExtractedOk requires turns and total tokens', () => {
  assert.equal(usageExtractedOk({ turns: 1, total_tokens: 42 }), true);
  assert.equal(usageExtractedOk({ turns: 0, total_tokens: 0 }), false);
});
