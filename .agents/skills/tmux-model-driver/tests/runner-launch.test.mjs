import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runnerRuntimeDir } from '../../../../scripts/lib/runner-runtime.cjs';
import { persistentLaneCommand, runnerLaunch } from '../scripts/runner-launch.mjs';

test('lane launcher delegates fresh and resumed commands to shared runner adapters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-launch-test-'));
  try {
    const lane = {
      id: 'fixture',
      cwd: dir,
      runtime_dir: path.join(dir, 'runtime'),
      model: 'fixture-model',
      safety_tier: 'dangerous',
    };
    const claude = runnerLaunch({ ...lane, runner: 'claude' });
    assert.ok(claude.command.includes('install-runner-observability.mjs'));
    assert.ok(claude.command.includes('--dangerously-skip-permissions'));
    assert.equal(claude.goal_supported, false);
    assert.equal(
      claude.observability_dir,
      path.join(runnerRuntimeDir(fs.realpathSync(dir), 'runtime'), '.observability'),
    );
    const codex = runnerLaunch({ ...lane, runner: 'codex' });
    assert.ok(codex.command.includes('codex'));
    assert.ok(codex.command.includes('check_for_update_on_startup=false'));
    assert.equal(codex.goal_supported, true);
    for (const resume_id of [undefined, 'configured-session']) {
      const configured = runnerLaunch({ ...lane, runner: 'codex', effort: 'xhigh', resume_id });
      assert.ok(configured.command.includes('fixture-model'));
      assert.match(configured.command, /model_reasoning_effort.*xhigh/);
      assert.ok(configured.command.includes('check_for_update_on_startup=false'));
    }
    for (const resume_id of [undefined, 'fixture-session']) {
      const routed = runnerLaunch({
        ...lane,
        runner: 'codex',
        resume_id,
        account_label: 'fixture-account',
        env: { ROUTE_PROFILE: 'fixture-route' },
      });
      assert.ok(routed.command.includes("export ROUTE_PROFILE='fixture-route' && "));
      assert.ok(routed.command.includes("--account-label 'fixture-account'"));
    }
    assert.ok(
      runnerLaunch({ ...lane, runner: 'claude', resume_id: 'fixture-session' }).command.includes(
        "--resume 'fixture-session'",
      ),
    );
    assert.ok(
      runnerLaunch({ ...lane, runner: 'codex', resume_id: 'fixture-session' }).command.includes(
        ' resume',
      ),
    );
    assert.throws(
      () => runnerLaunch({ ...lane, runner: 'claude', safety_tier: 'invented' }),
      /safety_tier/,
    );
    assert.throws(
      () => runnerLaunch({ ...lane, runner: 'claude', goal_command: '/goal' }),
      /local goal skill/,
    );
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'goal'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'skills', 'goal', 'SKILL.md'), '# goal');
    assert.equal(
      runnerLaunch({ ...lane, runner: 'claude', goal_command: '/goal' }).goal_supported,
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('lane shell survives successful and failed exec runner exits under errexit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-exit-test-'));
  try {
    const shell = path.join(dir, 'shell');
    const marker = path.join(dir, 'shell-started');
    fs.writeFileSync(shell, '#!/bin/sh\nprintf "%s" "$*" > "$LANE_SHELL_MARKER"\n', {
      mode: 0o700,
    });
    for (const code of [0, 7]) {
      const result = spawnSync(
        'bash',
        ['-ec', persistentLaneCommand(`exec sh -c 'exit ${code}'`)],
        {
          env: { ...process.env, SHELL: shell, LANE_SHELL_MARKER: marker },
          encoding: 'utf8',
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(marker, 'utf8'), '-i');
      assert.ok(result.stdout.includes(`status ${code}`));
      fs.unlinkSync(marker);
    }
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

for (const symlinked of [false, true]) {
  test(`legacy ${symlinked ? 'symlinked' : 'direct'} lane migrates the original home before retained resume`, () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-legacy-runtime-'));
    const actualRepo = path.join(scratch, 'product');
    fs.mkdirSync(actualRepo);
    const repo = symlinked ? path.join(scratch, 'linked-slot') : actualRepo;
    if (symlinked) fs.symlinkSync(actualRepo, repo, 'dir');
    const original = path.join(repo, '.agent');
    fs.mkdirSync(path.join(original, 'codex-home/sessions'), { recursive: true });
    fs.mkdirSync(path.join(original, '.observability'), { recursive: true });
    fs.writeFileSync(path.join(original, 'codex-home/sessions/retained.jsonl'), 'retained history');
    fs.writeFileSync(path.join(original, '.observability/hooks.jsonl'), 'retained observations');
    try {
      const launch = runnerLaunch({
        id: 'fixture',
        cwd: repo,
        runtime_dir: original,
        runner: 'claude',
        model: 'fixture',
        resume_id: 'retained',
      });
      const installer = launch.command.match(
        /node '[^']+install-runner-observability\.mjs' --runner 'claude'.*? --slot-id 'fixture'/,
      );
      assert.ok(installer);
      const result = spawnSync('/bin/bash', ['-c', installer[0]], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(fs.lstatSync(path.join(original, 'codex-home')).isSymbolicLink());
      assert.equal(
        fs.readFileSync(
          path.join(launch.runtime_dir, 'codex-home/sessions/retained.jsonl'),
          'utf8',
        ),
        'retained history',
      );
      assert.equal(
        fs.readFileSync(path.join(original, '.observability/hooks.jsonl'), 'utf8'),
        'retained observations',
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
}
