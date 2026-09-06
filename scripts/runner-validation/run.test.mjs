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
import { evaluateDependencyTerminal } from './scenarios/resource-posture-smoke.mjs';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/panes');

test('dispatch-model-flag fails when named explicitly without its required arguments', async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-model-flag-args-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const scenario = await import('./scenarios/dispatch-model-flag.mjs');

  // Named on the command line, missing --slot/--model is an operator error.
  const explicit = await scenario.runScenario({
    timeoutMs: 1000,
    outDir,
    runner: 'cursor',
    explicit: true,
  });
  assert.equal(explicit.pass, false);
  assert.equal(Boolean(explicit.skipped), false);
  assert.match(explicit.report.error, /needs --slot/);

  // Reached through the full matrix there is nothing to supply, so it skips.
  const matrix = await scenario.runScenario({ timeoutMs: 1000, outDir, runner: 'cursor' });
  assert.equal(matrix.skipped, true);
  assert.equal(matrix.pass, true);
});

test('session-reopen-smoke reopens in a fresh window and keeps pane text out of its evidence', () => {
  const source = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'scenarios/session-reopen-smoke.mjs',
    ),
    'utf8',
  );

  // The interrupt destroys the role window (dispatch sets remain-on-exit off
  // plus a pane-died kill-pane hook), so the reopen must open its own window
  // instead of typing into whatever tmux resolves the stale target to.
  assert.match(source, /rpc\('tmux\.newWindow', \{ slotId, bareSession: true \}\)/);
  assert.match(source, /pasteCommandToCurrentWindow\(slotId, session\.reopenCommand\)/);
  // Liveness and the session id are the pass evidence; the pane tail is only
  // captured on failure and is labelled as diagnostic.
  assert.match(source, /report\.diagnosticPaneTail = diagnosticPaneTail\(/);
  assert.match(source, /never pass evidence/);
  assert.match(source, /report\.targetWasRediscovered = reopened\.rediscoveredTarget === true/);
});

test('session-reopen-smoke interrupts through the runner capability and demands structured death', () => {
  const source = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'scenarios/session-reopen-smoke.mjs',
    ),
    'utf8',
  );

  // The stop input comes from the runner registry via run.sessionCommand.
  assert.match(source, /session\.interrupt\.command/);
  assert.doesNotMatch(source, /sendLine\([^)]*'\/exit'/);
  // `unknown` means the probe could not decide; accepting it would let the
  // reopen pass without a confirmed interruption.
  assert.match(source, /state\.liveness === 'dead'/);
  assert.doesNotMatch(source, /state\.liveness !== 'live'/);
  // AC1 scope is stated rather than silently skipped.
  assert.match(source, /nudge path is unit-covered/);
});

test('session-reopen-smoke pastes the reopen command atomically and fails fast', () => {
  const source = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'scenarios/session-reopen-smoke.mjs',
    ),
    'utf8',
  );

  // Typed delivery chunks a ~3 KB command and strands zsh at a `quote>` prompt.
  assert.match(
    source,
    /rpc\('tmux\.pasteText', \{ slotId, bareSession: true, text, submit: true \}\)/,
  );
  assert.doesNotMatch(source, /sendLineToCurrentWindow/);
  // A shell that never started the command must fail in seconds, not after the
  // full liveness timeout, and must carry the diagnostic tail.
  assert.match(source, /waitForReopenToRegister\(runId, context\.id\)/);
  assert.match(source, /pasted reopen command was never recognized in pane/);
  // The guard names the pane it inspected, so a misfire is diagnosable.
  // The pane tmux reported creating, not whichever pane happens to be active:
  // the session's active pane can belong to a different window.
  assert.match(source, /reopenPaneId = reopenWindow\?\.paneId/);
  assert.match(source, /paneById\(slotId, reopenPaneId\)/);
  assert.doesNotMatch(source, /function activePane\(/);
  // Cleanup addresses the pane by `%N`; a bare window index is not a valid
  // tmux pane target and the kill silently fails.
  // Slot-target validation rejects a bare `%N` AND a bare window index; the
  // killable address is `session:index`.
  assert.match(source, /rpc\('tmux\.killPane', \{ slotId, target: reopenWindowTarget \}\)/);
  assert.match(source, /\$\{reopenWindow\.sessionName\}:\$\{reopenWindow\.windowIndex\}/);
  assert.doesNotMatch(source, /target: `\$\{reopenWindowIndex\}`/);
  // `pane_current_command` stays the login shell while `bash -lc` runs
  // children, so it must not be the signal the guard trips on.
  assert.doesNotMatch(source, /pane command: \$\{/);
  assert.doesNotMatch(source, /currentCommand &&/);
});

