import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCodexHomeSetup, buildLaunchCommand } from './launch-command.js';
import { buildRunnerObservabilityInstallCommand } from './runner-observability.js';
import { makeVars } from './test-fixtures.js';

describe('codex account binding leaves launch home setup unchanged', () => {
  it('buildCodexHomeSetup is byte-identical regardless of account', () => {
    const a = buildCodexHomeSetup('/tmp/repo', '.agent');
    const b = buildCodexHomeSetup('/tmp/repo', '.agent');
    assert.equal(a, b);
    assert.match(a, /export CODEX_HOME=/);
  });

  it('install command carries --account-label (node resolves path); launch still exports CODEX_HOME', () => {
    const vars = makeVars({ slotId: 'macwork-ff-1', remoteRepo: '/tmp/repo' });
    const installA = buildRunnerObservabilityInstallCommand(vars, 'codex', '/tmp/repo', '.agent', {
      accountLabel: 'codex-a',
    });
    const installB = buildRunnerObservabilityInstallCommand(vars, 'codex', '/tmp/repo', '.agent', {
      accountLabel: 'codex-b',
    });
    assert.match(installA, /--account-label 'codex-a'/);
    assert.match(installB, /--account-label 'codex-b'/);
    assert.doesNotMatch(installA, /--auth-source/);
    assert.notEqual(installA, installB);

    const launch = buildLaunchCommand(vars, 'codex', 'gpt-5.5', 'do work', {
      runtimeDir: '.agent',
      codexAccountLabel: 'codex-a',
      taskDir: '/tmp/repo/.task/x',
    });
    assert.match(launch, /--account-label 'codex-a'/);
    assert.match(launch, /export CODEX_HOME=/);
  });

  it('non-codex runners do not gain account-label install flags', () => {
    const vars = makeVars({ slotId: 'macwork-ff-1', remoteRepo: '/tmp/repo' });
    const launch = buildLaunchCommand(vars, 'claude', 'sonnet', 'do work', {
      runtimeDir: '.agent',
      codexAccountLabel: 'codex-a',
      claudeUsesDispatchCmd: false,
    });
    assert.doesNotMatch(launch, /--account-label/);
    assert.doesNotMatch(launch, /--auth-source/);
  });
});
