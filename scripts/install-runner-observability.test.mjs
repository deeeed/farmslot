import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install-runner-observability.mjs');

function installToTempDir(runner = 'claude', existingRepo) {
  const repo = existingRepo ?? fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-'));
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
  const claudeSettingsPath = path.join(obsDir, 'claude-settings.json');
  return { repo, obsDir, hookPath, claudeSettingsPath };
}

function runHook(hookPath, obsDir, payload, runner = 'claude') {
  execFileSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      FARMSLOT_OBS_DIR: obsDir,
      FARMSLOT_SLOT_ID: 'install-test',
      FARMSLOT_RUNNER: runner,
      TMUX_PANE: '%1',
    },
  });
}

test('claude install registers hooks in Farmslot runtime without modifying repository settings', () => {
  const { repo, claudeSettingsPath } = installToTempDir('claude');
  const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
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
  assert.equal(fs.existsSync(path.join(repo, '.claude')), false);
});

test('claude install removes legacy Farmslot-only repository settings', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-legacy-only-'));
  const settingsDir = path.join(repo, '.claude');
  fs.mkdirSync(settingsDir);
  fs.writeFileSync(
    path.join(settingsDir, 'settings.local.json'),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: "FARMSLOT_OBS_DIR='/old' node '/old/farmslot-observability-hook.mjs'",
              },
            ],
          },
        ],
      },
      statusLine: { type: 'command', command: "node '/old/farmslot-statusline.mjs'" },
    }),
  );

  installToTempDir('claude', repo);

  assert.equal(fs.existsSync(settingsDir), false);
});

test('claude install preserves non-Farmslot repository settings while removing legacy entries', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-legacy-mixed-'));
  const settingsDir = path.join(repo, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.local.json');
  fs.mkdirSync(settingsDir);
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      theme: 'dark',
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: 'command',
                command: "FARMSLOT_OBS_DIR='/old' node '/old/farmslot-observability-hook.mjs'",
              },
              { type: 'command', command: 'node user-hook.mjs' },
            ],
          },
        ],
      },
    }),
  );

  installToTempDir('claude', repo);

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks.length, 1);
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'node user-hook.mjs');
});

test('claude install replaces a stale compatibility symlink and remains idempotent', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-stale-link-'));
  const compat = path.join(repo, '.observability');
  fs.symlinkSync(path.join(repo, '.agent', '.observability'), compat, 'dir');

  for (let i = 0; i < 2; i += 1) {
    execFileSync(
      process.execPath,
      [
        INSTALLER,
        '--runner',
        'claude',
        '--repo',
        repo,
        '--runtime-dir',
        'temp/recipe/runtime',
        '--slot-id',
        'install-test-stale-link',
      ],
      { stdio: 'pipe' },
    );
  }

  const expected = path.join(repo, 'temp', 'recipe', 'runtime', '.observability');
  assert.equal(path.resolve(repo, fs.readlinkSync(compat)), expected);
  assert.ok(fs.existsSync(path.join(expected, 'bin', 'farmslot-observability-hook.mjs')));
  const settings = fs.readFileSync(path.join(expected, 'claude-settings.json'), 'utf8');
  assert.match(settings, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  assert.doesNotMatch(settings, /\.agent\/\.observability/u);
});

test('claude install preserves a non-symlink compatibility directory', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-real-dir-'));
  const compat = path.join(repo, '.observability');
  fs.mkdirSync(compat);
  fs.writeFileSync(path.join(compat, 'operator-file'), 'keep\n');

  execFileSync(
    process.execPath,
    [
      INSTALLER,
      '--runner',
      'claude',
      '--repo',
      repo,
      '--runtime-dir',
      'temp/recipe/runtime',
      '--slot-id',
      'install-test-real-dir',
    ],
    { stdio: 'pipe' },
  );

  assert.ok(!fs.lstatSync(compat).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(compat, 'operator-file'), 'utf8'), 'keep\n');
});

