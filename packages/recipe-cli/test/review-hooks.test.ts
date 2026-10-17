import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  handleReview,
  type HarnessContext,
  type ReviewCommandOptions,
  type ReviewLibrary,
  setHarnessContext,
} from '../src/harness/index.js';

// A host CLI's checkout with one changed file, and a library that owns it.
function fixture(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-hooks-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(path.join(checkout, 'src/cart'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'README.md'), 'shop\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', checkout, ...args], { stdio: 'ignore' });
  git('init', '-q', '-b', 'trunk');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(checkout, 'src/cart/total.ts'), 'export {};\n');
  const library: ReviewLibrary = {
    name: 'cart',
    root: path.join(root, 'cart-library'),
    source: 'sibling',
    revision: null,
  };
  fs.mkdirSync(path.join(library.root, 'review'), { recursive: true });
  fs.writeFileSync(
    path.join(library.root, 'owned-paths.json'),
    JSON.stringify({ domain: 'cart', repos: { shop: ['src/cart/**'] } }),
  );
  fs.writeFileSync(
    path.join(library.root, 'review/antipatterns.md'),
    '# Cart\n\n## Stale totals\n\nRecompute totals after every line change.\n',
  );
  fs.writeFileSync(
    path.join(library.root, 'review/antipatterns.shop.md'),
    '# Shop\n\n## Rounding\n\nRound once, at display.\n',
  );
  const adapter: HarnessContext['adapter'] = { value: 'web', source: 'detect', detail: 'files' };
  setHarnessContext({ adapter, target: { value: checkout, source: 'flag', detail: '--target' } });
  t.after(() => setHarnessContext(undefined));
  return { root, checkout, library, adapter };
}

function captureOutput(t: TestContext) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  t.mock.method(process.stdout, 'write', (chunk: string) => stdout.push(chunk) > 0);
  t.mock.method(process.stderr, 'write', (chunk: string) => stderr.push(chunk) > 0);
  const read = () => {
    const result = { stdout: stdout.join(''), stderr: stderr.join('') };
    stdout.length = 0;
    stderr.length = 0;
    return result;
  };
  return read;
}

test('domain classifies against host libraries and names its source on stderr', async (t) => {
  const f = fixture(t);
  const output = captureOutput(t);
  const hooks: ReviewCommandOptions = {
    libraries: (input) => {
      assert.deepEqual(input, { target: f.checkout, runtime: 'shop' });
      return [f.library];
    },
    runtime: () => 'shop',
  };
  assert.equal(await handleReview(['domain'], hooks), 0);
  assert.deepEqual(output(), {
    stdout: 'cart\n',
    stderr: `domain: owned-paths match in ${f.library.root} (1 of 1 changed files)\n`,
  });
  await handleReview(['domain', '--json'], hooks);
  const report = JSON.parse(output().stdout);
  assert.equal(report.source, 'owned-paths');
  assert.deepEqual(report.libraries, [f.library]);
  assert.deepEqual(report.matches, [
    { domain: 'cart', library: f.library.root, matched: ['src/cart/total.ts'] },
  ]);
  await handleReview(['domain'], { runtime: () => 'shop' });
  assert.deepEqual(output(), {
    stdout: 'none\n',
    stderr: 'domain: no library owns the 1 changed files (base HEAD; libraries scanned: 0)\n',
  });
});

test('a declared domain names the flag or the host default as its source', async (t) => {
  fixture(t);
  const output = captureOutput(t);
  const hooks: ReviewCommandOptions = {
    defaultDomain: { read: () => 'cart', label: 'SHOP_DOMAIN' },
    libraries: () => assert.fail('a declared domain is not classified'),
  };
  await handleReview(['domain'], hooks);
  assert.deepEqual(output(), { stdout: 'cart\n', stderr: 'domain: declared via SHOP_DOMAIN\n' });
  await handleReview(['domain', '--domain', 'checkout'], hooks);
  assert.deepEqual(output(), { stdout: 'checkout\n', stderr: 'domain: declared via --domain\n' });
  await handleReview(['domain', '--json'], hooks);
  const { stdout, stderr } = output();
  assert.equal(JSON.parse(stdout).source, 'declared');
  assert.equal(stderr, '');
});

