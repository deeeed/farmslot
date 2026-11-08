// Read-only transport proof on caller-selected idle panes; only the settings fixture is writable.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runnerRuntimeDir } from '../lib/runner-runtime.cjs';
import { runnerPaneComposerDraftState } from '../../services/gateway/src/runners/registry.js';
import { normalizeInstructionText } from '../../services/gateway/src/runners/observability-prompt-digest.js';
import { buildClaudeObservabilityFallbackCommand } from '../../services/gateway/src/runners/runner-observability.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const panes = (process.env.GHOST_PROOF_PANES ?? '').split(',').filter(Boolean);
assert(
  panes.length > 0 && panes.every((pane) => /^%\d+$/.test(pane)),
  'Set GHOST_PROOF_PANES to idle pane ids',
);
const baselineRoot = process.env.GHOST_PROOF_BASELINE_ROOT;
const output = path.resolve(
  process.env.FARMSLOT_PROOF_OUT ?? path.join(root, 'temp/ghost-suggestion-proof'),
);
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(path.join(os.tmpdir(), 'ghost-settings-'));
const runtime = path.join(fixture, 'runtime');
const observations = path.join(runnerRuntimeDir(fixture, runtime), '.observability');

interface PaneObservation {
  state: string;
  phase: string;
  queued: boolean;
  queue_kind: string | null;
  session_id: string;
  process_started_at: number;
}

function visibleSuggestion(capture: string): string | undefined {
  return capture
    .split('\n')
    .filter((line) => /^❯(?:\s|$)/.test(normalizeInstructionText(line)))
    .at(-1);
}

function observe(source: string, pane: string): PaneObservation {
  const raw = execFileSync(
    'bash',
    [path.join(source, '.agents/skills/tmux-model-driver/scripts/pane-state.sh'), pane, 'claude'],
    {
      cwd: source,
      env: {
        ...process.env,
        TMUX_MODEL_DRIVER_STATE_DIR: path.join(fixture, 'driver'),
        TMUX_MODEL_DRIVER_READ_ONLY: '1',
      },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  const value: unknown = JSON.parse(raw);
  assert(value && typeof value === 'object');
  assert('state' in value && typeof value.state === 'string');
  assert('phase' in value && typeof value.phase === 'string');
  assert('queued' in value && typeof value.queued === 'boolean');
  assert(
    'queue_kind' in value && (value.queue_kind === null || typeof value.queue_kind === 'string'),
  );
  assert('session_id' in value && typeof value.session_id === 'string');
  assert('process_started_at' in value && typeof value.process_started_at === 'number');
  return {
    state: value.state,
    phase: value.phase,
    queued: value.queued,
    queue_kind: value.queue_kind,
    session_id: value.session_id,
    process_started_at: value.process_started_at,
  };
}

try {
  execFileSync(
    process.execPath,
    [
      path.join(root, 'scripts/install-runner-observability.mjs'),
      '--runner',
      'claude',
      '--repo',
      fixture,
      '--runtime-dir',
      runtime,
      '--slot-id',
      'prompt-suggestion-proof',
    ],
    {
      cwd: root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(fixture, 'empty-account') },
      stdio: 'pipe',
      timeout: 15_000,
    },
  );
  const settingsFile = path.join(observations, 'claude-settings.json');
  const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.equal(settings.promptSuggestionEnabled, false);
  await writeFile(
    settingsFile,
    JSON.stringify({ ...settings, promptSuggestionEnabled: true, retainedMarker: 'kept' }),
  );
  execFileSync('bash', ['-c', buildClaudeObservabilityFallbackCommand(settingsFile)], {
    stdio: 'pipe',
    timeout: 10_000,
  });
  const repaired = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.equal(repaired.promptSuggestionEnabled, false);
  assert.equal(repaired.retainedMarker, 'kept');
  assert.deepEqual(repaired.hooks, settings.hooks);

  const rows = [];
  for (const pane of panes) {
    const ansi = execFileSync('tmux', ['capture-pane', '-p', '-e', '-t', pane, '-S', '-12'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const suggestion = visibleSuggestion(ansi);
    assert(suggestion?.includes('\x1b[2m'), 'Proof needs the real dim suggestion still visible');
    const gatewayGuard = runnerPaneComposerDraftState(ansi, 'claude');
    assert.equal(gatewayGuard, 'empty');
    const before = baselineRoot ? observe(baselineRoot, pane) : null;
    if (before) {
      assert.equal(before.state, 'claude');
      assert.equal(before.queue_kind, 'unowned-buffer');
    }
    const after = observe(root, pane);
    assert.equal(after.state, 'claude');
    assert.equal(after.phase, 'idle');
    assert.equal(after.queued, false);
    assert.equal(after.queue_kind, null);
    if (before) {
      assert.equal(after.session_id, before.session_id);
      assert.equal(after.process_started_at, before.process_started_at);
    }
    const unchanged = execFileSync('tmux', ['capture-pane', '-p', '-e', '-t', pane, '-S', '-12'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(
      visibleSuggestion(unchanged),
      suggestion,
      'Observation must leave the real suggestion untouched',
    );
    rows.push({ pane, before, after, dimSuggestionRemainedVisible: true, gatewayGuard });
  }
  const result = {
    pass: true,
    settingsDisabled: true,
    fallbackPreservesHooks: true,
    panes: rows,
    workerKeysSent: 0,
    runActions: 0,
    providerTurns: 0,
  };
  await writeFile(path.join(output, 'PASS.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await rm(fixture, { recursive: true, force: true });
}