test('installed hook writes JSONL records and atomic per-session and per-pane snapshots', () => {
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
  runHook(hookPath, obsDir, {
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt',
    message: 'Claude is waiting for your input',
    session_id: 'a',
  });

  const raw = fs.readFileSync(logPath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim());
  assert.equal(lines.length, 3, `expected 3 JSONL lines, got raw=${JSON.stringify(raw)}`);
  assert.equal(JSON.parse(lines[0]).hook_event_name, 'SessionStart');
  assert.equal(JSON.parse(lines[1]).hook_event_name, 'Stop');
  assert.equal(JSON.parse(lines[2]).notification_type, 'idle_prompt');
  assert.equal(raw.at(-1), '\n', 'each append should end with a real newline byte');
  const sessionState = JSON.parse(
    fs.readFileSync(path.join(obsDir, 'sessions', `${encodeURIComponent('a')}.json`), 'utf8'),
  );
  assert.equal(sessionState.hook_event_name, 'Notification');
  assert.equal(sessionState.notification_type, 'idle_prompt');
  assert.equal(sessionState.session_id, 'a');
  const paneState = JSON.parse(
    fs.readFileSync(path.join(obsDir, 'panes', `${encodeURIComponent('%1')}.json`), 'utf8'),
  );
  assert.equal(paneState.hook_event_name, 'Notification');
  assert.equal(paneState.session_id, 'a');
  assert.equal(paneState.tmuxPane, '%1');
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

test('codex install is idempotent for isolated codex-home config.toml', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-codex-idempotent-'));
  fs.mkdirSync(path.join(repo, '.agent', 'codex-home'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.agent', 'codex-home', 'config.toml'),
    '[features]\nhooks = false\ncustom_flag = true\n\n[tui.model_availability_nux]\n"gpt-5.5" = 1\n',
  );

  for (let i = 0; i < 2; i += 1) {
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
        'install-test-codex-idempotent',
      ],
      { stdio: 'pipe' },
    );
  }

  const homeContent = fs.readFileSync(
    path.join(repo, '.agent', 'codex-home', 'config.toml'),
    'utf8',
  );
  assert.equal((homeContent.match(/^\[features\]/gm) || []).length, 1);
  assert.match(homeContent, /hooks = true/);
  assert.match(homeContent, /custom_flag = true/);
  assert.equal((homeContent.match(/^\[projects\./gm) || []).length, 1);
  assert.match(homeContent, /\[tui\.model_availability_nux\]/);
});

test('codex install rebinds auth.json symlink from account A to B without touching source files', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-auth-rebind-'));
  const accountA = path.join(repo, 'accounts', 'a', 'auth.json');
  const accountB = path.join(repo, 'accounts', 'b', 'auth.json');
  fs.mkdirSync(path.dirname(accountA), { recursive: true });
  fs.mkdirSync(path.dirname(accountB), { recursive: true });
  const contentA = '{"account":"A","token":"aaa"}';
  const contentB = '{"account":"B","token":"bbb"}';
  fs.writeFileSync(accountA, contentA);
  fs.writeFileSync(accountB, contentB);

  const runInstall = (authSource) => {
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
        'install-test-rebind',
        '--auth-source',
        authSource,
      ],
      { stdio: 'pipe' },
    );
  };

  runInstall(accountA);
  const destAuth = path.join(repo, '.agent', 'codex-home', 'auth.json');
  assert.ok(fs.lstatSync(destAuth).isSymbolicLink());
  assert.equal(path.resolve(fs.readlinkSync(destAuth)), path.resolve(accountA));

  runInstall(accountB);
  assert.ok(fs.lstatSync(destAuth).isSymbolicLink());
  assert.equal(path.resolve(fs.readlinkSync(destAuth)), path.resolve(accountB));
  assert.equal(fs.readFileSync(accountA, 'utf8'), contentA);
  assert.equal(fs.readFileSync(accountB, 'utf8'), contentB);
});

