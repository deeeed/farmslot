import assert from 'node:assert/strict';
import test from 'node:test';

import { scanForFloorSecrets } from '../src/scrub/floor.js';
import { scrubFiles } from '../src/scrub/scrubber.js';

// Adversarial-fixture suite (safety-critical): every planted fixture MUST yield
// a block or an omission - zero floor false-negatives. "Adversarial" here means
// realistic accidental carriers per the ratified three-layer model, not
// obfuscation (ROT13/base64 tricks are explicitly out of scope: the producer is
// cooperative and the human approval gate is the guarantee).

const MNEMONIC_24 =
  'legal winner thank year wave sausage worth useful legal winner thank year ' +
  'wave sausage worth useful legal winner thank year wave sausage worth title';

const PRIVATE_KEY_HEX = [
  '0x4c0883a69102937d6231471b5dbb',
  '6204fe512961708279e1ba1cf8f3e2c9d1a7',
].join('');

test('planted wallet fixture JSON (mnemonic + key) blocks the package', () => {
  const walletFixture = JSON.stringify({
    name: 'test-wallet',
    mnemonic: MNEMONIC_24,
    privateKey: PRIVATE_KEY_HEX,
    address: `0x${'ab12'.repeat(10)}`,
  });
  const outcome = scrubFiles([{ packagePath: 'harness/x/wallet.json', content: walletFixture }]);
  assert.equal(outcome.status, 'blocked');
  const kinds = new Set(outcome.report.blocked.map((b) => b.kind));
  assert.ok(kinds.has('srp'));
  assert.ok(kinds.has('private-key'));
  assert.equal(outcome.retainedText.length, 0);
});

test('SRP inside a JSON-stringified log blob (literal \\n separators) is still detected', () => {
  const embedded = JSON.stringify({
    log: `restoring wallet:\n${'abandon\nability\nable\nabout\nabove\nabsent\nabsorb\nabstract\nabsurd\nabuse\naccess\naccident'}\ndone`,
  });
  // The file content carries literal backslash-n sequences, not newlines.
  assert.ok(embedded.includes('\\n'));
  const hits = scanForFloorSecrets(embedded);
  assert.ok(
    hits.some((h) => h.kind === 'srp'),
    'JSON-escaped SRP must be a floor hit',
  );
});

test('.env-style blobs: the file is omitted by type; leaked assignments in eligible files block', () => {
  const envBlob = [
    'NODE_ENV=test',
    `PRIVATE_KEY=${PRIVATE_KEY_HEX}`,
    `GITHUB_TOKEN=ghp_${'a'.repeat(36)}`,
  ].join('\n');
  const outcome = scrubFiles([
    // Layer 1: the .env file itself is never eligible, whatever it contains.
    { packagePath: '.env.local', content: envBlob },
    // Layer 2: the same content pasted into a report still blocks.
    { packagePath: 'report.md', content: `# Report\n\n\`\`\`\n${envBlob}\n\`\`\`\n` },
  ]);
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.report.omitted[0].path, '.env.local');
  assert.equal(outcome.report.omitted[0].reason, 'disallowed-type');
  const blockedKinds = new Set(outcome.report.blocked.map((b) => b.kind));
  assert.ok(blockedKinds.has('private-key'));
  assert.ok(blockedKinds.has('github-token'));
});

test('cookie headers, OAuth tokens, and session-token assignments are floor hits', () => {
  const cases: { label: string; kind: string; text: string }[] = [
    {
      label: 'Set-Cookie header',
      kind: 'cookie',
      text: 'Set-Cookie: session=8f4b2c1d9e0a7b6c5d4e3f2a1b0c9d8e; Path=/; HttpOnly',
    },
    {
      label: 'Cookie header in a request dump',
      kind: 'cookie',
      text: 'cookie: auth_session=dGhpcy1pcy1hLXNlc3Npb24tdmFsdWU',
    },
    { label: 'Google OAuth access token', kind: 'oauth-token', text: `ya29.${'A'.repeat(40)}` },
    {
      label: 'session token assignment',
      kind: 'session-token',
      text: 'sessionToken: 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c',
    },
  ];
  for (const { label, kind, text } of cases) {
    const hits = scanForFloorSecrets(`before ${text} after`);
    assert.ok(
      hits.some((h) => h.kind === kind),
      `${label}: expected floor kind ${kind}`,
    );
  }
});

