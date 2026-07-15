import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { collectBatchRows, renderBatchReport } from './display.js';
import { isoTimestamp, readScoreFile, writeScoreFile } from './score-file.js';
import { githubImageFilename, parseGithubRef } from './triage.js';

// ── parseGithubRef ────────────────────────────────────────────────────────────

test('parseGithubRef parses owner/repo#N shorthand', () => {
  assert.deepEqual(parseGithubRef('deeeed/farmslot#42'), { repo: 'deeeed/farmslot', number: '42' });
});

test('parseGithubRef parses a full issues URL', () => {
  assert.deepEqual(parseGithubRef('https://github.com/deeeed/farmslot/issues/42'), {
    repo: 'deeeed/farmslot',
    number: '42',
  });
});

test('parseGithubRef throws on an unparseable ref', () => {
  assert.throws(() => parseGithubRef('not-a-ref'), /cannot parse GitHub ref/);
});

// ── githubImageFilename ───────────────────────────────────────────────────────

test('githubImageFilename keeps a meaningful basename', () => {
  assert.equal(
    githubImageFilename('https://example.com/path/after-trade.png', '99', 1),
    'after-trade.png',
  );
});

test('githubImageFilename replaces a UUID basename with a numbered name', () => {
  const url = 'https://github.com/user-attachments/assets/12345678-1234-1234-1234-1234567890ab';
  assert.equal(githubImageFilename(url, '99', 3), 'gh-99-3.png');
});

test('githubImageFilename sanitizes unsafe characters', () => {
  assert.equal(githubImageFilename('https://example.com/a%20b.png', '1', 1), 'a-b.png');
});

test('githubImageFilename numbers extensionless basenames', () => {
  assert.equal(githubImageFilename('https://example.com/screenshot', '7', 2), 'gh-7-2.png');
});

// ── isoTimestamp ──────────────────────────────────────────────────────────────

test('isoTimestamp drops milliseconds', () => {
  assert.equal(isoTimestamp(new Date('2026-07-14T22:31:05.123Z')), '2026-07-14T22:31:05Z');
});

// ── score file IO ─────────────────────────────────────────────────────────────

test('score file round-trips and preserves unknown sections on re-read', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bug-score-'));
  try {
    const file = path.join(dir, 'scores', 'gh-1.json');
    assert.equal(await readScoreFile(file), null); // missing → null

    await writeScoreFile(file, { issue_ref: 'gh-1', llm: undefined, custom: 'kept' });
    const back = await readScoreFile(file);
    assert.equal(back?.issue_ref, 'gh-1');
    assert.equal(back?.['custom'], 'kept');
    // Pretty-printed, no trailing newline (json.dump parity).
    const raw = await readFile(file, 'utf8');
    assert.ok(raw.startsWith('{\n'));
    assert.ok(!raw.endsWith('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readScoreFile throws loudly on a corrupt file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bug-score-'));
  try {
    const file = path.join(dir, 'bad.json');
    await writeScoreFile(file, {}); // create the dir
    await readFile(file); // ensure it exists
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{ not json');
    await assert.rejects(() => readScoreFile(file), /corrupt score file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── collectBatchRows ──────────────────────────────────────────────────────────

test('collectBatchRows tolerates a corrupt score file per-item (batch display stage)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bug-score-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    // One good score file, one corrupt — the corrupt one must not abort the run.
    await writeScoreFile(path.join(dir, 'gh-1.json'), {
      issue_ref: 'org/repo#1',
      bug_input: {
        title: 'Good one',
      } as never,
      heuristic: { difficulty: 'low', one_shot_probability: 0.9, category: 'ui' } as never,
    });
    await writeFile(path.join(dir, 'gh-2.json'), '{ not json');

    const errors: Array<{ key: string; code: unknown }> = [];
    const rows = await collectBatchRows(dir, ['gh-1', 'gh-2'], (key, err) => {
      errors.push({ key, code: (err as { code?: unknown }).code });
    });

    // The good row is still returned; the corrupt file is reported, not thrown.
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.num, '1');
    assert.deepEqual(errors, [{ key: 'gh-2', code: 'CORRUPT_SCORE_FILE' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── renderBatchReport ─────────────────────────────────────────────────────────

test('renderBatchReport renders a header and rows sorted view', () => {
  const report = renderBatchReport(
    [
      {
        num: '10',
        difficulty: 'low',
        prob: 0.8,
        category: 'ui',
        title: 'A',
        valid: null,
        validConf: 0,
        validReason: '',
      },
    ],
    { repo: 'deeeed/farmslot', displayLabels: 'type-bug' },
  );
  assert.ok(report.includes('Batch triage'));
  assert.ok(report.includes('deeeed/farmslot'));
  assert.ok(report.includes('Scored: 1 issues'));
  assert.ok(report.includes('Low-effort wins (low + p>=0.7): 1'));
});

test('renderBatchReport handles the empty case', () => {
  const report = renderBatchReport([], { repo: 'deeeed/farmslot' });
  assert.ok(report.includes('No scored results.'));
});