test('codex install relinks a dangling auth.json symlink', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-dangling-'));
  const realAuth = path.join(repo, 'accounts', 'real', 'auth.json');
  fs.mkdirSync(path.dirname(realAuth), { recursive: true });
  fs.writeFileSync(realAuth, '{"ok":true}');
  const codexHome = path.join(repo, '.agent', 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const destAuth = path.join(codexHome, 'auth.json');
  fs.symlinkSync(path.join(repo, 'accounts', 'missing', 'auth.json'), destAuth);

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
      'install-test-dangling',
      '--auth-source',
      realAuth,
    ],
    { stdio: 'pipe' },
  );

  assert.ok(fs.lstatSync(destAuth).isSymbolicLink());
  assert.equal(path.resolve(fs.readlinkSync(destAuth)), path.resolve(realAuth));
});

test('codex install refuses to unlink a regular auth.json file', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-regular-auth-'));
  const realAuth = path.join(repo, 'accounts', 'real', 'auth.json');
  fs.mkdirSync(path.dirname(realAuth), { recursive: true });
  fs.writeFileSync(realAuth, '{"ok":true}');
  const codexHome = path.join(repo, '.agent', 'codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const destAuth = path.join(codexHome, 'auth.json');
  const regular = '{"placed-by-operator":true}';
  fs.writeFileSync(destAuth, regular);

  assert.throws(
    () =>
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
          'install-test-regular',
          '--auth-source',
          realAuth,
        ],
        { stdio: 'pipe' },
      ),
    /real file, not a symlink/,
  );
  assert.equal(fs.readFileSync(destAuth, 'utf8'), regular);
  assert.ok(!fs.lstatSync(destAuth).isSymbolicLink());
});

test('codex install resolves --account-label from FARMSLOT_HOME on this host', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-label-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'farmslot-home-label-'));
  const authA = path.join(home, 'accounts', 'a', 'auth.json');
  const authB = path.join(home, 'accounts', 'b', 'auth.json');
  fs.mkdirSync(path.dirname(authA), { recursive: true });
  fs.mkdirSync(path.dirname(authB), { recursive: true });
  fs.writeFileSync(authA, '{"a":1}');
  fs.writeFileSync(authB, '{"b":1}');
  fs.writeFileSync(
    path.join(home, 'provider-accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: {
        'codex-a': { provider: 'codex', authPath: authA },
        'codex-b': { provider: 'codex', authPath: authB },
      },
    }),
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
      'slot-label',
      '--account-label',
      'codex-b',
    ],
    {
      stdio: 'pipe',
      env: { ...process.env, FARMSLOT_HOME: home },
    },
  );

  const destAuth = path.join(repo, '.agent', 'codex-home', 'auth.json');
  assert.ok(fs.lstatSync(destAuth).isSymbolicLink());
  assert.equal(path.resolve(fs.readlinkSync(destAuth)), path.resolve(authB));
});

test('codex install uses node active profile when no label/binding', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-active-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'farmslot-home-active-'));
  const authB = path.join(home, 'accounts', 'b', 'auth.json');
  fs.mkdirSync(path.dirname(authB), { recursive: true });
  fs.writeFileSync(authB, '{"b":1}');
  fs.writeFileSync(
    path.join(home, 'provider-accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: {
        'codex-b': { provider: 'codex', authPath: authB },
      },
    }),
  );
  fs.writeFileSync(
    path.join(home, 'active-provider-accounts.json'),
    JSON.stringify({ version: 1, profiles: { codex: 'codex-b' } }),
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
      'slot-active',
    ],
    {
      stdio: 'pipe',
      env: { ...process.env, FARMSLOT_HOME: home },
    },
  );

  const destAuth = path.join(repo, '.agent', 'codex-home', 'auth.json');
  assert.equal(path.resolve(fs.readlinkSync(destAuth)), path.resolve(authB));
});

test('codex install fails closed when bound account auth path is missing', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-missing-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'farmslot-home-missing-'));
  const missingAuth = path.join(home, 'accounts', 'gone', 'auth.json');
  fs.writeFileSync(
    path.join(home, 'provider-accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: {
        'codex-gone': { provider: 'codex', authPath: missingAuth },
      },
    }),
  );

  assert.throws(
    () =>
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
          'slot-missing',
          '--account-label',
          'codex-gone',
        ],
        {
          stdio: 'pipe',
          env: { ...process.env, FARMSLOT_HOME: home },
        },
      ),
    /auth missing|refusing silent bind/,
  );
});
