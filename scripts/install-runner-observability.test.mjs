import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install-runner-observability.mjs');

function installToTempDir(runner = 'claude') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-'));
  execFileSync(
    process.execPath,
    [
      INSTALLER,
      '--runner',
      runner,
      '--repo',
      repo,
      '--runtime-dir',
      '.agent',
      '--slot-id',
      'install-test',
    ],
    { stdio: 'pipe' },
  );
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

test('claude install registers observability hook events validated against Claude Code surface', () => {
  const { repo } = installToTempDir('claude');
  const settings = JSON.parse(
    fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'),
  );
  const registered = Object.keys(settings.hooks).sort();
  assert.deepEqual(registered, [
    'Notification',
    'PostCompact',
    'PostToolUse',
    'PreCompact',
    'PreToolUse',
    'SessionStart',
    'Stop',
    'StopFailure',
    'SubagentStop',
    'UserPromptSubmit',
  ]);
});

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

  execFileSync(
    process.execPath,
    [
      INSTALLER,
      '--runner',
      'codex',
      '--repo',
      repo,
      '--runtime-dir',
      '.agent',
      '--slot-id',
      'install-test-codex',
    ],
    { stdio: 'pipe' },
  );

  const hooksDoc = JSON.parse(fs.readFileSync(path.join(repo, '.codex', 'hooks.json'), 'utf8'));
  const stopEntries = hooksDoc.hooks.Stop;
  assert.ok(Array.isArray(stopEntries));
  assert.equal(stopEntries.length, 2);
  const commands = stopEntries.flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.ok(commands.some((cmd) => cmd.includes('omx-codex-native-hook.mjs')));
  assert.ok(commands.some((cmd) => cmd.includes('farmslot-observability-hook.mjs')));

  const codexEvents = Object.keys(hooksDoc.hooks).sort();
  assert.deepEqual(codexEvents, [
    'PostCompact',
    'PostToolUse',
    'PreCompact',
    'PreToolUse',
    'SessionStart',
    'Stop',
    'UserPromptSubmit',
  ]);
  assert.ok(!codexEvents.includes('Notification'));
  assert.ok(!codexEvents.includes('StopFailure'));
  assert.ok(!codexEvents.includes('SubagentStop'));

  const config = fs.readFileSync(path.join(repo, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /hooks\s*=\s*true/);

  const codexHome = path.join(repo, '.agent', 'codex-home');
  assert.ok(fs.existsSync(codexHome));
  const codexHomeConfig = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  assert.match(codexHomeConfig, /hooks\s*=\s*true/);
  assert.match(codexHomeConfig, /trusted_hash = "sha256:[a-f0-9]{64}"/);
  assert.ok(fs.existsSync(path.join(codexHome, 'hooks.json')));

  const obsDir = path.join(repo, '.agent', '.observability');
  const hookPath = path.join(obsDir, 'bin', 'farmslot-observability-hook.mjs');
  runHook(hookPath, obsDir, { hook_event_name: 'UserPromptSubmit', session_id: 'c1' }, 'codex');
  const row = JSON.parse(fs.readFileSync(path.join(obsDir, 'hooks.jsonl'), 'utf8').trim());
  assert.equal(row.runner, 'codex');
});

function initGitRepo(prefix) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'pipe' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@farmslot.local'], {
    stdio: 'pipe',
  });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'farmslot-test'], { stdio: 'pipe' });
  return repo;
}

function installCodexTo(repo) {
  execFileSync(
    process.execPath,
    [
      INSTALLER,
      '--runner',
      'codex',
      '--repo',
      repo,
      '--runtime-dir',
      '.agent',
      '--slot-id',
      'exclude-test',
    ],
    { stdio: 'pipe' },
  );
}

function porcelain(repo) {
  return execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });
}

function excludeLines(repo) {
  const excludePath = path.join(repo, '.git', 'info', 'exclude');
  const raw = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  return raw.split('\n').map((line) => line.trim());
}

