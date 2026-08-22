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

test('claude install does not traverse a symlinked repository settings directory', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-linked-dir-'));
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-external-'));
  const externalSettings = path.join(externalDir, 'settings.local.json');
  const original = JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [{ type: 'command', command: "node '/external/farmslot-observability-hook.mjs'" }],
        },
      ],
    },
  });
  fs.writeFileSync(externalSettings, original);
  fs.symlinkSync(externalDir, path.join(repo, '.claude'), 'dir');

  installToTempDir('claude', repo);

  assert.ok(fs.lstatSync(path.join(repo, '.claude')).isSymbolicLink());
  assert.equal(fs.readFileSync(externalSettings, 'utf8'), original);
});

test('claude install sanitizes a linked settings file without mutating its target', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-linked-file-'));
  const settingsDir = path.join(repo, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.local.json');
  const externalSettings = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-external-')),
    'settings.json',
  );
  const original = JSON.stringify({
    theme: 'dark',
    hooks: {
      Stop: [
        {
          hooks: [{ type: 'command', command: "node '/external/farmslot-observability-hook.mjs'" }],
        },
      ],
    },
  });
  fs.mkdirSync(settingsDir);
  fs.writeFileSync(externalSettings, original);
  fs.symlinkSync(externalSettings, settingsPath);

  installToTempDir('claude', repo);

  assert.equal(fs.readFileSync(externalSettings, 'utf8'), original);
  assert.equal(fs.lstatSync(settingsPath).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { theme: 'dark' });
});

