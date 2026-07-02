import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyChangelogCut,
  bumpSemver,
  isPlaceholderBullet,
  meaningfulBullets,
  unreleasedMeaningfulBullets,
} from './parse-changelog.mjs';

const SAMPLE = `# Changelog

All notable changes.

## Unreleased

- Add operator-facing feature.
- Internal refactor only.
- Active-development baseline; add user-facing changes here before release or package publication.

## 0.1.0 - 2026-01-01

- Initial release.
`;

test('meaningfulBullets filters placeholders', () => {
  const bullets = meaningfulBullets(
    `- Real change.\n- Active-development baseline; add user-facing changes here.`,
  );
  assert.deepEqual(bullets, ['Real change.']);
});

test('unreleasedMeaningfulBullets reads only Unreleased section', () => {
  const bullets = unreleasedMeaningfulBullets(SAMPLE);
  assert.equal(bullets.includes('Add operator-facing feature.'), true);
  assert.equal(bullets.includes('Initial release.'), false);
});

test('bumpSemver patch increments patch segment', () => {
  assert.equal(bumpSemver('0.1.0', 'patch'), '0.1.1');
  assert.equal(bumpSemver('0.1.9', 'minor'), '0.2.0');
});

test('applyChangelogCut moves include bullets into dated section', () => {
  const next = applyChangelogCut(SAMPLE, {
    version: '0.1.1',
    date: '2026-07-02',
    include: ['Add operator-facing feature.'],
    defer: ['Internal refactor only.'],
  });
  const unreleased = unreleasedMeaningfulBullets(next);
  assert.deepEqual(unreleased, ['Internal refactor only.']);
  assert.match(next, /## 0\.1\.1 - 2026-07-02[\s\S]*- Add operator-facing feature\./);
});

test('isPlaceholderBullet recognizes baseline line', () => {
  assert.equal(
    isPlaceholderBullet('- Active-development baseline; add user-facing changes here.'),
    true,
  );
});
