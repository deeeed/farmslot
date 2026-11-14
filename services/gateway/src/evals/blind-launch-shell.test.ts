import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parse } from 'shell-quote';

import '../runtime/mock-pty.test-support.js';

import { withSlotCommandExecutor } from '../core/exec-scope.js';
import {
  buildDispatchRoleShellCommand,
  buildTmuxRespawnLaunchCommand,
  respawnTmuxPaneWithCommand,
  respawnTmuxWindowWithCommand,
  shellQuote,
} from '../core/tmux.js';
import { buildRoleLaunchCommandWithDiagnosticHold } from '../methods/dispatch/execute.js';
import {
  blindLaunchEnvironment,
  buildLaunchCommand,
  buildRunnerSessionReloadCommand,
} from '../runners/launch-command.js';
import { makeVars } from '../runners/test-fixtures.js';

import { blindLaunchScript, blindLaunchShellCommand } from './blind-git.js';

const POOL_SECRETS = ['JIRA_API_TOKEN', 'NPM_TOKEN', 'CODEX_LB_API_KEY', 'OPENAI_API_KEY'];
const MODEL_KEY = 'FAKE_SECRET-model-key';

function blindVars(root: string) {
  return makeVars({
    machine: 'local',
    remoteRepo: path.join(root, 'repo'),
    piPath: '/synthetic/pi',
    machineEnv: {
      ...Object.fromEntries(POOL_SECRETS.map((name) => [name, `FAKE_SECRET-pool-${name}`])),
      LITELLM_API_KEY: MODEL_KEY,
      LITELLM_URL: 'http://litellm.invalid/v1',
      ANDROID_HOME: '/synthetic/android',
    },
  });
}

const boundary = { capsule: '/synthetic/capsule', baseSha: 'a'.repeat(40) };

test('non-blind tmux launch bodies keep their exact bytes', () => {
  assert.equal(
    buildRoleLaunchCommandWithDiagnosticHold("run 'it'", '/repo'),
    `bash -c ${shellQuote(
      [
        `bash -lc ${shellQuote("run 'it'")}`,
        '__farmslot_status=$?',
        'echo "[farmslot] runner launch command exited $__farmslot_status" >&2',
        'if [ "$__farmslot_status" -ne 0 ]; then',
        '  echo "[farmslot] preserving pane for launch diagnostics" >&2',
        '  sleep 45',
        'fi',
        buildDispatchRoleShellCommand('/repo'),
      ].join('\n'),
    )}`,
  );
  assert.equal(buildTmuxRespawnLaunchCommand('run', '/repo'), "exec bash -lc 'run'");
  assert.match(
    buildTmuxRespawnLaunchCommand('run', '/repo', true),
    /^bash -c 'bash -lc '\\''run'\\''\n/,
  );
});

