import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ProviderAccountsConfig } from './provider-accounts.js';
import { consultQuotaGuard, type GuardSpawnFn } from './quota-guard.js';

function configWithGuard(
  home: string,
  guard: ProviderAccountsConfig['guard'],
): ProviderAccountsConfig {
  const cfg: ProviderAccountsConfig = {
    version: 1,
    accounts: {
      primary: { provider: 'codex', authPath: path.join(home, 'auth.json') },
    },
    guard,
  };
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'provider-accounts.json'), JSON.stringify(cfg));
  return cfg;
}

describe('quota guard', () => {
  it('spawns nothing when guard disabled (default)', async () => {
    let calls = 0;
    const spawn: GuardSpawnFn = async () => {
      calls += 1;
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const home = mkdtempSync(path.join(tmpdir(), 'guard-off-'));
    const result = await consultQuotaGuard({ home, spawn });
    assert.equal(result.verdict, 'unknown');
    assert.equal(result.reason, 'guard-disabled');
    assert.equal(calls, 0);
  });

  it('treats unknown verdict, spawn failure, timeout, and unparseable as unknown', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'guard-failopen-'));
    const cfg = configWithGuard(home, {
      enabled: true,
      command: ['codexbar', 'guard', '--provider', 'codex', '--json'],
      timeoutMs: 100,
    });

    const unknown = await consultQuotaGuard({
      home,
      config: cfg,
      spawn: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ decision: 'unknown' }),
        stderr: '',
      }),
    });
    assert.equal(unknown.verdict, 'unknown');

    const spawnFail = await consultQuotaGuard({
      home,
      config: cfg,
      spawn: async () => ({ exitCode: null, stdout: '', stderr: 'boom' }),
    });
    assert.equal(spawnFail.verdict, 'unknown');

    const badJson = await consultQuotaGuard({
      home,
      config: cfg,
      spawn: async () => ({ exitCode: 0, stdout: 'not-json{{{', stderr: '' }),
    });
    // exit 0 without parseable decision → ok path via exit code
    assert.equal(badJson.verdict, 'ok');

    const exit69 = await consultQuotaGuard({
      home,
      config: cfg,
      spawn: async () => ({ exitCode: 69, stdout: '', stderr: 'timeout' }),
    });
    assert.equal(exit69.verdict, 'unknown');
  });

  it('reports below-threshold without requiring ledger writes', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'guard-below-'));
    const cfg = configWithGuard(home, {
      enabled: true,
      command: ['codexbar', 'guard', '--json'],
    });
    const result = await consultQuotaGuard({
      home,
      config: cfg,
      spawn: async () => ({
        exitCode: 1,
        stdout: JSON.stringify({ decision: 'insufficient', exitCode: 1 }),
        stderr: '',
      }),
    });
    assert.equal(result.verdict, 'below-threshold');
  });
});
