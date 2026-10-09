import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    assert.match(a, /FARMSLOT_CODEX_PLUGIN_HOOK_ARG_1='--config'/);
    assert.match(a, /FARMSLOT_CODEX_PLUGIN_HOOK_ARG_2='features\.hooks=true'/);
    assert.match(a, /unset CODEX_HOME; export FARMSLOT_CODEX_PLUGIN_HOOK_ARG_1='--disable'/);
    assert.match(a, /FARMSLOT_CODEX_PLUGIN_HOOK_ARG_2='plugin_hooks'/);
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
    assert.match(
      launch,
      /codex "\$FARMSLOT_CODEX_PLUGIN_HOOK_ARG_1" "\$FARMSLOT_CODEX_PLUGIN_HOOK_ARG_2"/,
    );
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

describe('codex launch picks the isolated home only when the install completed it', () => {
  // Runs the real setup snippet in sh and reports which home and hook flags it chose.
  const chosen = (repo: string) =>
    execFileSync(
      '/bin/sh',
      [
        '-c',
        `${buildCodexHomeSetup(repo, '.agent')} && printf '%s|%s' "\${CODEX_HOME:-global}" "$FARMSLOT_CODEX_PLUGIN_HOOK_ARG_1"`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );

  it('uses codex-home with hooks for a linked auth.json or a provider-auth marker, else global', (t) => {
    const repo = mkdtempSync(path.join(tmpdir(), 'codex-home-gate-'));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    const home = path.join(repo, '.agent', 'codex-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'config.toml'), '');

    assert.equal(chosen(repo), 'global|--disable');

    // codex-lb routing: no auth.json to link, the installer leaves the marker.
    writeFileSync(path.join(home, '.farmslot-provider-auth'), 'codex-lb\n');
    assert.equal(chosen(repo), `${home}|--config`);

    rmSync(path.join(home, '.farmslot-provider-auth'));
    writeFileSync(path.join(repo, 'auth-source.json'), '{}');
    symlinkSync(path.join(repo, 'auth-source.json'), path.join(home, 'auth.json'));
    assert.equal(chosen(repo), `${home}|--config`);
  });
});

describe('codex resume stays on the home that holds its session', () => {
  it('resumes a global-home session on the global home, others on codex-home', (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'codex-home-resume-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = path.join(root, 'repo');
    const home = path.join(repo, '.agent', 'codex-home');
    const fakeHome = path.join(root, 'home');
    mkdirSync(path.join(fakeHome, '.codex', 'sessions', '2026', '10', '09'), { recursive: true });
    mkdirSync(path.join(home, 'sessions', '2026', '10', '09'), { recursive: true });
    writeFileSync(path.join(home, '.farmslot-provider-auth'), 'codex-lb\n');
    const rollout = (dir: string, id: string) =>
      writeFileSync(
        path.join(dir, '2026', '10', '09', `rollout-2026-10-09T08-00-00-${id}.jsonl`),
        '',
      );
    rollout(path.join(fakeHome, '.codex', 'sessions'), 'started-before-deploy');
    rollout(path.join(home, 'sessions'), 'started-isolated');
    const chosenFor = (resumeSessionId: string) =>
      execFileSync(
        '/bin/sh',
        [
          '-c',
          `${buildCodexHomeSetup(repo, '.agent', { resumeSessionId })} && printf '%s' "\${CODEX_HOME:-global}"`,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, HOME: fakeHome },
        },
      );

    assert.equal(chosenFor('started-before-deploy'), 'global');
    assert.equal(chosenFor('started-isolated'), home);
    assert.equal(chosenFor('never-seen'), home);
  });
});