test('session-reopen-smoke reads the pane tail from the snapshot lines array', () => {
  const source = fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'scenarios/session-reopen-smoke.mjs',
    ),
    'utf8',
  );

  // terminal.snapshot answers `{ lines: string[] }`. Reading `data`/`text` is
  // why an earlier failure reported an empty tail for a pane with 40+ lines.
  assert.match(source, /Array\.isArray\(snapshot\?\.lines\)/);
  assert.match(source, /snapshot\.lines\.slice\(-lines\)/);
  assert.doesNotMatch(source, /snapshot\?\.data \?\? snapshot\?\.text/);
  // A capture that fails must say so instead of yielding an empty tail.
  assert.match(source, /report\.diagnosticPaneTailError = /);
});

test('runner-validation catalog includes four runners and twenty-seven scenarios', () => {
  assert.deepEqual(listRunners().sort(), ['claude', 'codex', 'cursor', 'grok']);
  assert.equal(listScenarios().length, 27);
  assert.ok(listScenarios().includes('review-recovery-terminal-contract'));
  assert.ok(listScenarios().includes('self-review-fix-turn-lease'));
  assert.ok(listScenarios().includes('hook-smoke'));
  assert.ok(listScenarios().includes('pane-smoke'));
  assert.ok(listScenarios().includes('interaction-smoke'));
  assert.ok(listScenarios().includes('machine-pause-restore-smoke'));
  assert.ok(listScenarios().includes('dispatch-prompt-trust'));
  assert.ok(listScenarios().includes('retained-handoff-smoke'));
  assert.ok(listScenarios().includes('warm-replacement-smoke'));
  assert.ok(listScenarios().includes('terminal-order-smoke'));
  assert.ok(listScenarios().includes('terminal-fence-restart'));
  assert.ok(listScenarios().includes('copilot-runtime-smoke'));
  assert.ok(listScenarios().includes('retained-safe-send-smoke'));
  assert.ok(listScenarios().includes('session-attribution-smoke'));
  assert.ok(listScenarios().includes('token-usage-smoke'));
  assert.ok(listScenarios().includes('monitor-stuck-smoke'));
  assert.ok(listScenarios().includes('dispatch-model-flag'));
  assert.ok(listScenarios().includes('session-reopen-smoke'));
  assert.ok(listScenarios().includes('resource-posture-smoke'));
});

test('session-reopen-smoke fails when named explicitly without a slot and never stubs real evidence', async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reopen-args-'));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const scenario = await import('./scenarios/session-reopen-smoke.mjs');

  const explicit = await scenario.runScenario({ timeoutMs: 1000, outDir, explicit: true });
  assert.equal(explicit.pass, false);
  assert.equal(Boolean(explicit.skipped), false);
  assert.match(explicit.report.error, /needs --slot/);

  // A real run's evidence must survive a later matrix skip on the same host.
  const evidenceFile = explicit.outPath;
  fs.writeFileSync(evidenceFile, JSON.stringify({ pass: true, marker: 'real-run' }));
  const matrix = await scenario.runScenario({ timeoutMs: 1000, outDir });
  assert.equal(matrix.skipped, true);
  assert.equal(matrix.pass, true);
  assert.equal(JSON.parse(fs.readFileSync(evidenceFile, 'utf8')).marker, 'real-run');
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

test('resource-posture dependency terminal verdict rejects bad state and bad order', () => {
  const stopped = (id) => ({
    capabilityId: id,
    desiredDisposition: 'stopped',
    observedState: 'stopped',
  });
  const pair = { dependent: 'ios-simulator', dependency: 'companion-metro' };

  assert.deepEqual(
    evaluateDependencyTerminal({
      ...pair,
      terminalStates: [stopped(pair.dependent), stopped(pair.dependency)],
      releaseOrder: [pair.dependent, pair.dependency],
    }),
    { pass: true, error: null },
  );

  // The deliberate break: dependency released before its dependent.
  const inverted = evaluateDependencyTerminal({
    ...pair,
    terminalStates: [stopped(pair.dependent), stopped(pair.dependency)],
    releaseOrder: [pair.dependency, pair.dependent],
  });
  assert.equal(inverted.pass, false);
  assert.match(inverted.error, /companion-metro was released before ios-simulator/);

  // A capability left running is not a pass either.
  const running = evaluateDependencyTerminal({
    ...pair,
    terminalStates: [
      { capabilityId: pair.dependent, desiredDisposition: 'stopped', observedState: 'running' },
      stopped(pair.dependency),
    ],
    releaseOrder: [pair.dependent, pair.dependency],
  });
  assert.equal(running.pass, false);
  assert.match(running.error, /ended stopped\/running/);

  // Missing events cannot be read as ordered.
  const missing = evaluateDependencyTerminal({
    ...pair,
    terminalStates: [stopped(pair.dependent), stopped(pair.dependency)],
    releaseOrder: [pair.dependent],
  });
  assert.equal(missing.pass, false);
  assert.match(missing.error, /missing release events/);
});
