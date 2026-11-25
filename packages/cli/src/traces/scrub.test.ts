import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import { TraceScrubber } from './scrub.js';

const scrubber = () =>
  new TraceScrubber({
    secretValues: ['sk-live-configured-value-1234'],
    usernames: ['deeeed', 'farmops'],
    machines: ['macwork', 'mini'],
  });

test('each rule replaces its matches and is counted, never the value', () => {
  const s = scrubber();
  const out = s.text(
    [
      'token sk-live-configured-value-1234 used',
      `privateKey = 0x${'ab'.repeat(32)}`,
      'mail me at someone@example.org',
      'sentry https://abc123@o1.ingest.sentry.io/42',
      'GITHUB_TOKEN=ghx_not_a_real_one_but_long',
      'path /Users/deeeed/dev/farmslot on macwork as farmops',
    ].join('\n'),
  );
  assert.doesNotMatch(out, /sk-live-configured-value-1234/);
  // The publication patterns or the labelled-key rule, whichever matches first, removes the key.
  assert.doesNotMatch(out, /(ab){32}/);
  assert.doesNotMatch(out, /someone@example\.org/);
  assert.doesNotMatch(out, /abc123@o1/);
  assert.match(out, /GITHUB_TOKEN=\[REDACTED:secret-variable\]/);
  assert.match(out, /path ~\/dev\/farmslot on <machine> as \[REDACTED:username\]/);
  const report = s.report();
  for (const rule of [
    'secret-value',
    'email',
    'dsn',
    'secret-variable',
    'home-path',
    'machine',
    'username',
  ])
    assert.ok((report[rule] ?? 0) >= 1, `${rule} counted`);
  assert.doesNotMatch(JSON.stringify(report), /sk-live|example\.org/);
});

test("bare hex and Farmslot's own digests are kept", () => {
  const digest = 'c'.repeat(64);
  const out = scrubber().text(
    JSON.stringify({
      sha256: digest,
      diffSha256: digest,
      note: `see sha256:${digest}`,
      head: 'd'.repeat(40),
    }),
  );
  assert.equal(JSON.parse(out).sha256, digest);
  assert.equal(JSON.parse(out).diffSha256, digest);
  assert.match(JSON.parse(out).note, new RegExp(digest));
});

test('JSONL stays one valid record per line after redaction', () => {
  const lines = [
    JSON.stringify({ type: 'user', text: 'secret "sk-live-configured-value-1234" in quotes' }),
    JSON.stringify({ type: 'assistant', text: 'home /Users/deeeed/x' }),
  ];
  const out = scrubber().text(lines.join('\n')).split('\n');
  assert.equal(out.length, 2);
  for (const line of out) assert.doesNotThrow(() => JSON.parse(line));
  assert.match(out[1]!, /~\/x/);
});

test('code identifiers that merely contain secret-like words are left alone', () => {
  const out = scrubber().text('const tokenAmount = getKeyName(apiKeyPrefix);');
  assert.equal(out, 'const tokenAmount = getKeyName(apiKeyPrefix);');
});

test('file names take a token without brackets, a colon or a separator', () => {
  const name = scrubber().name('review-deeeed/session.jsonl');
  assert.equal(name, 'review-REDACTED-username-session.jsonl');
});

test('a hex key labelled without an assignment is caught by the private-key rule', () => {
  const s = scrubber();
  const out = s.text(`wallet seed ${'ef'.repeat(32)}`);
  assert.equal(out, 'wallet seed [REDACTED:private-key]');
  assert.equal(s.report()['private-key'], 1);
});

test('labelled secrets inside JSON are redacted with their key in view', () => {
  const s = scrubber();
  const out = s
    .text(
      [
        JSON.stringify({ privateKey: `0x${'ab'.repeat(32)}` }),
        JSON.stringify({ env: { FOO_TOKEN: 'abc-def-ghi', HOME: '/Users/deeeed' } }),
        JSON.stringify({ auth: { clientSecret: 'shh-very-secret' } }),
        JSON.stringify({ sessionKey: 'abc123def', taskKey: 'task-1', inputTokens: 1200 }),
      ].join('\n'),
    )
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(out[0].privateKey, '[REDACTED:private-key]');
  assert.equal(out[1].env.FOO_TOKEN, '[REDACTED:secret-variable]');
  assert.equal(out[1].env.HOME, '~');
  assert.equal(out[2].auth.clientSecret, '[REDACTED:secret-variable]');
  assert.deepEqual(out[3], { sessionKey: 'abc123def', taskKey: 'task-1', inputTokens: 1200 });
});

test('JSON keys are scrubbed and an unchanged line keeps its exact bytes', () => {
  const s = scrubber();
  const [keyed, untouched] = s
    .text(`{"/Users/deeeed/x":1}\n{"n":12345678901234567890}`)
    .split('\n');
  assert.equal(keyed, '{"~/x":1}');
  assert.equal(untouched, '{"n":12345678901234567890}');
});

test('generic key names keep their values; ref is not exempt; redacted keys never collide', () => {
  const s = scrubber();
  const [plain, collide] = s
    .text(
      [
        JSON.stringify({ key: 'Escape', cache_key: 'abc-123-def', public_key: 'pk-public-value' }),
        JSON.stringify({ '/Users/deeeed/a': 1, '/Users/farmops/a': 2 }),
      ].join('\n'),
    )
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(plain, {
    key: 'Escape',
    cache_key: 'abc-123-def',
    public_key: 'pk-public-value',
  });
  assert.deepEqual(Object.values(collide), [1, 2]);
  const ref = JSON.parse(s.text(JSON.stringify({ ref: 'mail someone@example.org' }))).ref;
  assert.doesNotMatch(ref, /someone@example\.org/);
});

