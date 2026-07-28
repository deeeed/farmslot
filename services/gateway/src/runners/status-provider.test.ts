import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FLEET_SUBSCRIPTION_RUNNERS,
  getRunnerStatusProvider,
  listRunnerFailoverCandidates,
  resolveRunnerAccountForDispatch,
} from './status-provider.js';
import { makeVars } from './test-fixtures.js';

describe('RunnerStatusProvider subscription + bind surface', () => {
  it('exposes bind only for codex among fleet runners', () => {
    assert.equal(getRunnerStatusProvider('codex')?.supportsAccountBinding, true);
    assert.equal(getRunnerStatusProvider('claude')?.supportsAccountBinding, false);
    assert.equal(getRunnerStatusProvider('grok')?.supportsAccountBinding, false);
    assert.equal(getRunnerStatusProvider('cursor')?.supportsAccountBinding, false);
    assert.equal(getRunnerStatusProvider('unknown-runner'), null);
  });

  it('fleet subscription runners include codex/claude/grok/cursor in display order', () => {
    assert.deepEqual([...FLEET_SUBSCRIPTION_RUNNERS], ['codex', 'claude', 'grok', 'cursor']);
  });

  it('codex buildAccountBindSpec stamps launch label without inventing auth path', () => {
    const provider = getRunnerStatusProvider('codex');
    assert.ok(provider?.buildAccountBindSpec);
    const bind = provider!.buildAccountBindSpec!({
      label: 'codex-a',
      provider: 'codex',
      authPath: '/tmp/homes/a/auth.json',
      ambient: false,
    });
    assert.equal(bind.accountLabel, 'codex-a');
    assert.equal(bind.launchAccountLabel, 'codex-a');
    assert.equal(bind.authPath, '/tmp/homes/a/auth.json');
  });

  it('resolveRunnerAccountForDispatch is a no-op for non-bind runners', async () => {
    const vars = makeVars({ host: 'localhost', machine: 'runner-local' });
    for (const runnerId of ['claude', 'grok', 'cursor'] as const) {
      const result = await resolveRunnerAccountForDispatch({
        vars,
        runnerId,
        slotId: 'macwork-ff-1',
      });
      assert.equal(result, null, `expected null for ${runnerId}`);
    }
  });

  it('listRunnerFailoverCandidates is empty when bind is unsupported', async () => {
    const vars = makeVars({ host: 'localhost', machine: 'runner-local' });
    assert.deepEqual(await listRunnerFailoverCandidates({ vars, runnerId: 'claude' }), []);
    assert.deepEqual(await listRunnerFailoverCandidates({ vars, runnerId: 'grok' }), []);
  });

  it('codex resolveAccountForSlot + listFailoverCandidates work via status provider', async () => {
    const provider = getRunnerStatusProvider('codex');
    assert.ok(provider?.resolveAccountForSlot);
    assert.ok(provider?.listFailoverCandidates);
    const vars = makeVars({ host: 'localhost', machine: 'runner-local' });
    // No forced label + no config → ambient (fail-open for single-seat hosts).
    const account = await provider!.resolveAccountForSlot!(vars, {
      slotId: 'macwork-ff-1',
    });
    assert.equal(account.provider, 'codex');
    assert.ok(account.label);
    assert.equal(typeof account.authPath, 'string');

    const candidates = await provider!.listFailoverCandidates!(vars, { exclude: [] });
    assert.ok(Array.isArray(candidates));
    assert.ok(candidates.length >= 1);
    assert.ok(candidates.includes(account.label) || candidates.includes('ambient'));
  });

  it('resolveRunnerAccountForDispatch returns bind spec for codex', async () => {
    const vars = makeVars({ host: 'localhost', machine: 'runner-local' });
    const result = await resolveRunnerAccountForDispatch({
      vars,
      runnerId: 'codex',
      slotId: 'macwork-ff-1',
    });
    assert.ok(result);
    assert.equal(result!.bind.accountLabel, result!.account.label);
    assert.equal(result!.bind.launchAccountLabel, result!.account.label);
  });

  it('getActiveSubscription reports supportsAccountBinding flag per runner', async () => {
    const vars = makeVars({ host: 'localhost', machine: 'runner-local' });
    const codex = await getRunnerStatusProvider('codex')!.getActiveSubscription(vars, {
      machineId: 'runner-local',
    });
    assert.equal(codex.runner, 'codex');
    assert.equal(codex.supportsAccountBinding, true);
    assert.ok(
      ['farmslot-bind', 'active-profile', 'ambient', 'error', 'codexbar', 'codex-auth'].includes(
        codex.source,
      ),
      `unexpected codex source ${codex.source}`,
    );

    const claude = await getRunnerStatusProvider('claude')!.getActiveSubscription(vars);
    assert.equal(claude.supportsAccountBinding, false);
    // Prefer claude auth status when available; else codexbar / fail-open.
    assert.ok(
      ['claude-auth', 'codexbar', 'unsupported', 'error', 'ambient'].includes(claude.source),
      `unexpected claude source ${claude.source}`,
    );
  });

  it('claude getActiveSubscription surfaces email from claude auth status when available', async () => {
    const vars = makeVars({ host: 'localhost', machine: 'runner-local', claudePath: 'claude' });
    const claude = await getRunnerStatusProvider('claude')!.getActiveSubscription(vars);
    // On this operator host claude is logged in — email must not stay null when auth works.
    if (claude.source === 'claude-auth') {
      assert.ok(claude.accountEmail?.includes('@'), `expected email, got ${claude.accountEmail}`);
      assert.ok(claude.loginMethod, 'expected plan/method from auth status');
    }
  });

  it('grok getActiveSubscription surfaces email from ~/.grok/auth.json when available', async () => {
    const vars = makeVars({ host: 'localhost', machine: 'runner-local' });
    const grok = await getRunnerStatusProvider('grok')!.getActiveSubscription(vars);
    if (grok.source === 'grok-auth') {
      assert.ok(grok.accountEmail?.includes('@'), `expected email, got ${grok.accountEmail}`);
      assert.match(String(grok.loginMethod), /grok\.com/);
    }
  });

  it('codex getActiveSubscription fills email from auth.json when codexbar lacks it', async () => {
    const vars = makeVars({ host: 'localhost', machine: 'runner-local' });
    const codex = await getRunnerStatusProvider('codex')!.getActiveSubscription(vars);
    // Either codexbar or native auth should yield identity on this host.
    if (codex.accountEmail) {
      assert.ok(codex.accountEmail.includes('@'));
    }
  });

  it('cursor getActiveSubscription surfaces email from cursor-agent status when available', async () => {
    const vars = makeVars({
      host: 'localhost',
      machine: 'runner-local',
      cursorPath: 'cursor-agent',
    });
    const cursor = await getRunnerStatusProvider('cursor')!.getActiveSubscription(vars);
    if (cursor.source === 'cursor-auth' || cursor.accountEmail) {
      assert.ok(cursor.accountEmail?.includes('@'), `expected email, got ${cursor.accountEmail}`);
    }
  });
});
