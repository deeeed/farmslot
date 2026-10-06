'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  awaitSignatureLog,
  evaluateSignatureLog,
  parseLog,
  resetWindow,
  shortPrimaryType,
  summarize,
  windowSinceCursor,
  writeLogArtifact,
} = require('../src/dapp/signature-log.cjs');

const permit = {
  kind: 'request',
  method: 'eth_signTypedData_v4',
  primaryType: 'Token:Permit',
  domainChainId: 1,
  activeChainId: 1,
  outcome: 'signed',
};
const order = {
  kind: 'request',
  method: 'eth_signTypedData_v4',
  primaryType: 'Token:Order',
  domainChainId: 1,
  activeChainId: 42161,
  outcome: 'rejected',
  errorCode: -32602,
};
const session = {
  kind: 'request',
  method: 'eth_signTypedData_v4',
  primaryType: 'Session',
  domainChainId: 1337,
  activeChainId: 1,
  outcome: 'signed',
};
const connect = {
  kind: 'request',
  method: 'wallet_requestPermissions',
  activeChainId: 1,
  outcome: 'approved',
};
const shown = { kind: 'confirmation-shown', surface: 'sidepanel', route: '/connect/abc' };
const blocked = { kind: 'blocked-host', url: 'https://prod.example.test/api' };

// A product policy: session keys never reach the main wallet; production
// traffic must never be attempted.
const POLICY = {
  typedDataClasses: {
    sessionRequests: {
      match: (entry) => shortPrimaryType(entry.primaryType) === 'Session',
      param: 'max_session_requests',
      defaultMax: 0,
      failure: (count, max) => `session requests reached the main wallet: ${count} > ${max}`,
    },
  },
  forbiddenEntries: {
    blockedHosts: {
      match: (entry) => entry.kind === 'blocked-host',
      failure: (count) => `the browser tried to reach production ${count} time(s)`,
    },
  },
};

const withSeq = (entries) => entries.map((entry, seq) => ({ seq, ...entry }));

describe('wallet request log', () => {
  it('shortens namespaced primary types', () => {
    assert.equal(shortPrimaryType('Token:Permit'), 'Permit');
    assert.equal(shortPrimaryType('Session'), 'Session');
    assert.equal(shortPrimaryType(null), null);
  });

  it('parses JSON lines and keeps unparseable lines visible', () => {
    const entries = parseLog(`${JSON.stringify(connect)}\nnot json\n\n${JSON.stringify(permit)}\n`);
    assert.deepEqual(
      entries.map((entry) => [entry.seq, entry.kind]),
      [
        [0, 'request'],
        [1, 'unparseable'],
        [2, 'request'],
      ],
    );
  });

  it('passes a window with only allowed types and the expected counts', () => {
    const result = evaluateSignatureLog(withSeq([connect, shown, permit]), {
      allowed_primary_types: ['Permit', 'Order'],
      counts: { Permit: 1 },
      methods: { wallet_requestPermissions: 1 },
      expect_confirmations: 1,
      require_active_chain: true,
    });
    assert.deepEqual(result.failures, []);
    assert.equal(result.ok, true);
    assert.deepEqual(result.summary.byPrimaryType.Permit, {
      requested: 1,
      signed: 1,
      rejected: 0,
      chainIds: [1],
    });
  });

  it('fails on a disallowed primary type, a wrong count and a chain mismatch', () => {
    const result = evaluateSignatureLog(
      withSeq([permit, permit, { ...order, outcome: 'signed' }]),
      {
        allowed_primary_types: ['Permit'],
        counts: { 'Token:Permit': 1 },
        require_active_chain: true,
      },
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.failures, [
      'primary type Order (seq 2) is not allowed',
      'signed Permit: expected 1, got 2',
      'seq 2 Order signed with domain chainId 1 while the wallet was on 42161',
    ]);
  });

  it('counts rejections apart from signatures', () => {
    assert.deepEqual(summarize(withSeq([order])).byPrimaryType.Order, {
      requested: 1,
      signed: 0,
      rejected: 1,
      chainIds: [1],
    });
    assert.equal(evaluateSignatureLog(withSeq([order]), { max_rejected: 0 }).ok, false);
  });

  it('fails on unattributed entries and keeps calls from outside the app frame as evidence', () => {
    const result = evaluateSignatureLog(
      withSeq([{ kind: 'unattributed' }, { kind: 'outside-app-frame' }]),
      {},
    );
    assert.deepEqual(result.failures, [
      "1 wallet log entr(y/ies) could not be attributed to the app's top frame (unattributed)",
    ]);
    assert.equal(result.summary.outsideAppFrame, 1);
  });

  it('applies the policy: counters in the summary, forbidden entries first, class limits with a default', () => {
    const entries = withSeq([connect, blocked, permit, session, { ...blocked, probe: true }]);
    const summary = summarize(entries, POLICY);
    assert.deepEqual(Object.keys(summary), [
      'requests',
      'typedDataRequests',
      'sessionRequests',
      'confirmationsShown',
      'blockedHosts',
      'unattributed',
      'outsideAppFrame',
      'byPrimaryType',
      'byMethod',
    ]);
    assert.equal(summary.sessionRequests, 1);
    assert.equal(summary.blockedHosts, 2);
    const failing = evaluateSignatureLog(
      withSeq([{ kind: 'unattributed' }, ...entries]),
      {},
      POLICY,
    );
    assert.deepEqual(failing.failures, [
      'the browser tried to reach production 2 time(s)',
      "1 wallet log entr(y/ies) could not be attributed to the app's top frame (unattributed)",
      'session requests reached the main wallet: 1 > 0',
    ]);
    assert.throws(
      () =>
        summarize(entries, {
          forbiddenEntries: { unattributed: { match: () => true, failure: () => 'x' } },
        }),
      /"unattributed" is a summary key/,
    );
    assert.throws(
      () =>
        summarize(entries, {
          ...POLICY,
          forbiddenEntries: { sessionRequests: POLICY.forbiddenEntries.blockedHosts },
        }),
      /"sessionRequests" is a summary key or used twice/,
    );
    const allowed = evaluateSignatureLog(withSeq([session]), { max_session_requests: 1 }, POLICY);
    assert.equal(allowed.ok, true);
    assert.equal('sessionRequests' in summarize(entries), false);
  });
});

