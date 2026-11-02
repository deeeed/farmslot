import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  changelogWithFragments,
  foldFragments,
  fragmentProblems,
  isFragmentPath,
  readChangelogWithFragments,
} from './changelog-fragments.mjs';
import { applyChangelogCut, unreleasedMeaningfulBullets } from './parse-changelog.mjs';

const placeholder =
  '- Active-development baseline; add user-facing changes here before release or package publication.';
const changelog = `# Changelog\n\n## Unreleased\n\n${placeholder}\n- An older bullet.\n\n## 1.0.0 - 2026-10-01\n\n- First release.\n`;

test('fragment bullets read as the end of the Unreleased section', () => {
  const merged = changelogWithFragments(changelog, ['- Fix the probe.\n', '- Add a flag.\n']);
  assert.deepEqual(unreleasedMeaningfulBullets(merged), [
    'An older bullet.',
    'Fix the probe.',
    'Add a flag.',
  ]);
  // Released sections are untouched and keep their spacing.
  assert.match(merged, /- Add a flag\.\n\n## 1\.0\.0 - 2026-10-01\n\n- First release\./);
  assert.equal(changelogWithFragments(changelog, []), changelog);
});

test('a release cut writes fragment bullets into the new version', () => {
  const merged = changelogWithFragments(changelog, ['- Fix the probe.\n']);
  const cut = applyChangelogCut(merged, {
    version: '1.1.0',
    date: '2026-11-02',
    include: unreleasedMeaningfulBullets(merged),
    defer: [],
  });
  assert.deepEqual(unreleasedMeaningfulBullets(cut), []);
  assert.match(cut, /## 1\.1\.0 - 2026-11-02\n\n- An older bullet\.\n- Fix the probe\./);
});

test('a fragment holds bullets only', () => {
  assert.deepEqual(fragmentProblems('- Fix the probe.\n  Continued line.\n'), []);
  assert.deepEqual(fragmentProblems('\n\n'), ['is empty']);
  assert.match(fragmentProblems('Fix the probe.\n')[0], /not a '- ' bullet/);
  assert.match(fragmentProblems(`${placeholder}\n`).join(), /placeholder/);
});

test('fragment paths are .md files directly under a .changes directory', () => {
  assert.equal(isFragmentPath('packages/cli/.changes/fix-probe.md'), true);
  assert.equal(isFragmentPath('.changes/root.md'), true);
  assert.equal(isFragmentPath('packages/cli/.changes/nested/x.md'), false);
  assert.equal(isFragmentPath('packages/cli/CHANGELOG.md'), false);
});

test('a workspace reads its changelog with every fragment in name order', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'changelog-fragments-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  mkdirSync(path.join(dir, '.changes'));
  writeFileSync(path.join(dir, '.changes', 'b-second.md'), '- Second.\n');
  writeFileSync(path.join(dir, '.changes', 'a-first.md'), '- First.\n');
  writeFileSync(path.join(dir, '.changes', 'notes.txt'), 'not a fragment');
  const { content, fragments } = readChangelogWithFragments(dir);
  assert.deepEqual(
    fragments.map((file) => path.basename(file)),
    ['a-first.md', 'b-second.md'],
  );
  assert.deepEqual(unreleasedMeaningfulBullets(content), ['An older bullet.', 'First.', 'Second.']);
});

test('folding writes the fragments into the changelog and deletes them', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'changelog-fold-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  mkdirSync(path.join(dir, '.changes'));
  writeFileSync(path.join(dir, '.changes', 'fix-probe.md'), '- Fix the probe.\n');
  assert.equal(foldFragments(dir), 1);
  assert.equal(existsSync(path.join(dir, '.changes', 'fix-probe.md')), false);
  assert.deepEqual(
    unreleasedMeaningfulBullets(readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')),
    ['An older bullet.', 'Fix the probe.'],
  );
  assert.equal(foldFragments(dir), 0);
});
