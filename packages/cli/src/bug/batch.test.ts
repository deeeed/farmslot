import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// slot-config reads FARMSLOT_PROJECTS_DIR into a module const when config.ts is
// first imported, so it MUST be set before runBatch (which pulls in config.ts)
// is dynamically imported below. This file statically imports nothing that loads
// config.ts, and each test file runs in its own process, so this is isolated.
const PROJECTS_DIR = mkdtempSync(path.join(tmpdir(), 'farmslot-cli-batch-'));
process.env.FARMSLOT_PROJECTS_DIR = PROJECTS_DIR;

after(async () => {
  await rm(PROJECTS_DIR, { recursive: true, force: true });
});

// A fake `gh` on PATH returns a fixed two-issue list, so runBatch reaches the
// triage + display stages without a real gh/network dependency.
const GH_ISSUES = [
  { number: 1, title: 'Good', labels: [], assignees: [], updatedAt: '2026-01-01T00:00:00Z' },
  { number: 2, title: 'Bad', labels: [], assignees: [], updatedAt: '2026-01-01T00:00:00Z' },
];

const BASE_OPTS = {
  source: 'github' as const,
  label: [] as string[],
  limit: 100,
  excludeAssigned: false,
  parallel: 4,
  rescore: false,
  now: new Date('2026-01-02T00:00:00Z'),
};

/**
 * Build a project fixture: one good score file (skip-existing → skipped) and one
 * corrupt score file, plus a fake `gh` on PATH. When `preValidated`, the good
 * file already carries a validation section so the validate stage skips it and
 * no real `claude` edge is spawned. Returns a restore fn for PATH.
 */
async function setupFixture(name: string, preValidated: boolean): Promise<() => void> {
  const projectDir = path.join(PROJECTS_DIR, name);
  const scoresDir = path.join(projectDir, 'scores');
  const binDir = path.join(projectDir, 'bin');
  await mkdir(scoresDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({ ci: { repo: 'org/repo' } }),
  );

  const goodScore: Record<string, unknown> = {
    issue_ref: 'org/repo#1',
    bug_input: { title: 'Good one' },
    heuristic: { difficulty: 'low', one_shot_probability: 0.9, category: 'ui' },
  };
  if (preValidated) {
    goodScore.validation = {
      still_valid: true,
      confidence: 0.8,
      reason: 'ok',
      validated_at: '2026-01-01T00:00:00Z',
    };
  }
  await writeFile(path.join(scoresDir, 'gh-1.json'), JSON.stringify(goodScore));
  await writeFile(path.join(scoresDir, 'gh-2.json'), '{ not json');

  const gh = path.join(binDir, 'gh');
  await writeFile(gh, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(GH_ISSUES)}\nJSON\n`);
  chmodSync(gh, 0o755);
  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}:${prevPath ?? ''}`;
  return () => {
    process.env.PATH = prevPath;
  };
}

test('runBatch reports a corrupt score file once and keeps going (triage + display)', async () => {
  const restore = await setupFixture('batchproj', false);
  try {
    const { runBatch } = await import('./pipeline.js');
    const result = await runBatch('batchproj', { ...BASE_OPTS, validate: false });

    assert.equal(result.total, 2);
    assert.equal(result.scored, 0);
    assert.equal(result.skipped, 1); // gh-1 skip-existing
    assert.equal(result.failed, 1); // gh-2 corrupt — counted ONCE, not twice
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.code, 'CORRUPT_SCORE_FILE');
    assert.ok(result.report.includes('Scored: 1 issues')); // exactly one row rendered
    // scoredKeys must exclude the failed issue: with --rescore a failure can
    // leave a STALE score file that downstream (enqueue bridge) must not act on.
    assert.deepEqual(result.scoredKeys, ['gh-1']);
    assert.deepEqual(result.keys.sort(), ['gh-1', 'gh-2']);
  } finally {
    restore();
  }
});

test('runBatch dedups a corrupt score file across triage + validate + display', async () => {
  const restore = await setupFixture('batchvalidate', true);
  try {
    const { runBatch } = await import('./pipeline.js');
    // With validate: true the corrupt file is hit at the triage skip-check AND
    // the validation re-read AND the display re-read — all three must dedup to
    // one failure entry (append-time dedup, not post-filter).
    const result = await runBatch('batchvalidate', { ...BASE_OPTS, validate: true });

    assert.equal(result.total, 2);
    assert.equal(result.skipped, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.code, 'CORRUPT_SCORE_FILE');
    assert.ok(result.report.includes('Scored: 1 issues'));
  } finally {
    restore();
  }
});