describe('wallet request log window', () => {
  async function logDir(entries) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dapp-siglog-'));
    const log = {
      logFile: path.join(dir, 'wallet-requests.jsonl'),
      cursorFile: path.join(dir, 'wallet-requests.cursor.json'),
    };
    await writeFile(log.logFile, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    return { dir, log };
  }

  it('reads an absent log and cursor as empty', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dapp-siglog-'));
    assert.deepEqual(
      await windowSinceCursor({
        logFile: path.join(dir, 'none'),
        cursorFile: path.join(dir, 'none'),
      }),
      { cursor: 0, entries: [], total: 0 },
    );
  });

  it('reset moves the window so earlier requests do not count', async () => {
    const { log } = await logDir([connect, permit]);
    assert.deepEqual(await resetWindow(log), { cursor: 2, previousEntries: 2 });
    await writeFile(
      log.logFile,
      `${[connect, permit, session].map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    const window = await windowSinceCursor(log);
    assert.deepEqual(
      [window.cursor, window.total, window.entries.map((entry) => entry.seq)],
      [2, 3, [2]],
    );
    const { result } = await awaitSignatureLog(log, {}, POLICY);
    assert.deepEqual(result.failures, ['session requests reached the main wallet: 1 > 0']);
  });

  it('waits up to timeout_ms for entries the host has not written yet', async () => {
    const { log } = await logDir([connect]);
    setTimeout(
      () =>
        writeFile(
          log.logFile,
          `${[connect, permit].map((entry) => JSON.stringify(entry)).join('\n')}\n`,
        ),
      200,
    );
    const { window, result } = await awaitSignatureLog(log, {
      counts: { Permit: 1 },
      timeout_ms: 3000,
    });
    assert.equal(result.ok, true);
    assert.equal(window.entries.length, 2);
  });

  it('retains a window under the artifacts dir, and nothing without one', async () => {
    const artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'dapp-siglog-art-'));
    const artifacts = await writeLogArtifact(
      { artifactsDir, nodeId: 'flow/sigs', folder: 'wallet' },
      { count: 1 },
    );
    assert.deepEqual(artifacts, [
      { path: 'wallet/flow__sigs-signature-log.json', type: 'report', nodeId: 'flow/sigs' },
    ]);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(artifactsDir, artifacts[0].path), 'utf8')),
      { count: 1 },
    );
    assert.deepEqual(
      await writeLogArtifact({ artifactsDir: undefined, nodeId: 'x', folder: 'wallet' }, {}),
      [],
    );
  });
});
