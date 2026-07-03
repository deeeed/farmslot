import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanForFloorSecrets } from '../src/scrub/floor.js';
import { scrubFiles, type ScrubInputFile } from '../src/scrub/scrubber.js';

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

// A realistic 24-word mnemonic built entirely from wordlist entries.
const MNEMONIC_24 =
  'legal winner thank year wave sausage worth useful legal winner thank year ' +
  'wave sausage worth useful legal winner thank year wave sausage worth title';

const POSITIVE_SECRETS: { label: string; kind: string; text: string }[] = [
  {
    label: '12-word SRP',
    kind: 'srp',
    text: 'abandon ability able about above absent absorb abstract absurd abuse access accident',
  },
  { label: '24-word SRP', kind: 'srp', text: MNEMONIC_24 },
  {
    label: 'PEM private key',
    kind: 'private-key',
    text: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAAA\n-----END RSA PRIVATE KEY-----',
  },
  {
    label: 'labeled hex private key',
    kind: 'private-key',
    text: 'privateKey: 0x4c0883a69102937d6231471b5dbb6204fe512961708279e1ba1cf8f3e2c9d1a7',
  },
  {
    label: 'JWT',
    // Assembled from parts so no contiguous token literal sits in the source file
    // (which would trip upstream secret scanners) while the runtime value still
    // exercises the scrubber.
    kind: 'jwt',
    text: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcDEF123456ghiJKLmnop'].join(
      '.',
    ),
  },
  { label: 'GitHub token', kind: 'github-token', text: `ghp_${'a'.repeat(36)}` },
  { label: 'GitHub PAT', kind: 'github-token', text: `github_pat_${'A1b2'.repeat(12)}` },
  { label: 'npm token', kind: 'npm-token', text: `npm_${'a'.repeat(36)}` },
  {
    label: 'Slack token',
    kind: 'slack-token',
    text: ['xoxb', '123456789012', 'abcdefghijklmno'].join('-'),
  },
  { label: 'AWS access key', kind: 'aws-access-key', text: 'AKIAIOSFODNN7EXAMPLE' },
  { label: 'Google API key', kind: 'google-api-key', text: `AIza${'a'.repeat(35)}` },
  { label: 'Stripe live key', kind: 'stripe-key', text: `sk_live_${'a'.repeat(24)}` },
  { label: 'OpenAI key', kind: 'openai-key', text: `sk-${'a'.repeat(32)}` },
  {
    label: 'basic-auth URL',
    kind: 'basic-auth',
    text: 'https://admin:s3cr3tpass@internal.example.com/api',
  },
];

test('every positively-identified secret category is detected with a fingerprint, not the raw value', () => {
  for (const { label, kind, text } of POSITIVE_SECRETS) {
    const hits = scanForFloorSecrets(`context before ${text} context after`);
    assert.ok(hits.length >= 1, `${label} produced no hit`);
    assert.ok(
      hits.some((h) => h.kind === kind),
      `${label} missing kind ${kind}`,
    );
    for (const hit of hits) {
      assert.match(hit.fingerprint, /^sha256:[a-f0-9]{12}$/, `${label} fingerprint shape`);
    }
  }
});

const CLEAN_TEXTS: { label: string; text: string }[] = [
  {
    label: 'ordinary prose with incidental wordlist words',
    text: 'the access account balance was verified and the token refresh worked as designed here',
  },
  { label: 'bare sha256 digest', text: `"sha256": "${'a'.repeat(64)}"` },
  { label: '0x tx hash', text: `txHash: 0x${'b'.repeat(64)}` },
  { label: 'short hex ids', text: 'commit abc1234 and slug a1b2c3d4 are fine' },
  {
    label: 'eleven wordlist words (below mnemonic length)',
    text: 'abandon ability able about above absent absorb abstract absurd abuse access',
  },
];

test('clean content is never false-blocked', () => {
  for (const { label, text } of CLEAN_TEXTS) {
    assert.equal(scanForFloorSecrets(text).length, 0, `${label} false-blocked`);
  }
});

test('dirty fixtures across every carried file type block the package', () => {
  const inputs: ScrubInputFile[] = [
    { packagePath: 'learnings.md', absolutePath: fixture('dirty-srp.md') },
    { packagePath: 'harness/x/keys.json', absolutePath: fixture('dirty-keys.json') },
    { packagePath: 'harness/x/summary.json', absolutePath: fixture('dirty-log-in-summary.json') },
    { packagePath: 'report.md', absolutePath: fixture('obfuscated-srp.md') },
  ];
  const outcome = scrubFiles(inputs);
  assert.equal(outcome.status, 'blocked');
  // Each dirty file is recorded in the block list.
  const blockedFiles = new Set(outcome.report.blocked.map((b) => b.file));
  assert.ok(blockedFiles.has('learnings.md'));
  assert.ok(blockedFiles.has('harness/x/keys.json'));
  assert.ok(blockedFiles.has('harness/x/summary.json'));
  assert.ok(blockedFiles.has('report.md'));
});