test('claude install relocates a legacy backup after Farmslot settings were removed', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-legacy-backup-'));
  const settingsDir = path.join(repo, '.claude');
  const backupPath = path.join(settingsDir, 'settings.local.json.farmslot-backup');
  fs.mkdirSync(settingsDir);
  fs.writeFileSync(backupPath, '{"legacy":true}\n');

  const { obsDir } = installToTempDir('claude', repo);

  assert.equal(fs.existsSync(settingsDir), false);
  assert.equal(
    fs.readFileSync(path.join(obsDir, 'legacy-claude-settings.farmslot-backup'), 'utf8'),
    '{"legacy":true}\n',
  );
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

test('codex install keeps project hooks and config clean while isolating managed hooks', () => {
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
  fs.writeFileSync(path.join(repo, '.codex', 'config.toml'), '[features]\nhooks = true\n');
  const projectHooksBefore = fs.readFileSync(path.join(repo, '.codex', 'hooks.json'), 'utf8');

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

  const projectHooksPath = path.join(repo, '.codex', 'hooks.json');
  const projectHooksDoc = JSON.parse(fs.readFileSync(projectHooksPath, 'utf8'));
  assert.equal(projectHooksDoc.hooks.Stop.length, 1);
  assert.match(projectHooksDoc.hooks.Stop[0].hooks[0].command, /omx-codex-native-hook/u);
  assert.equal(fs.readFileSync(projectHooksPath, 'utf8'), projectHooksBefore);
  assert.equal(
    fs.readFileSync(path.join(repo, '.codex', 'config.toml'), 'utf8'),
    '[features]\nhooks = true\n',
  );

  const codexHome = path.join(repo, '.agent', 'codex-home');
  const hooksDoc = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
  const stopEntries = hooksDoc.hooks.Stop;
  assert.ok(Array.isArray(stopEntries));
  assert.equal(stopEntries.length, 1);
  const commands = stopEntries.flatMap((entry) => entry.hooks.map((hook) => hook.command));
  assert.ok(!commands.some((cmd) => cmd.includes('omx-codex-native-hook.mjs')));
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

test('codex install preserves live project-hook edits during legacy cleanup', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-codex-migrate-'));
  const codexDir = path.join(repo, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const originalHook = { type: 'command', command: 'node /tmp/original.mjs' };
  const addedHook = { type: 'command', command: 'node /tmp/operator-added.mjs' };
  fs.writeFileSync(
    path.join(codexDir, 'hooks.json.farmslot-backup'),
    `${JSON.stringify({ hooks: { Stop: [{ hooks: [originalHook] }] } })}\n`,
  );
  fs.writeFileSync(
    path.join(codexDir, 'hooks.json'),
    `${JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [addedHook] },
          { hooks: [{ type: 'command', command: 'node /tmp/farmslot-observability-hook.mjs' }] },
        ],
      },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(codexDir, 'config.toml.farmslot-backup'),
    '[features]\nfoo = true\nhooks = true\n',
  );
  fs.writeFileSync(
    path.join(codexDir, 'config.toml'),
    '[features]\nfoo = true\nhooks = false\n\n[operator]\nadded = true\n',
  );

  installToTempDir('codex', repo);

  const projectHooks = fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8');
  assert.doesNotMatch(projectHooks, /original\.mjs/u);
  assert.match(projectHooks, /operator-added\.mjs/u);
  assert.doesNotMatch(projectHooks, /farmslot-observability/u);
  const projectConfig = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
  assert.match(projectConfig, /foo = true/u);
  assert.match(projectConfig, /\[operator\]\nadded = true/u);
  assert.match(projectConfig, /hooks = false/u);

  fs.writeFileSync(
    path.join(codexDir, 'hooks.json'),
    `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ ...addedHook, command: 'node /tmp/latest.mjs' }] }] } })}\n`,
  );
  installToTempDir('codex', repo);
  const isolatedHooks = fs.readFileSync(
    path.join(repo, '.agent', 'codex-home', 'hooks.json'),
    'utf8',
  );
  assert.match(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8'), /latest\.mjs/u);
  assert.doesNotMatch(isolatedHooks, /latest\.mjs/u);
  assert.doesNotMatch(isolatedHooks, /original\.mjs/u);
  assert.doesNotMatch(isolatedHooks, /operator-added\.mjs/u);
  assert.match(isolatedHooks, /farmslot-observability/u);

  fs.unlinkSync(path.join(codexDir, 'hooks.json'));
  installToTempDir('codex', repo);
  const isolatedWithoutProjectHooks = fs.readFileSync(
    path.join(repo, '.agent', 'codex-home', 'hooks.json'),
    'utf8',
  );
  assert.doesNotMatch(isolatedWithoutProjectHooks, /latest\.mjs/u);
  assert.match(isolatedWithoutProjectHooks, /farmslot-observability/u);
});

test('codex legacy cleanup restores owned project files without losing operator edits', () => {
  const farmslotHook = {
    hooks: [{ type: 'command', command: 'node farmslot-observability-hook.mjs' }],
  };
  const cases = [
    {
      files: {
        'hooks.json.farmslot-backup': '{}\n',
        'hooks.json': `${JSON.stringify({ hooks: { Stop: [farmslotHook] } })}\n`,
      },
      expected: { 'hooks.json': '{}\n' },
    },
    {
      files: {
        'config.toml.farmslot-backup': '[features]\nhooks = false\n',
        'config.toml': '[features]\nhooks = true\n\n[operator]\nadded = true\n',
      },
      expected: { 'config.toml': '[features]\nhooks = false\n\n[operator]\nadded = true\n' },
    },
    {
      files: {
        'config.toml.farmslot-backup':
          '[operator]\nnotes = """\n[features]\n"""\n\n[features]\nhooks = false\n',
        'config.toml':
          '[operator]\nnotes = """\n[features]\n"""\nadded = true\n\n[features]\nhooks = true\n',
      },
      expected: {
        'config.toml':
          '[operator]\nnotes = """\n[features]\n"""\nadded = true\n\n[features]\nhooks = false\n',
      },
    },
    {
      files: {
        'hooks.json': `${JSON.stringify({ hooks: { Stop: [farmslotHook] } })}\n`,
        'config.toml': '[features]\nhooks = true\n\n[operator]\nadded = true\n',
      },
      expected: { 'config.toml': '[features]\nhooks = true\n\n[operator]\nadded = true\n' },
      missing: ['hooks.json'],
    },
    {
      files: {
        'config.toml': '[features]\nhooks = true\n',
      },
      expected: { 'config.toml': '[features]\nhooks = true\n' },
    },
  ];

  for (const { files, expected, missing = [] } of cases) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-codex-clean-migrate-'));
    const codexDir = path.join(repo, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(codexDir, name), content);
    }
    installToTempDir('codex', repo);
    for (const [name, content] of Object.entries(expected)) {
      assert.equal(fs.readFileSync(path.join(codexDir, name), 'utf8'), content);
    }
    for (const name of missing) assert.equal(fs.existsSync(path.join(codexDir, name)), false);
  }
});

test('codex legacy cleanup replaces a hook symlink without modifying its target', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-codex-symlink-migrate-'));
  const codexDir = path.join(repo, '.codex');
  const target = path.join(repo, 'shared-hooks.json');
  const content = `${JSON.stringify({
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'node operator-hook.mjs' }] },
        { hooks: [{ type: 'command', command: 'node farmslot-observability-hook.mjs' }] },
      ],
    },
  })}\n`;
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(target, content);
  fs.symlinkSync(target, path.join(codexDir, 'hooks.json'));

  installToTempDir('codex', repo);

  assert.equal(fs.readFileSync(target, 'utf8'), content);
  assert.equal(fs.lstatSync(path.join(codexDir, 'hooks.json')).isSymbolicLink(), false);
  assert.doesNotMatch(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8'), /farmslot/u);
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

function writeOperatorCodexConfig(home, body) {
  const globalConfig = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
  fs.writeFileSync(globalConfig, body);
  return globalConfig;
}

function installCodexHome(repo, home, slotId = 'install-test-codex-lb') {
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
      slotId,
    ],
    { stdio: 'pipe', env: { ...process.env, HOME: home } },
  );
  return fs.readFileSync(path.join(repo, '.agent', 'codex-home', 'config.toml'), 'utf8');
}

const CODEX_LB_TABLE = [
  '[model_providers.codex-lb]',
  'name = "openai"',
  'base_url = "http://127.0.0.1:2455/backend-api/codex"',
  'wire_api = "responses"',
  'env_key = "CODEX_LB_API_KEY"',
].join('\n');

test('codex-home config copies operator model_provider routing without writing through to global', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-codex-lb-routing-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-home-'));
  const globalConfig = writeOperatorCodexConfig(
    fakeHome,
    [
      'model = "gpt-5.6-sol"',
      'model_provider = "codex-lb"',
      '',
      CODEX_LB_TABLE,
      '',
      '[notice]',
      'hide_rate_limit_model_nudge = true',
      '',
    ].join('\n'),
  );

  const isolated = installCodexHome(repo, fakeHome);
  assert.match(isolated, /^model_provider = "codex-lb"$/m);
  assert.match(isolated, /^\[model_providers\.codex-lb\]$/m);
  assert.match(isolated, /base_url = "http:\/\/127\.0\.0\.1:2455\/backend-api\/codex"/);
  assert.doesNotMatch(isolated, /hide_rate_limit_model_nudge/);
  assert.equal(
    fs.readFileSync(globalConfig, 'utf8').includes('hide_rate_limit_model_nudge'),
    true,
    'global config must stay untouched',
  );
});

test('codex-home config copies a custom provider table that matches model_provider', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-custom-lb-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-home-custom-'));
  writeOperatorCodexConfig(
    fakeHome,
    [
      'model_provider = "home-lb"',
      '',
      '[model_providers.home-lb]',
      'base_url = "http://127.0.0.1:9/codex"',
      '',
    ].join('\n'),
  );
  const isolated = installCodexHome(repo, fakeHome, 'install-test-custom-lb');
  assert.match(isolated, /^model_provider = "home-lb"$/m);
  assert.match(isolated, /^\[model_providers\.home-lb\]$/m);
  assert.match(isolated, /base_url = "http:\/\/127\.0\.0\.1:9\/codex"/);
});

test('codex-home config does not copy a model_provider with no matching table', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-dangling-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-home-dangling-'));
  writeOperatorCodexConfig(fakeHome, 'model_provider = "missing-lb"\n');
  const isolated = installCodexHome(repo, fakeHome, 'install-test-dangling');
  assert.doesNotMatch(isolated, /model_provider = "missing-lb"/);
  assert.doesNotMatch(isolated, /\[model_providers\.missing-lb\]/);
});

test('codex-home config copies nested provider tables and commented headers', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-nested-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-home-nested-'));
  writeOperatorCodexConfig(
    fakeHome,
    [
      'model_provider = "home-lb"',
      '',
      '[model_providers.home-lb] # local router',
      'base_url = "http://127.0.0.1:9/codex"',
      '',
      '[model_providers.home-lb.env_http_headers]',
      'Authorization = "NESTED_PROVIDER_TOKEN"',
      '',
    ].join('\n'),
  );
  const isolatedPath = path.join(repo, '.agent', 'codex-home', 'config.toml');
  const isolated = installCodexHome(repo, fakeHome, 'install-test-nested');
  assert.match(isolated, /^model_provider = "home-lb"$/m);
  assert.match(isolated, /\[model_providers\.home-lb\]/);
  assert.match(isolated, /\[model_providers\.home-lb\.env_http_headers\]/);
  assert.match(isolated, /Authorization = "NESTED_PROVIDER_TOKEN"/);
  assert.equal(fs.statSync(isolatedPath).mode & 0o777, 0o600);
});

test('codex-home re-install keeps model_provider keys outside the root table', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-profile-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-home-profile-'));
  writeOperatorCodexConfig(
    fakeHome,
    ['model_provider = "codex-lb"', '', CODEX_LB_TABLE, ''].join('\n'),
  );
  const isolatedPath = path.join(repo, '.agent', 'codex-home', 'config.toml');
  installCodexHome(repo, fakeHome, 'install-test-profile');
  fs.appendFileSync(isolatedPath, '\n[profiles.keep]\nmodel_provider = "keep-me"\n');
  const isolated = installCodexHome(repo, fakeHome, 'install-test-profile');
  assert.match(isolated, /\[profiles\.keep\]/);
  assert.match(isolated, /model_provider = "keep-me"/);
});

test('codex-home config refreshes operator routing on re-install and drops it when gone', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-refresh-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-home-refresh-'));
  writeOperatorCodexConfig(
    fakeHome,
    ['model_provider = "codex-lb"', '', CODEX_LB_TABLE, ''].join('\n'),
  );
  installCodexHome(repo, fakeHome, 'install-test-refresh');
  writeOperatorCodexConfig(
    fakeHome,
    [
      'model_provider = "codex-lb"',
      '',
      '[model_providers.codex-lb]',
      'base_url = "http://127.0.0.1:2455/v2"',
      '',
    ].join('\n'),
  );
  let isolated = installCodexHome(repo, fakeHome, 'install-test-refresh');
  assert.match(isolated, /base_url = "http:\/\/127\.0\.0\.1:2455\/v2"/);
  assert.doesNotMatch(isolated, /2455\/backend-api\/codex/);
  writeOperatorCodexConfig(fakeHome, 'model = "gpt-5.6-sol"\n');
  isolated = installCodexHome(repo, fakeHome, 'install-test-refresh');
  assert.doesNotMatch(isolated, /model_provider = "codex-lb"/);
  assert.doesNotMatch(isolated, /\[model_providers\.codex-lb\]/);
});

test('codex install is idempotent for isolated codex-home config.toml', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-codex-idempotent-'));
  fs.mkdirSync(path.join(repo, '.agent', 'codex-home'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.agent', 'codex-home', 'config.toml'),
    '[features]\nhooks = false\ncustom_flag = true\n\n[tui.model_availability_nux]\n"gpt-5.5" = 1\n\n[features]\nhooks = true\n\n[features]\nhooks = true\n',
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

test('codex install preserves multiline arrays inside the features section', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-codex-array-'));
  fs.mkdirSync(path.join(repo, '.agent', 'codex-home'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.agent', 'codex-home', 'config.toml'),
    '[features]\nexperimental = [\n  "alpha",\n  "beta",\n]\nhooks = false\n\n[operator]\nname = "arthur"\n',
  );

  installToTempDir('codex', repo);

  const content = fs.readFileSync(path.join(repo, '.agent', 'codex-home', 'config.toml'), 'utf8');
  assert.match(content, /experimental = \[\n {2}"alpha",\n {2}"beta",\n\]/);
  assert.match(content, /hooks = true/);
  assert.match(content, /\[operator\]\nname = "arthur"/);
});

test('codex install does not treat nested multiline array values as TOML sections', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-codex-nested-array-'));
  fs.mkdirSync(path.join(repo, '.agent', 'codex-home'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.agent', 'codex-home', 'config.toml'),
    '[features]\nmodels = [\n  ["alpha"],\n  ["beta"]\n]\nhooks = false\n\n[operator]\nname = "arthur"\n',
  );

  installToTempDir('codex', repo);

  const content = fs.readFileSync(path.join(repo, '.agent', 'codex-home', 'config.toml'), 'utf8');
  assert.match(content, /models = \[\n {2}\["alpha"\],\n {2}\["beta"\]\n\]/);
  assert.match(content, /hooks = true/);
  assert.match(content, /\[operator\]\nname = "arthur"/);
});

test('codex install is idempotent when multiline strings contain section-like text', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-codex-string-'));
  fs.mkdirSync(path.join(repo, '.agent', 'codex-home'), { recursive: true });
  const configPath = path.join(repo, '.agent', 'codex-home', 'config.toml');
  fs.writeFileSync(
    configPath,
    '[operator]\nnotes = """\n[features]\n[not-a-section]\n"""\n\n[features]\n# first copy\nhooks = false\n\n[features]\n# second copy\ncustom_flag = true\n',
  );

  installToTempDir('codex', repo);
  installToTempDir('codex', repo);

  const content = fs.readFileSync(configPath, 'utf8');
  assert.equal((content.match(/^\[features\]/gm) || []).length, 2);
  assert.match(content, /notes = """\n\[features\]\n\[not-a-section\]\n"""/);
  assert.match(content, /# first copy/);
  assert.match(content, /# second copy/);
  assert.match(content, /hooks = true/);
  assert.match(content, /custom_flag = true/);
});

test('codex install handles multiline string closers with trailing quote content', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-install-codex-string-closer-'));
  fs.mkdirSync(path.join(repo, '.agent', 'codex-home'), { recursive: true });
  const configPath = path.join(repo, '.agent', 'codex-home', 'config.toml');
  fs.writeFileSync(
    configPath,
    "[operator]\nmodels = [\n  \"\"\"foo\"\"\"\",\n  '''bar'''''\n]\n\n[features]\nhooks = false\n",
  );

  installToTempDir('codex', repo);
  installToTempDir('codex', repo);

  const content = fs.readFileSync(configPath, 'utf8');
  assert.equal((content.match(/^\[features\]/gm) || []).length, 1);
  assert.equal((content.match(/^\[projects\./gm) || []).length, 1);
  assert.match(content, /hooks = true/);
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
