import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { selectEligibleProviderAccount } from './provider-account-select.js';
import {
  ambientCodexAuthPath,
  providerFailoverCandidates,
  resolveProviderAccountForSlot,
} from './provider-accounts.js';
import { markAccountExhausted } from './usage-exhaustion-ledger.js';

const cli = fileURLToPath(new URL('../../../../scripts/provider-account-cli.mjs', import.meta.url));

function fixture(t: TestContext) {
  const home = mkdtempSync(path.join(tmpdir(), 'provider-ambient-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configure = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      path.join(home, 'provider-accounts.json'),
      JSON.stringify({
        version: 1,
        accounts: {},
        nativeProfiles: { 'native-fixture': { runner: 'codex' } },
        ...extra,
      }),
    );
  const host = (action: string, args: string[] = []) => {
    const result = spawnSync(
      process.execPath,
      [cli, action, '--home', home, '--slot-id', 'slot', '--provider', 'codex', ...args],
      { encoding: 'utf8' },
    );
    assert.equal(result.error, undefined);
    assert.ok(result.stdout.trim(), result.stderr);
    return { status: result.status, value: JSON.parse(result.stdout.trim()) };
  };
  return { home, configure, host };
}

test('profiles-only config preserves ambient resolve, selection and eligible inventory on both hosts', async (t) => {
  const { home, configure, host } = fixture(t);
  configure();
  for (const forcedLabel of [undefined, 'ambient']) {
    const local = resolveProviderAccountForSlot({ slotId: 'slot', home, forcedLabel });
    const remote = host('resolve', forcedLabel ? ['--label', forcedLabel] : []);
    assert.equal(remote.status, 0);
    for (const result of [local, remote.value]) {
      assert.equal(result.label, 'ambient');
      assert.equal(result.ambient, true);
      assert.equal(result.authPath, ambientCodexAuthPath());
    }
    const selected = await selectEligibleProviderAccount({
      slotId: 'slot',
      home,
      preferredLabel: forcedLabel,
    });
    assert.equal(selected.label, 'ambient');
    assert.equal(
      host('select', forcedLabel ? ['--preferred', forcedLabel] : []).value.label,
      'ambient',
    );
  }
  assert.deepEqual(providerFailoverCandidates({ home }), ['ambient']);
  assert.deepEqual(host('list-eligible').value.eligible, ['ambient']);
});

test('profiles-only config still refuses unknown forced, slot-bound and active labels', async (t) => {
  const { home, configure, host } = fixture(t);
  for (const source of ['forced', 'slot', 'active']) {
    configure(
      source === 'slot'
        ? { slotBindings: { slot: 'missing' } }
        : source === 'active'
          ? { activeProfiles: { codex: 'missing' } }
          : {},
    );
    const forcedLabel = source === 'forced' ? 'missing' : undefined;
    assert.throws(
      () => resolveProviderAccountForSlot({ slotId: 'slot', home, forcedLabel }),
      /unknown label 'missing'/,
    );
    await assert.rejects(
      selectEligibleProviderAccount({ slotId: 'slot', home, preferredLabel: forcedLabel }),
      /unknown label 'missing'/,
    );
    for (const action of ['resolve', 'select']) {
      const args = forcedLabel
        ? [action === 'select' ? '--preferred' : '--label', forcedLabel]
        : [];
      const result = host(action, args);
      assert.notEqual(result.status, 0);
      assert.match(result.value.error, /unknown label 'missing'/);
    }
  }
});

test('an explicitly defined ambient account retains its path and provider checks', (t) => {
  const { home, configure, host } = fixture(t);
  const authPath = path.join(home, 'configured-auth.json');
  configure({ accounts: { ambient: { provider: 'codex', authPath } } });
  assert.equal(
    resolveProviderAccountForSlot({ slotId: 'slot', home, forcedLabel: 'ambient' }).authPath,
    authPath,
  );
  assert.equal(host('resolve', ['--label', 'ambient']).value.authPath, authPath);
  configure({ accounts: { ambient: { provider: 'another-provider', authPath } } });
  assert.throws(
    () => resolveProviderAccountForSlot({ slotId: 'slot', home, forcedLabel: 'ambient' }),
    /expected 'codex'/,
  );
  const result = host('resolve', ['--label', 'ambient']);
  assert.notEqual(result.status, 0);
  assert.match(result.value.error, /expected 'codex'/);
});

test('ambient candidates respect exclusion, explicit empty pools and existing named pools', (t) => {
  const { home, configure, host } = fixture(t);
  configure();
  assert.deepEqual(providerFailoverCandidates({ home, exclude: ['ambient'] }), []);
  assert.deepEqual(host('list-eligible', ['--exclude', 'ambient']).value.eligible, []);
  configure({ failoverPool: [] });
  assert.deepEqual(providerFailoverCandidates({ home }), []);
  assert.deepEqual(host('list-eligible').value.eligible, []);
  configure({
    accounts: { named: { provider: 'codex', authPath: path.join(home, 'named.json') } },
  });
  assert.deepEqual(providerFailoverCandidates({ home }), ['named']);
  assert.deepEqual(host('list-eligible').value.eligible, ['named']);
  configure({ failoverPool: ['ambient', 'missing'] });
  assert.deepEqual(providerFailoverCandidates({ home }), ['ambient']);
  assert.deepEqual(host('list-eligible').value.eligible, ['ambient']);
});

test('ambient exhaustion remains authoritative with profiles-only configuration', async (t) => {
  const { home, configure, host } = fixture(t);
  configure();
  markAccountExhausted({ label: 'ambient', home });
  await assert.rejects(
    selectEligibleProviderAccount({ slotId: 'slot', home }),
    /eligible|exhausted/i,
  );
  assert.deepEqual(host('list-eligible').value.eligible, []);
  const result = host('select');
  assert.notEqual(result.status, 0);
  assert.equal(result.value.error, 'no-eligible');
});
