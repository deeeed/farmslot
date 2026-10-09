import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertPublishPackageWithinCaps,
  buildPublishPackageScanCommand,
  parsePublishPackageScan,
  prBodyCitedArtifactPaths,
  promotedSnapshotLinkEntries,
  selectPublishPackageEntries,
} from './publish-package-scope.js';

test('buildPublishPackageScanCommand lists the scope in one worker-side command', () => {
  const command = buildPublishPackageScanCommand("/w/it's/artifacts", {
    namedPaths: ['goal/a b/shot.png'],
    snapshotRoot: 'recipe-runs/r1',
  });
  const list = String.raw`\( -type f -exec wc -c {} + \) -o \( -type l -exec printf 'L %s\n' {} + \)`;
  const keep = '|| { rc=$?; [ "$scan_status" -ne 0 ] || scan_status=$rc; }';
  const prunes =
    "-name 'node_modules' -o -name '.git' -o -path './experiment-manifest.json' -o -path './packages/reference.result-package.json' -o -path './packages/candidate.result-package.json' -o -path './recipe-harness/source'";
  const lines = command.split('\n');
  assert.equal(lines[0], `cd '/w/it'\\''s/artifacts' || exit 3`);
  assert.equal(lines.at(-1), '} | head -n 40000');
  assert.ok(lines.includes(`find . -mindepth 1 -maxdepth 1 ${list} ${keep}`));
  assert.ok(
    lines.includes(
      `  for p in './recipe-library' './recipe-harness' './recipe-run' './recipe-run-baseline' './recipe-run-repro' './recipe-rerun' './recipe-baseline-run' './review-recipe-run' './perps-smoke' './check-diff' './check-diff-final' './evidence' './goal/a b/shot.png'; do if [ -e "$p" ] || [ -L "$p" ]; then printf 'R %s\\n' "$p"; fi; done`,
    ),
  );
  const markerFind = lines.find((line) => line.startsWith('  find . -maxdepth 4 '));
  assert.ok(markerFind, command);
  // Gateway review directories are the numbered ones only, from the shared policy.
  assert.ok(
    markerFind.includes(
      String.raw`\( -path './self-review-[0-9]*' ! -path './self-review-*[!0-9]*' \)`,
    ),
  );
  assert.ok(markerFind.includes(`-path './recipe-runs' -o -path './screenshots'`));
  assert.ok(
    markerFind.endsWith(
      String.raw`-prune -o -type f -path './*/*' \( -name artifact-manifest.json -o -name summary.json \) -exec printf 'M %s\n' {} + || echo "E:$?"`,
    ),
  );
  assert.ok(lines.some((line) => line.startsWith('done | LC_ALL=C sort -u | awk ')));
  assert.ok(
    lines.includes(
      `if [ "$#" -gt 0 ]; then find "$@" \\( ${prunes} \\) -prune -o ${list} ${keep}; fi`,
    ),
  );
  assert.ok(
    lines.includes(
      `if [ -d './recipe-runs/r1' ]; then find './recipe-runs/r1' -path './recipe-runs/r1/screenshots' -prune -o ${list} ${keep}; fi`,
    ),
  );
  assert.equal(lines.at(-2), 'echo "S $scan_status"');
});

