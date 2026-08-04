import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildClaudeObservabilityFallbackCommand,
  withRunnerObservabilityInstall,
} from './runner-observability.js';

test('Claude observability fallback replaces corrupt runtime settings', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'farmslot-claude-settings-'));
  try {
    const settingsPath = path.join(root, '.agent', '.observability', 'claude-settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, '{ invalid json', 'utf8');

    execFileSync('/bin/bash', ['-c', buildClaudeObservabilityFallbackCommand(settingsPath)]);

    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude observability fallback preserves valid runtime settings', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'farmslot-claude-settings-'));
  try {
    const settingsPath = path.join(root, '.agent', '.observability', 'claude-settings.json');
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const settings = '{"hooks":{"Stop":[{"hooks":[]}]}}\n';
    writeFileSync(settingsPath, settings, 'utf8');

    execFileSync('/bin/bash', ['-c', buildClaudeObservabilityFallbackCommand(settingsPath)]);

    assert.equal(readFileSync(settingsPath, 'utf8'), settings);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('successful stale installer still materializes the required Claude settings artifact', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'farmslot-claude-settings-'));
  try {
    const settingsPath = path.join(root, '.agent', '.observability', 'claude-settings.json');
    const launchedPath = path.join(root, 'launched');
    const command = withRunnerObservabilityInstall(
      `printf launched > '${launchedPath}'`,
      ':',
      buildClaudeObservabilityFallbackCommand(settingsPath),
    );

    execFileSync('/bin/bash', ['-c', command]);

    assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), {});
    assert.equal(readFileSync(launchedPath, 'utf8'), 'launched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
