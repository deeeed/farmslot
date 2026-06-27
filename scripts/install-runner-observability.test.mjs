import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install-runner-observability.mjs');

function installToTempDir(runner = 'claude') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-'));
  execFileSync(process.execPath, [
    INSTALLER,
    '--runner',
    runner,
    '--repo',
    repo,
    '--runtime-dir',
    '.agent',
    '--slot-id',
    'install-test',
  ], { stdio: 'pipe' });
  const obsDir = path.join(repo, '.agent', '.observability');
  const hookPath = path.join(obsDir, 'bin', 'farmslot-observability-hook.mjs');
  return { repo, obsDir, hookPath };
}

function runHook(hookPath, obsDir, payload, runner = 'claude') {
  execFileSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      FARMSLOT_OBS_DIR: obsDir,
      FARMSLOT_SLOT_ID: 'install-test',
      FARMSLOT_RUNNER: runner,
    },
  });
}

test('installed hook appends real newlines so hooks.jsonl splits into records', () => {
  const { obsDir, hookPath } = installToTempDir();
  const logPath = path.join(obsDir, 'hooks.jsonl');
  const hookSrc = fs.readFileSync(hookPath, 'utf8');
  assert.doesNotMatch(
    hookSrc,
    /\+\s*['"]\\n['"]/,
    'hook must not append literal backslash-n characters',
  );

  runHook(hookPath, obsDir, { hook_event_name: 'SessionStart', session_id: 'a' });
  runHook(hookPath, obsDir, { hook_event_name: 'Stop', session_id: 'a' });

  const raw = fs.readFileSync(logPath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim());
  assert.equal(lines.length, 2, `expected 2 JSONL lines, got raw=${JSON.stringify(raw)}`);
  assert.equal(JSON.parse(lines[0]).hook_event_name, 'SessionStart');
  assert.equal(JSON.parse(lines[1]).hook_event_name, 'Stop');
  assert.equal(raw.at(-1), '\n', 'each append should end with a real newline byte');
});

test('codex install merges farmslot hook alongside existing codex hooks', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-codex-'));
  fs.mkdirSync(path.join(repo, '.codex'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.codex', 'hooks.json'),
    `${JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: 'node /tmp/omx-codex-native-hook.mjs' }],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );

  execFileSync(process.execPath, [
    INSTALLER,
    '--runner',
    'codex',
    '--repo',
    repo,
    '--runtime-dir',
    '.agent',
    '--slot-id',
    'install-test-codex',
  ], { stdio: 'pipe' });

  const hooksDoc = JSON.parse(fs.readFileSync(path.join(repo, '.codex', 'hooks.json'), 'utf8'));
  const stopEntries = hooksDoc.hooks.Stop;
  assert.ok(Array.isArray(stopEntries));
  assert.equal(stopEntries.length, 2);
  const commands = stopEntries.flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.ok(commands.some((cmd) => cmd.includes('omx-codex-native-hook.mjs')));
  assert.ok(commands.some((cmd) => cmd.includes('farmslot-observability-hook.mjs')));

  const config = fs.readFileSync(path.join(repo, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /hooks\s*=\s*true/);

  const obsDir = path.join(repo, '.agent', '.observability');
  const hookPath = path.join(obsDir, 'bin', 'farmslot-observability-hook.mjs');
  runHook(hookPath, obsDir, { hook_event_name: 'UserPromptSubmit', session_id: 'c1' }, 'codex');
  const row = JSON.parse(fs.readFileSync(path.join(obsDir, 'hooks.jsonl'), 'utf8').trim());
  assert.equal(row.runner, 'codex');
});