test('non-blind launches keep the pool environment and a plain bash entry', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blind-launch-shell-'));
  try {
    const vars = blindVars(root);
    const launch = buildLaunchCommand(vars, 'pi', 'litellm/fixture', 'Synthetic task', {
      taskDir: path.join(root, 'task'),
    });
    for (const name of POOL_SECRETS) assert.ok(launch.includes(`FAKE_SECRET-pool-${name}`), name);
    const commands: string[] = [];
    await withSlotCommandExecutor(
      async (_vars, command) => {
        commands.push(command);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      () => respawnTmuxWindowWithCommand(vars, 'fixture:worker', launch),
    );
    const respawn = commands.find((command) => command.includes('respawn-window'))!;
    const entry = parse(respawn.slice(respawn.indexOf('"$TMUX_BIN" '))).at(-1);
    assert.match(String(entry), /^bash '.*\.sh'$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const stage of ['fresh', 'retained'] as const) {
  test(`blind ${stage} launch inlines no pool credential but the model key`, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'blind-launch-shell-'));
    try {
      const vars = blindVars(root);
      const options = { taskDir: path.join(root, 'task'), blindTrialBoundary: boundary };
      const launch =
        stage === 'fresh'
          ? buildLaunchCommand(vars, 'pi', 'litellm/fixture', 'Synthetic task', options)
          : buildRunnerSessionReloadCommand(vars, 'pi', 'litellm/fixture', 'session', options);
      for (const name of POOL_SECRETS) {
        assert.ok(!launch.includes(`FAKE_SECRET-pool-${name}`), `${name} inlined`);
      }
      assert.ok(launch.includes(MODEL_KEY), 'pool model key must still reach the worker');
      assert.match(launch, /export ANDROID_HOME=/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('blind window and pane respawns start from env -i and keep the body out of argv', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blind-launch-shell-'));
  try {
    const vars = blindVars(root);
    const names = blindLaunchEnvironment(vars, 'pi', 'litellm/fixture');
    assert.ok(names.includes('LITELLM_API_KEY'));
    for (const name of POOL_SECRETS) assert.ok(!names.includes(name), name);
    const body = 'synthetic-worker-body';
    const commands: string[] = [];
    await withSlotCommandExecutor(
      async (_vars, command) => {
        commands.push(command);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      async () => {
        await respawnTmuxWindowWithCommand(vars, 'fixture:worker', body, {
          preserveWindowAfterExit: true,
          blindEnvironment: names,
        });
        await respawnTmuxPaneWithCommand(vars, '%7', body, {
          preservePaneAfterExit: true,
          blindEnvironment: names,
        });
      },
    );
    for (const command of commands.filter((entry) => entry.includes('respawn-'))) {
      const entry = String(parse(command.slice(command.indexOf('"$TMUX_BIN" '))).at(-1));
      assert.ok(!entry.includes(body));
      const script = /farmslot-blind-launch '([^']+\.sh)'/.exec(entry)?.[1];
      assert.ok(script, entry);
      assert.equal(entry, blindLaunchShellCommand(shellQuote(script), names));
      assert.equal(
        readFileSync(script, 'utf8'),
        `#!/bin/bash\n${blindLaunchScript(body, [buildDispatchRoleShellCommand(vars.remoteRepo)])}\n`,
      );
    }
    assert.ok(
      buildRoleLaunchCommandWithDiagnosticHold(body, '/repo', true).startsWith(
        `${blindLaunchScript(body)}\n__farmslot_status=$?\n`,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('blind launch shell holds only the base names; the worker subshell gets the admitted ones', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'blind-launch-shell-'));
  try {
    const script = path.join(root, 'launch.sh');
    const report = path.join(root, 'report');
    // Names only: values never leave the processes under test.
    writeFileSync(
      script,
      `#!/bin/bash\n${blindLaunchScript(
        `{ echo "worker:$(/usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/sort | /usr/bin/tr '\\n' ' ')"; [ "$LITELLM_API_KEY" = ${shellQuote(MODEL_KEY)} ] && echo worker-key-ok; [ "\${EMPTY_ADMITTED+set}" = set ] && echo empty-kept; } >> ${shellQuote(report)}`,
        [
          `echo "holder:$(/usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/sort | /usr/bin/tr '\\n' ' ')" >> ${shellQuote(report)}`,
        ],
      )}\n`,
    );
    const result = spawnSync(
      '/bin/sh',
      [
        '-c',
        blindLaunchShellCommand(shellQuote(script), ['LITELLM_API_KEY', 'EMPTY_ADMITTED', 'HOME']),
      ],
      {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: root,
          TMUX_PANE: '%3',
          LITELLM_API_KEY: MODEL_KEY,
          EMPTY_ADMITTED: '',
          JIRA_API_TOKEN: 'FAKE_SECRET-login',
          BASH_ENV: path.join(root, 'missing-rc'),
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const lines = readFileSync(report, 'utf8').trim().split('\n');
    const names = (prefix: string) =>
      lines
        .find((line) => line.startsWith(prefix))!
        .slice(prefix.length)
        .trim()
        .split(' ');
    const worker = names('worker:');
    assert.ok(worker.includes('LITELLM_API_KEY'));
    assert.ok(!worker.includes('JIRA_API_TOKEN'));
    assert.ok(lines.includes('worker-key-ok'));
    assert.ok(lines.includes('empty-kept'));
    // bash itself adds PWD, SHLVL and _, and defaults SHELL and TERM when unset.
    const holder = names('holder:').filter(
      (name) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(name),
    );
    assert.deepEqual(
      holder.filter((name) => !['SHELL', 'TERM'].includes(name)),
      ['HOME', 'PATH', 'TMUX_PANE'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