test('the scan command finds recipe packages by marker within the depth bound, prunes excluded trees and lists links', async (t) => {
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
  await put('recipe-runs/r1/summary.json', '{"a":1}');
  await put('recipe-runs/r1/screenshots/raw.png', 'raw');
  await symlink('report.md', path.join(root, 'linked.md'));
  // Recipe packages found by marker: root at depth 1 and at the depth bound.
  await put('recipe-run-1/artifact-manifest.json', '{}');
  await put('recipe-run-1/videos/run.mp4.timeline.json', '[]');
  await put('a/b/c/summary.json', '{}');
  await put('a/b/c/trace.json', '[]');
  // Not packages: a root past the bound, summary.json without trace.json,
  // markers in pruned or excluded trees, and an unmarked scratch tree.
  await put('d/e/f/g/artifact-manifest.json', '{}');
  await put('notes/summary.json', '{}');
  await put('goal/node_modules/pkg/artifact-manifest.json', '{}');
  await put('screenshots/run/artifact-manifest.json', '{}');
  await put('review-loop-1/run/artifact-manifest.json', '{}');
  // A top-level marker does not make artifacts/ itself a package.
  await put('artifact-manifest.json', '{}');
  // A worker directory that only starts with a review prefix is the worker's.
  await put('self-review-fix-20261009/after-flag-off/artifact-manifest.json', '{}');
  await put('self-review-fix-20261009/after-flag-off/trace.json', '[]');
  await put('self-review-2/run/artifact-manifest.json', '{}');
  // A step directory that is also a package with both markers is listed once.
  await put('recipe-run/summary.json', '{}');
  await put('recipe-run/trace.json', '[]');
  await put('recipe-run/artifact-manifest.json', '{}');
  // A manifest may name any file type.
  await put('repro/before.json', '{}');

  const command = buildPublishPackageScanCommand(root, {
    namedPaths: ['goal/a b/shot.png', 'goal/missing.png', 'repro/before.json'],
    snapshotRoot: 'recipe-runs/r1',
  });
  // A local slot runs it under bash; a remote darwin node under `zsh -f`,
  // where `status` is read-only, so both shells are exercised when present.
  const shells = [['bash', '--noprofile', '--norc', '-c']];
  if (existsSync('/bin/zsh')) shells.push(['/bin/zsh', '-f', '-c']);
  for (const [shell, ...flags] of shells) {
    const stdout = execFileSync(shell, [...flags, command]).toString();
    const scan = parsePublishPackageScan(stdout);
    assert.equal(
      stdout.split('\n').filter((line) => line.endsWith(' ./recipe-run/trace.json')).length,
      1,
      shell,
    );
    assert.deepEqual(
      scan.entries.sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: 'a/b/c/summary.json', bytes: 2 },
        { path: 'a/b/c/trace.json', bytes: 2 },
        { path: 'artifact-manifest.json', bytes: 2 },
        { path: 'goal/a b/shot.png', bytes: 3 },
        { path: 'recipe-library/recipes/r.recipe.json', bytes: 2 },
        { path: 'recipe-run-1/artifact-manifest.json', bytes: 2 },
        { path: 'recipe-run-1/videos/run.mp4.timeline.json', bytes: 2 },
        { path: 'recipe-run/artifact-manifest.json', bytes: 2 },
        { path: 'recipe-run/summary.json', bytes: 2 },
        { path: 'recipe-run/trace.json', bytes: 2 },
        { path: 'recipe-runs/r1/summary.json', bytes: 7 },
        { path: 'report.md', bytes: 5 },
        { path: 'repro/before.json', bytes: 2 },
        { path: 'self-review-fix-20261009/after-flag-off/artifact-manifest.json', bytes: 2 },
        { path: 'self-review-fix-20261009/after-flag-off/trace.json', bytes: 2 },
      ],
      shell,
    );
    assert.deepEqual(scan.links, ['linked.md'], shell);
    assert.equal(scan.status, 0, shell);
    assert.equal(scan.truncated, false, shell);
  }
});

test('a scan failure keeps its status, and a listing without a status line is truncated', () => {
  assert.equal(parsePublishPackageScan('      3 ./a.md\nS 1\n').status, 1);
  const cut = parsePublishPackageScan('      3 ./a.md\n      4 ./b.md\n');
  assert.equal(cut.truncated, true);
  assert.throws(
    () => assertPublishPackageWithinCaps(cut.entries, '/w/artifacts', { truncated: true }),
    /would mirror more than 2 file\(s\) \(listing stopped\), at least 7 B from \/w\/artifacts/,
  );
});

