import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runnerPromptDigest } from './lib/digest.mjs';
import { turnBoundaryOrdered } from './lib/hooks.mjs';
import { paneShowsBusyComposer, paneShowsBypassPermissions } from './lib/pane-patterns.mjs';
import { listRunners } from './runners/index.mjs';
import { listScenarios } from './scenarios/index.mjs';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/panes');

test('runner-validation catalog includes claude and codex scenarios', () => {
  assert.deepEqual(listRunners().sort(), ['claude', 'codex']);
  assert.equal(listScenarios().length, 5);
  assert.ok(listScenarios().includes('hook-smoke'));
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