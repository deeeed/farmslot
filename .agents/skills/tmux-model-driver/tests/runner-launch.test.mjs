import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runnerLaunch } from '../scripts/runner-launch.mjs';

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
    assert.equal(claude.observability_dir, path.join(dir, 'runtime', '.observability'));
    const codex = runnerLaunch({ ...lane, runner: 'codex' });
    assert.ok(codex.command.includes('codex'));
    assert.ok(codex.command.includes('check_for_update_on_startup=false'));
    assert.equal(codex.goal_supported, true);
    for (const resume_id of [undefined, 'fixture-session']) {
      const routed = runnerLaunch({
        ...lane,
        runner: 'codex',
        resume_id,
        account_label: 'fixture-account',
        env: { ROUTE_PROFILE: 'fixture-route' },
      });
      assert.ok(routed.command.startsWith("export ROUTE_PROFILE='fixture-route' && "));
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