test('clean fixtures assemble to a pass with no block entries', () => {
  const outcome = scrubFiles([
    { packagePath: 'report.md', absolutePath: fixture('clean-report.md') },
    { packagePath: 'source.json', absolutePath: fixture('clean-source.json') },
  ]);
  assert.equal(outcome.status, 'pass');
  assert.equal(outcome.report.blocked.length, 0);
  assert.equal(outcome.retainedText.length, 2);
});

test('the block report never reproduces a raw secret value', () => {
  const secret = '0x4c0883a69102937d6231471b5dbb6204fe512961708279e1ba1cf8f3e2c9d1a7';
  const outcome = scrubFiles([{ packagePath: 'notes.md', content: `privateKey: ${secret}` }]);
  assert.equal(outcome.status, 'blocked');
  const serialized = JSON.stringify(outcome.report);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(secret.slice(2)), false);
});

test('absolute-path leaks are redacted to portable tokens without blocking', () => {
  const outcome = scrubFiles(
    [{ packagePath: 'report.md', content: 'ran under /home/eng/ws/run-1 then wrote output' }],
    { workspace: '/home/eng/ws/run-1' },
  );
  assert.equal(outcome.status, 'pass');
  assert.equal(outcome.retainedText[0].content.includes('/home/eng/ws/run-1'), false);
  assert.ok(outcome.retainedText[0].content.includes('$WORKSPACE'));
  assert.deepEqual(outcome.report.redactions, [
    { file: 'report.md', kind: 'absolute-path', count: 1 },
  ]);
});

test('file-type allowlist omits disallowed and unscannable inputs, never includes by default', () => {
  const outcome = scrubFiles([
    { packagePath: '.env', content: 'API_KEY=whatever' },
    { packagePath: 'profile.png', content: 'not really an image' },
    // Allowlisted extension but binary content -> unscannable, still omitted.
    { packagePath: 'corrupt.json', content: `{"a":1}${String.fromCharCode(0)}` },
    { packagePath: 'notes.md', content: 'all good here' },
  ]);
  const reasons = new Map(outcome.report.omitted.map((o) => [o.path, o.reason]));
  assert.equal(reasons.get('.env'), 'disallowed-type');
  assert.equal(reasons.get('profile.png'), 'disallowed-type');
  assert.equal(reasons.get('corrupt.json'), 'unscannable');
  assert.equal(outcome.retainedText.length, 1);
  assert.equal(outcome.retainedText[0].packagePath, 'notes.md');
});

test('media policy: only evidence-selected, visual-pass-cleared, attested media is retained', () => {
  const outcome = scrubFiles([
    {
      packagePath: 'harness/x/not-selected.png',
      absolutePath: fixture('clean-report.md'),
      isMedia: true,
      evidenceManifestSelected: false,
    },
    {
      packagePath: 'harness/x/no-attestation.png',
      absolutePath: fixture('clean-report.md'),
      isMedia: true,
      evidenceManifestSelected: true,
    },
    {
      packagePath: 'harness/x/redacted.png',
      absolutePath: fixture('clean-report.md'),
      isMedia: true,
      evidenceManifestSelected: true,
      visualPass: {
        file: 'harness/x/redacted.png',
        passedAt: '2026-07-03T15:45:00Z',
        attestedBy: 'agent-model',
        finding: 'redacted',
      },
    },
    {
      packagePath: 'harness/x/clear.png',
      absolutePath: fixture('clean-report.md'),
      isMedia: true,
      evidenceManifestSelected: true,
      visualPass: {
        file: 'harness/x/clear.png',
        passedAt: '2026-07-03T15:45:00Z',
        attestedBy: 'agent-model',
        finding: 'clear',
      },
    },
  ]);
  const reasons = new Map(outcome.report.omitted.map((o) => [o.path, o.reason]));
  assert.equal(reasons.get('harness/x/not-selected.png'), 'media-not-selected');
  assert.equal(reasons.get('harness/x/no-attestation.png'), 'media-no-attestation');
  assert.equal(reasons.get('harness/x/redacted.png'), 'media-visual-block');
  assert.deepEqual(outcome.retainedMedia, ['harness/x/clear.png']);
  // Every visual pass performed is recorded, even when it blocked.
  assert.equal(outcome.report.visualPassAttestations.length, 2);
});
