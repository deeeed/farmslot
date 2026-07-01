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
  grokCwdMatches,
  modelsMatch,
  selfTestChooseRunnerSessionPath,
} from './lib/session-attribution.mjs';
import { usageExtractedOk } from './lib/session-usage-harness.mjs';
import { listRunners, resolveRunnerList } from './runners/index.mjs';
import { listScenarios } from './scenarios/index.mjs';

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/panes');

test('runner-validation catalog includes four runners and nine scenarios', () => {
  assert.deepEqual(listRunners().sort(), ['claude', 'codex', 'cursor', 'grok']);
  assert.equal(listScenarios().length, 9);
  assert.ok(listScenarios().includes('hook-smoke'));
  assert.ok(listScenarios().includes('pane-smoke'));
  assert.ok(listScenarios().includes('interaction-smoke'));
  assert.ok(listScenarios().includes('session-attribution-smoke'));
  assert.ok(listScenarios().includes('token-usage-smoke'));
});

test('runner groups resolve grok in pane-only preset', () => {
  assert.deepEqual(resolveRunnerList('pane-only').sort(), ['cursor', 'grok']);
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
  selfTestChooseRunnerSessionPath();
});

test('session-usage harness usageExtractedOk requires turns and total tokens', () => {
  assert.equal(usageExtractedOk({ turns: 1, total_tokens: 42 }), true);
  assert.equal(usageExtractedOk({ turns: 0, total_tokens: 0 }), false);
});