test('checklist renders the host library, header, wording and one domain patterns heading', async (t) => {
  const f = fixture(t);
  const output = captureOutput(t);
  const calls: unknown[] = [];
  await handleReview(['checklist', '--base', 'trunk', '--json'], {
    defaultDomain: { read: () => 'cart', label: 'SHOP_DOMAIN' },
    domainCommand: 'shop review domain',
    verdictRule: 'Post the verdict with nits listed separately.',
    runtime: (input) => {
      calls.push(input);
      return 'shop';
    },
    resolveLibrary: (input) => {
      calls.push(input);
      return f.library;
    },
    libraries: () => assert.fail('a declared domain resolves one library'),
    parity: () => ({
      referenceMissing: 'no reference checkout',
      steps: ['Record the missing reference.'],
    }),
    header: (input) => {
      calls.push(input);
      return [`Domain knowledge: ${input.library?.name} (${input.library?.source}).`];
    },
  });
  assert.deepEqual(calls, [
    { action: 'checklist', adapter: f.adapter, domain: 'cart' },
    { domain: 'cart', target: f.checkout, runtime: 'shop' },
    {
      runtime: 'shop',
      target: f.checkout,
      domain: 'cart',
      library: f.library,
      reference: undefined,
      referenceMissing: 'no reference checkout',
    },
  ]);
  const { checklist, library } = JSON.parse(output().stdout);
  assert.deepEqual(library, f.library);
  const lines = checklist.split('\n');
  assert.deepEqual(lines.slice(0, 4), [
    '# Review checklist — cart (shop)',
    '',
    'Domain knowledge: cart (sibling).',
    'Scope: `git diff trunk...HEAD`.',
  ]);
  assert.ok(
    lines.includes(
      '- [ ] 2. Confirm the domain is cart (`shop review domain`) and open review/antipatterns.md once before reading the diff.',
    ),
  );
  assert.equal(lines.filter((line: string) => line.startsWith('## Domain patterns')).length, 1);
  assert.match(
    checklist,
    /## Domain patterns \(cart\)\n- \[ \] 3\. Stale totals: .*\n- \[ \] 4\. Rounding: /u,
  );
  assert.match(
    checklist,
    /## Verdict\n- \[ \] \d+\. Post the verdict with nits listed separately\.\n$/u,
  );
});

test('host usage, runtime refusal and an unresolved library refuse before any output', async (t) => {
  fixture(t);
  const output = captureOutput(t);
  await assert.rejects(handleReview(['help'], { usage: 'Use shop review checklist|domain.' }), {
    message: 'Use shop review checklist|domain.',
    exitCode: 2,
  });
  await assert.rejects(
    handleReview(['domain'], {
      runtimeIds: ['web'],
      runtime: () => {
        throw new Error('--adapter must be one of shop (got web).');
      },
    }),
    /--adapter must be one of shop/u,
  );
  await assert.rejects(
    handleReview(['checklist', '--domain', 'cart', '--base', 'trunk'], {
      runtime: () => 'shop',
      resolveLibrary: () => undefined,
    }),
    { message: 'No authorized recipe library found for domain "cart".', exitCode: 2 },
  );
  assert.deepEqual(output(), { stdout: '', stderr: '' });
});

test('an owned-paths file with an empty domain is refused', async (t) => {
  const f = fixture(t);
  captureOutput(t);
  const file = path.join(f.library.root, 'owned-paths.json');
  fs.writeFileSync(file, JSON.stringify({ domain: '', repos: { shop: ['src/cart/**'] } }));
  await assert.rejects(
    handleReview(['domain'], { runtime: () => 'shop', libraries: () => [f.library] }),
    { message: `Invalid owned-paths.json: ${file}`, exitCode: 2 },
  );
});

test('without resolveLibrary, a declared domain is found among the host libraries', async (t) => {
  const f = fixture(t);
  const output = captureOutput(t);
  await handleReview(['checklist', '--domain', 'cart', '--base', 'trunk', '--json'], {
    runtimeIds: ['web'],
    runtime: () => 'shop',
    libraries: () => [f.library],
  });
  const result = JSON.parse(output().stdout);
  assert.deepEqual(result.library, f.library);
  assert.match(result.checklist, /^# Review checklist — cart \(shop\)/u);
});