test('keys named like Object members stay plain keys and unchanged lines stay byte-exact', () => {
  const line = '{"constructor":"x","__proto__":{"a":1},"toString":"y"}';
  assert.equal(scrubber().text(line), line);
  const changed = JSON.parse(
    scrubber().text('{"__proto__":{"home":"/Users/deeeed/x"},"constructor":1}'),
  );
  assert.deepEqual(Object.keys(changed), ['__proto__', 'constructor']);
});

test('obvious token shapes and PEM private keys are redacted as tokens and keys', () => {
  const s = scrubber();
  const tokens = [
    `ghp_${'a1'.repeat(18)}`,
    `github_pat_${'B2'.repeat(12)}`,
    `sk-ant-${'c3'.repeat(12)}`,
    `sk-proj-${'d4'.repeat(12)}`,
    `xoxb-${'1'.repeat(12)}-abc`,
    'AKIAIOSFODNN7EXAMPLE',
    `AIza${'e'.repeat(35)}`,
    `glpat-${'f'.repeat(20)}`,
    `npm_${'g'.repeat(36)}`,
    `eyJ${'h'.repeat(12)}.eyJ${'i'.repeat(12)}.${'j'.repeat(12)}`,
    `Bearer ${'k'.repeat(24)}`,
  ];
  const out = s.text(tokens.map((token) => `use ${token} here`).join('\n'));
  assert.equal(out, tokens.map(() => 'use [REDACTED:token] here').join('\n'));
  assert.equal(s.report().token, tokens.length);
  const pem = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'b3BlbnNzaA==',
    '-----END OPENSSH PRIVATE KEY-----',
  ];
  // Across lines of a text file, and inside one JSON string.
  assert.equal(
    s.text(['key:', ...pem, 'after'].join('\n')),
    ['key:', ...pem.map(() => '[REDACTED:private-key]'), 'after'].join('\n'),
  );
  assert.equal(
    JSON.parse(s.text(JSON.stringify({ text: `k ${pem.join('\n')} ok` }))).text,
    'k [REDACTED:private-key] ok',
  );
});

// A base64 PNG whose bytes spell a configured secret value: kept only where it is an image.
const PNG = `iVBORw0KGgoAAAANSUhEUg${'A'.repeat(40)}Zm9vYmFyU2VjcmV0VmFsdWU${'B'.repeat(40)}==`;
const withSecret = () =>
  new TraceScrubber({ secretValues: ['Zm9vYmFyU2VjcmV0VmFsdWU'], usernames: [], machines: [] });

test('an image payload with an image type and image bytes is kept as is', () => {
  const s = withSecret();
  const line = JSON.stringify({
    message: {
      content: [
        { type: 'image', data: PNG, mimeType: 'image/png' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
      ],
    },
    // Claude Code's second copy of a Read image.
    toolUseResult: { type: 'image', file: { base64: PNG, type: 'image/png' } },
  });
  assert.equal(s.text(line), line);
  assert.deepEqual(s.report(), {});
});

test('base64 that is not shown to be an image is scanned like any text', () => {
  const s = withSecret();
  const scrubbed = (value: unknown) => JSON.parse(s.text(JSON.stringify(value)));
  // A PDF source, an image block with no image type, a payload without image bytes.
  assert.equal(
    scrubbed({ type: 'base64', media_type: 'application/pdf', data: PNG }).data,
    PNG.replace('Zm9vYmFyU2VjcmV0VmFsdWU', '[REDACTED:secret-value]'),
  );
  assert.match(scrubbed({ type: 'image', data: PNG }).data, /REDACTED:secret-value/);
  assert.equal(
    scrubbed({ type: 'image', mimeType: 'image/png', data: 'Zm9vYmFyU2VjcmV0VmFsdWU' }).data,
    '[REDACTED:secret-value]',
  );
  // A secret-named key wins over an image data URL.
  assert.equal(
    scrubbed({ apiKey: `data:image/png;base64,${PNG}` }).apiKey,
    '[REDACTED:secret-variable]',
  );
  assert.match(scrubbed({ url: `data:image/svg+xml;base64,${PNG}` }).url, /REDACTED/);
});

test('scrubbing time grows with the input, not its square', () => {
  const s = scrubber();
  // Shapes that make backtracking patterns quadratic: long runs without the character a
  // pattern waits for, and 1 MB of base64 with nothing to show it is an image.
  const inputs = [
    'a'.repeat(1_000_000),
    'a.'.repeat(500_000),
    'A_'.repeat(500_000),
    `x@${'a.'.repeat(500_000)}`,
    `-----BEGIN RSA PRIVATE KEY----- ${'a'.repeat(1_000_000)}`,
    randomBytes(750_000).toString('base64'),
  ];
  const started = performance.now();
  for (const input of inputs)
    s.text(JSON.stringify({ type: 'image', mimeType: 'image/png', data: input }));
  const ms = performance.now() - started;
  // About 6 MB in all; the gitleaks patterns took about 12 s a megabyte.
  assert.ok(ms < 3000, `${Math.round(ms)} ms`);
});
