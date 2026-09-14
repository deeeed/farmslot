import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  addNativeProfile,
  assertNativeProfileCurrent,
  listNativeProfiles,
  nativeProfileEnvironment,
  providerAccountsConfigPath,
  removeNativeProfile,
  requireNativeProfile,
} from './account-profiles.js';
import { decodeRequest } from './ipc.js';

test('the default Claude directory retains its native credential store while custom profiles stay explicit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'native-claude-default-'));
  try {
    const directory = join(home, 'native-config');
    mkdirSync(directory);
    symlinkSync(directory, join(home, '.claude'));
    const profile = await addNativeProfile(
      { profileId: 'default', runner: 'claude', directory: join(home, '.claude') },
      home,
    );
    const base = {
      HOME: home,
      CLAUDE_CONFIG_DIR: '/other/config',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/other/storage',
      CLAUDE_CODE_OAUTH_TOKEN: 'override',
    };
    const env = nativeProfileEnvironment(profile, base);
    assert.equal(env.HOME, home);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    const custom = await addNativeProfile({ profileId: 'custom', runner: 'claude' }, home);
    const customEnv = nativeProfileEnvironment(custom, base);
    assert.equal(customEnv.CLAUDE_CONFIG_DIR, custom.directory);
    assert.equal(customEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR, custom.directory);
    const otherHome = nativeProfileEnvironment(profile, {
      ...base,
      HOME: join(home, 'other-home'),
    });
    assert.equal(
      otherHome.CLAUDE_CONFIG_DIR,
      profile.directory,
      'A different HOME must not redirect the chosen directory',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('named profiles preserve existing account settings and bind distinct native directories', async () => {
  const home = mkdtempSync(join(tmpdir(), 'native-profiles-'));
  try {
    const existing = {
      version: 1,
      accounts: { old: { provider: 'codex', authPath: '/old/auth.json' } },
      slotBindings: { slot: 'old' },
    };
    writeFileSync(providerAccountsConfigPath(home), JSON.stringify(existing));
    const a = await addNativeProfile({ profileId: 'a', runner: 'claude' }, home);
    const b = await addNativeProfile({ profileId: 'b', runner: 'claude' }, home);
    assert.notEqual(a.directory, b.directory);
    assert.notEqual(a.accountContextId, b.accountContextId);
    assert.deepEqual(await addNativeProfile({ profileId: 'a', runner: 'claude' }, home), a);
    const persisted = JSON.parse(readFileSync(providerAccountsConfigPath(home), 'utf8'));
    assert.deepEqual(persisted.accounts, existing.accounts);
    assert.deepEqual(persisted.slotBindings, existing.slotBindings);
    const env = nativeProfileEnvironment(a, {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'sentinel',
      SERVICE_PORT: '1234',
    });
    assert.equal(env.CLAUDE_CONFIG_DIR, a.directory);
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, a.directory);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.SERVICE_PORT, '1234');
    const rejected = join(home, 'rejected');
    await assert.rejects(
      addNativeProfile({ profileId: 'a', runner: 'claude', directory: rejected }, home),
    );
    assert.equal(existsSync(rejected), false);
    await assert.rejects(
      addNativeProfile({ profileId: 'alias', runner: 'claude', directory: a.directory }, home),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('retirement blocks reuse until cleanup succeeds and a reused label gets a new account binding', async () => {
  const home = mkdtempSync(join(tmpdir(), 'native-profile-retirement-'));
  try {
    const a = await addNativeProfile({ profileId: 'a', runner: 'codex' }, home);
    await assert.rejects(
      removeNativeProfile(
        a.id,
        a.accountContextId,
        async () => {
          assert.throws(() => requireNativeProfile(a.id, 'codex', home), /unavailable/);
          throw new Error('cleanup-unconfirmed');
        },
        home,
      ),
      /cleanup-unconfirmed/,
    );
    assert.equal(listNativeProfiles(home)[0].state, 'retiring');
    await assert.rejects(addNativeProfile({ profileId: 'a', runner: 'codex' }, home));
    await removeNativeProfile(a.id, a.accountContextId, async () => {}, home);
    assert.equal(existsSync(a.directory), true, 'Native-owned credentials/data are not deleted');
    const b = await addNativeProfile({ profileId: 'a', runner: 'codex' }, home);
    assert.notEqual(b.accountContextId, a.accountContextId);
    assert.throws(() => assertNativeProfileCurrent(a, home), /changed/);
    await assert.rejects(
      removeNativeProfile(a.id, a.accountContextId, async () => {}, home),
      /changed/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('reserved native creation keeps profile selection through IPC', () => {
  const request = decodeRequest({
    method: 'ensure',
    owner: 'owner',
    params: {
      runner: 'codex',
      cwd: '/workspace',
      sessionId: 'fbb8f455-33ba-4e7f-9600-4eea85b9fda6',
      profileId: 'work',
    },
  });
  assert.equal(request.method, 'ensure');
  assert.equal('params' in request && request.params.profileId, 'work');
});

test('Codex profiles retain keys required by explicitly configured native providers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'native-codex-provider-'));
  try {
    const profile = await addNativeProfile({ profileId: 'codex', runner: 'codex' }, home);
    const env = nativeProfileEnvironment(profile, {
      OPENAI_API_KEY: 'implicit-override',
      CODEX_API_KEY: 'implicit-override',
      CODEX_LB_API_KEY: 'configured-provider-key',
    });
    assert.equal(env.CODEX_HOME, profile.directory);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
    assert.equal(env.CODEX_LB_API_KEY, 'configured-provider-key');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('additional runner profiles clear native auth overrides and select their native directories', async () => {
  const home = mkdtempSync(join(tmpdir(), 'native-additional-profiles-'));
  try {
    const cursor = await addNativeProfile({ profileId: 'cursor', runner: 'cursor' }, home);
    const defaultCursor = await addNativeProfile(
      { profileId: 'cursor-default', runner: 'cursor', directory: home },
      home,
    );
    const grok = await addNativeProfile({ profileId: 'grok', runner: 'grok' }, home);
    const base = {
      HOME: home,
      CURSOR_API_KEY: 'api-override',
      CURSOR_AUTH_TOKEN: 'login-override',
      CURSOR_CONFIG_DIR: '/other/config',
      CURSOR_DATA_DIR: '/other/data',
      XDG_CONFIG_HOME: '/other/xdg',
      XAI_API_KEY: 'xai-override',
      GROK_API_KEY: 'grok-override',
      GROK_HOME: '/other/grok',
      SERVICE_PORT: '1234',
    };
    const defaultCursorEnv = nativeProfileEnvironment(defaultCursor, base);
    assert.equal(defaultCursorEnv.HOME, home);
    assert.equal(
      defaultCursorEnv.AGENT_CLI_CREDENTIAL_STORE,
      undefined,
      'The native default backend must remain available',
    );
    assert.equal(defaultCursorEnv.CURSOR_AUTH_TOKEN, undefined);
    const cursorEnv = nativeProfileEnvironment(cursor, base);
    assert.equal(cursorEnv.HOME, cursor.directory);
    assert.equal(cursorEnv.AGENT_CLI_CREDENTIAL_STORE, 'file');
    for (const key of [
      'CURSOR_API_KEY',
      'CURSOR_AUTH_TOKEN',
      'CURSOR_CONFIG_DIR',
      'CURSOR_DATA_DIR',
      'XDG_CONFIG_HOME',
    ])
      assert.equal(
        cursorEnv[key],
        undefined,
        `${key} must not override the selected Cursor profile`,
      );
    const grokEnv = nativeProfileEnvironment(grok, base);
    assert.equal(grokEnv.GROK_HOME, grok.directory);
    assert.equal(grokEnv.XAI_API_KEY, undefined);
    assert.equal(grokEnv.GROK_API_KEY, undefined);
    assert.equal(cursorEnv.SERVICE_PORT, '1234');
    assert.equal(grokEnv.SERVICE_PORT, '1234');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