test('selectPublishPackageEntries keeps top-level text and media at any size and reports the rest', () => {
  const selected = selectPublishPackageEntries(
    [
      { path: 'report.md', bytes: 10 },
      { path: 'report.html', bytes: 13 * 1024 ** 2 },
      { path: 'trace.json', bytes: 2 * 1024 ** 2 },
      { path: 'walkthrough.mp4', bytes: 50 * 1024 ** 2 },
      { path: 'core.dump', bytes: 10 },
      { path: 'build.zip', bytes: 10 },
      { path: 'diff.txt', bytes: 10 },
      { path: 'experiment-manifest.json', bytes: 10 },
      { path: 'pr-package.json', bytes: 10 },
      { path: 'named.webp', bytes: 10 },
      { path: 'recipe-run/report.md', bytes: 10 },
    ],
    ['named.webp'],
  );
  assert.deepEqual(
    selected.entries.map((entry) => entry.path),
    [
      'report.md',
      'report.html',
      'trace.json',
      'walkthrough.mp4',
      'named.webp',
      'recipe-run/report.md',
    ],
  );
  assert.deepEqual(selected.dropped, ['core.dump', 'build.zip']);
});

test('prBodyCitedArtifactPaths keeps artifact-relative media and rejects traversal, absolute and remote paths', () => {
  assert.deepEqual(
    prBodyCitedArtifactPaths(
      [
        '![a](artifacts/recipe-run/after.png)',
        '`temp/tasks/fix/x/artifacts/evidence/review.mp4`',
        '<img src="./videos/flow.webm">',
        '[Full recording](scale-e2e-run/videos/recipe-run.mp4)',
        '![r](https://raw.githubusercontent.com/o/r/main/artifacts/remote.png)',
        '![p](artifacts/../secret.png)',
        '![q](../outside/x.png)',
        '![abs](/etc/x.png)',
        '![raw](screenshots/step-1.png)',
        '![old](recipe-runs/r0/videos/old.mp4)',
        'see evidence-ac1.png and artifacts/report.md',
      ].join('\n'),
    ),
    [
      'evidence/review.mp4',
      'recipe-run/after.png',
      'scale-e2e-run/videos/recipe-run.mp4',
      'videos/flow.webm',
    ],
  );
});

test('promotedSnapshotLinkEntries counts in-root links like slotCopyDir copies them', async () => {
  const scan = {
    entries: [
      { path: 'recipe-runs/r1/videos/run.mp4', bytes: 100 },
      { path: 'recipe-runs/r1/summary.json', bytes: 2 },
    ],
    links: [
      'recipe-runs/r1/videos-again',
      'recipe-runs/r1/summary-link.json',
      'recipe-runs/r1/outside',
      'recipe-runs/r1/dangling',
      'recipe-runs/r1/videos/loop',
      'top-level-link.md',
    ],
    truncated: false,
  };
  const real: Record<string, string> = {
    'recipe-runs/r1': '/real/r1',
    'recipe-runs/r1/videos-again': '/real/r1/videos',
    'recipe-runs/r1/summary-link.json': '/real/r1/summary.json',
    'recipe-runs/r1/outside': '/real/elsewhere',
    'recipe-runs/r1/videos/loop': '/real/r1',
  };
  const added = await promotedSnapshotLinkEntries(
    scan,
    'recipe-runs/r1',
    async (relativePath) => real[relativePath] ?? null,
  );
  assert.deepEqual(added, [
    { path: 'recipe-runs/r1/videos-again/run.mp4', bytes: 100 },
    { path: 'recipe-runs/r1/summary-link.json', bytes: 2 },
  ]);
});

test('promotedSnapshotLinkEntries lets a realpath failure through', async () => {
  const scan = { entries: [], links: ['recipe-runs/r1/link'], truncated: false };
  await assert.rejects(
    () =>
      promotedSnapshotLinkEntries(scan, 'recipe-runs/r1', async () => {
        throw new Error('node transport closed');
      }),
    /node transport closed/,
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
