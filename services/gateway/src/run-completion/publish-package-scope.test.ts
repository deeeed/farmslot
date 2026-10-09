import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertPublishPackageWithinCaps,
  buildPublishPackageScanCommand,
  parsePublishPackageScan,
  selectPublishPackageEntries,
} from './publish-package-scope.js';

test('buildPublishPackageScanCommand lists the scope in one worker-side command', () => {
  const command = buildPublishPackageScanCommand("/w/it's/artifacts", ['goal/a b/shot.png']);
  assert.equal(
    command,
    [
      `cd '/w/it'\\''s/artifacts' || exit 3`,
      'find . -mindepth 1 -maxdepth 1 -type f -exec wc -c {} +',
      'set --',
      `for p in './recipe-library' './recipe-harness' './goal/a b/shot.png'; do [ -e "$p" ] && set -- "$@" "$p"; done`,
      `[ "$#" -eq 0 ] || find "$@" \\( -name 'node_modules' -o -name '.git' -o -path './experiment-manifest.json' -o -path './packages/reference.result-package.json' -o -path './packages/candidate.result-package.json' -o -path './recipe-harness/source' \\) -prune -o -type f -exec wc -c {} +`,
    ].join('\n'),
  );
});

test('the scan command runs under bash and prunes excluded trees', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'publish-package-scan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (relativePath: string, content: string) => {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content);
  };
  await put('report.md', '12345');
  await put('goal/a b/shot.png', '123');
  await put('goal/unnamed/huge.bin', 'x'.repeat(100));
  await put('recipe-library/recipes/r.recipe.json', '{}');
  await put('recipe-library/node_modules/d/i.js', 'x');
  await put('recipe-library/deep/.git/HEAD', 'x');

  const stdout = execFileSync('bash', [
    '-c',
    buildPublishPackageScanCommand(root, ['goal/a b/shot.png', 'goal/missing.png']),
  ]).toString();

  assert.deepEqual(
    parsePublishPackageScan(stdout).sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: 'goal/a b/shot.png', bytes: 3 },
      { path: 'recipe-library/recipes/r.recipe.json', bytes: 2 },
      { path: 'report.md', bytes: 5 },
    ],
  );
});

test('selectPublishPackageEntries keeps small top-level text and media, drops big and binary files', () => {
  const selected = selectPublishPackageEntries(
    [
      { path: 'report.md', bytes: 10 },
      { path: 'notes.txt', bytes: 1024 * 1024 },
      { path: 'trace.log', bytes: 1024 * 1024 + 1 },
      { path: 'walkthrough.mp4', bytes: 50 * 1024 ** 2 },
      { path: 'core.dump', bytes: 10 },
      { path: 'diff.txt', bytes: 10 },
      { path: 'pr-package.json', bytes: 10 },
      { path: 'evidence.zip', bytes: 10 },
      { path: 'recipe-library/recipes/r.recipe.json', bytes: 10 },
    ],
    ['evidence.zip'],
  );
  assert.deepEqual(
    selected.map((entry) => entry.path),
    [
      'report.md',
      'notes.txt',
      'walkthrough.mp4',
      'evidence.zip',
      'recipe-library/recipes/r.recipe.json',
    ],
  );
});

test('assertPublishPackageWithinCaps enforces the file cap and passes under both caps', () => {
  const entries = Array.from({ length: 4 }, (_, i) => ({ path: `recipe-library/f${i}`, bytes: 1 }));
  assert.doesNotThrow(() =>
    assertPublishPackageWithinCaps(entries, '/w/artifacts', { maxBytes: 4, maxFiles: 4 }),
  );
  assert.throws(
    () => assertPublishPackageWithinCaps(entries, '/w/artifacts', { maxBytes: 100, maxFiles: 3 }),
    /would mirror 4 file\(s\), 4 B from \/w\/artifacts, over the cap of 3 files \/ 100 B\. Largest directories: artifacts\/recipe-library\/ 4 B in 4 file\(s\)\./,
  );
});