test('UNION-only: farm extra patterns ADD blocks and can never loosen the floor', () => {
  const farmPattern = { kind: 'farm-fixture-tag', pattern: /FARM-FIXTURE-SECRET-[0-9]+/g };

  // The extra pattern adds a new deny.
  const added = scrubFiles(
    [{ packagePath: 'report.md', content: 'used FARM-FIXTURE-SECRET-42 here' }],
    {},
    { extraDenyPatterns: [farmPattern] },
  );
  assert.equal(added.status, 'blocked');
  assert.equal(added.report.blocked[0].kind, 'farm-fixture-tag');

  // No configuration - extra patterns, empty extras, wallet-address preference -
  // stops the floor from blocking a planted SRP. There is no loosening parameter.
  for (const options of [
    {},
    { extraDenyPatterns: [] },
    { extraDenyPatterns: [farmPattern], allowWalletAddresses: true },
  ]) {
    const outcome = scrubFiles(
      [{ packagePath: 'learnings.md', content: MNEMONIC_24 }],
      {},
      options,
    );
    assert.equal(outcome.status, 'blocked', `floor loosened by ${JSON.stringify(options)}`);
    assert.ok(outcome.report.blocked.some((b) => b.kind === 'srp'));
  }
});

test('non-blocking secrets are replaced with [REDACTED:...] and never survive anywhere', () => {
  const email = 'jane.reporter@example.com';
  const wallet = `0x${'c0ffee12'.repeat(5)}`;
  const outcome = scrubFiles([
    { packagePath: 'report.md', content: `Reported by ${email}; account ${wallet} funded.` },
  ]);
  assert.equal(outcome.status, 'pass');

  const content = outcome.retainedText[0].content;
  assert.equal(content.includes(email), false);
  assert.equal(content.toLowerCase().includes(wallet.toLowerCase()), false);
  assert.match(content, /\[REDACTED:email:sha256:[a-f0-9]{12}\]/);
  assert.match(content, /\[REDACTED:wallet-address:sha256:[a-f0-9]{12}\]/);

  const kinds = new Map(outcome.report.redactions.map((r) => [r.kind, r.count]));
  assert.equal(kinds.get('email'), 1);
  assert.equal(kinds.get('wallet-address'), 1);

  // The report itself never reproduces a raw value.
  const serialized = JSON.stringify(outcome.report);
  assert.equal(serialized.includes(email), false);
  assert.equal(serialized.toLowerCase().includes(wallet.toLowerCase()), false);
});

test('farm config may mark wallet addresses public: redaction preference only', () => {
  const wallet = `0x${'c0ffee12'.repeat(5)}`;
  const outcome = scrubFiles(
    [{ packagePath: 'report.md', content: `test account ${wallet}` }],
    {},
    { allowWalletAddresses: true },
  );
  assert.equal(outcome.status, 'pass');
  assert.ok(outcome.retainedText[0].content.includes(wallet));
  assert.deepEqual(outcome.report.redactions, []);
});

test('redaction tokens do not corrupt JSON files', () => {
  const content = JSON.stringify({ contact: 'ops@example.com', note: 'fine' });
  const outcome = scrubFiles([{ packagePath: 'harness/x/summary.json', content }]);
  assert.equal(outcome.status, 'pass');
  const parsed = JSON.parse(outcome.retainedText[0].content) as { contact: string; note: string };
  assert.match(parsed.contact, /^\[REDACTED:email:/);
  assert.equal(parsed.note, 'fine');
});