test('codex install excludes its repo-root artifacts so git status stays clean', () => {
  const repo = initGitRepo('obs-install-codex-exclude-');
  installCodexTo(repo);

  assert.ok(fs.existsSync(path.join(repo, '.codex', 'config.toml')), '.codex must be materialized');
  assert.ok(
    fs.existsSync(path.join(repo, '.codex', 'hooks.json')),
    '.codex hooks must be materialized',
  );

  const lines = excludeLines(repo);
  for (const entry of ['.codex/', '.agent/', '.observability']) {
    assert.ok(
      lines.includes(entry),
      `info/exclude must contain '${entry}' (got ${JSON.stringify(lines)})`,
    );
  }

  const status = porcelain(repo);
  assert.doesNotMatch(
    status,
    /\.codex/,
    `git status must not surface .codex (got ${JSON.stringify(status)})`,
  );
  assert.doesNotMatch(
    status,
    /\.agent/,
    `git status must not surface .agent (got ${JSON.stringify(status)})`,
  );
  assert.doesNotMatch(
    status,
    /\.observability/,
    `git status must not surface .observability (got ${JSON.stringify(status)})`,
  );
  assert.equal(status.trim(), '', `working tree must be clean (got ${JSON.stringify(status)})`);
});

test('codex install exclude wiring is idempotent — no duplicate lines on rerun', () => {
  const repo = initGitRepo('obs-install-codex-exclude-idem-');
  installCodexTo(repo);
  const first = excludeLines(repo).filter(Boolean);
  installCodexTo(repo);
  const second = excludeLines(repo).filter(Boolean);
  assert.deepEqual(second, first, 'rerun must not append duplicate exclude lines');
  const codexCount = second.filter((line) => line === '.codex/').length;
  assert.equal(codexCount, 1, `.codex/ must appear exactly once (got ${codexCount})`);
});

test('codex install does not re-add entries already covered by .gitignore', () => {
  const repo = initGitRepo('obs-install-codex-exclude-gitignore-');
  // Project already ignores the runtime dir via a checked-in .gitignore.
  fs.writeFileSync(path.join(repo, '.gitignore'), '.agent/\n');
  installCodexTo(repo);
  const lines = excludeLines(repo);
  assert.ok(
    !lines.includes('.agent/'),
    'must not duplicate a .gitignore-covered entry into info/exclude',
  );
  assert.ok(lines.includes('.codex/'), '.codex/ (not gitignored) must still be excluded');
});

test('codex install never writes through a stale codex-home config.toml symlink to the global config', () => {
  // Regression: a codex-home/config.toml symlinked to the operator's global ~/.codex/config.toml
  // (left by an older launch path) made the installer read the global config, append its hook-trust
  // block, and write it BACK through the symlink — corrupting the global config (duplicate [features],
  // which broke codex everywhere). The installer must drop the symlink and write a real isolated file.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-symlink-'));
  const sentinel = path.join(repo, 'sentinel-global.toml');
  fs.writeFileSync(sentinel, '[features]\nhooks = true\n\n[notice]\nx = 1\n');
  const codexHome = path.join(repo, '.agent', 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const homeConfig = path.join(codexHome, 'config.toml');
  fs.symlinkSync(sentinel, homeConfig);
  const before = fs.readFileSync(sentinel, 'utf8');

  execFileSync(
    process.execPath,
    [
      INSTALLER,
      '--runner',
      'codex',
      '--repo',
      repo,
      '--runtime-dir',
      '.agent',
      '--slot-id',
      'install-test-symlink',
    ],
    { stdio: 'pipe' },
  );

  assert.equal(
    fs.readFileSync(sentinel, 'utf8'),
    before,
    'global config (symlink target) must be untouched — no write-through',
  );
  assert.ok(
    !fs.lstatSync(homeConfig).isSymbolicLink(),
    'stale symlink must be replaced by a real isolated file',
  );
  const homeContent = fs.readFileSync(homeConfig, 'utf8');
  assert.equal(
    (homeContent.match(/^\[features\]/gm) || []).length,
    1,
    'home config must have a single [features] section (no duplicate-key corruption)',
  );
});
