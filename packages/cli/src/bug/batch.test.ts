import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// slot-config reads FARMSLOT_PROJECTS_DIR into a module const when config.ts is
// first imported, so it MUST be set before runBatch (which pulls in config.ts)
// is dynamically imported below. This file statically imports nothing that loads
// config.ts, and each test file runs in its own process, so this is isolated.
const PROJECTS_DIR = mkdtempSync(path.join(tmpdir(), 'farmslot-cli-batch-'));
process.env.FARMSLOT_PROJECTS_DIR = PROJECTS_DIR;

// A fake `gh` on PATH returns a fixed two-issue list, so runBatch reaches the
// triage + display stages without a real gh/network dependency.
const GH_ISSUES = [
  { number: 1, title: 'Good', labels: [], assignees: [], updatedAt: '2026-01-01T00:00:00Z' },
  { number: 2, title: 'Bad', labels: [], assignees: [], updatedAt: '2026-01-01T00:00:00Z' },
];

test('runBatch reports a corrupt score file once and keeps going end-to-end', async () => {
  const name = 'batchproj';
  const projectDir = path.join(PROJECTS_DIR, name);
  const scoresDir = path.join(projectDir, 'scores');
  const binDir = path.join(PROJECTS_DIR, 'bin');
  const prevPath = process.env.PATH;
  try {
    await mkdir(scoresDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({ ci: { repo: 'org/repo' } }),
    );

    // One good score file (skip-existing → skipped) and one corrupt (throws at
    // both the triage skip-check and the display re-read — must dedup to one).
    await writeFile(
      path.join(scoresDir, 'gh-1.json'),
      JSON.stringify({
        issue_ref: 'org/repo#1',
        bug_input: { title: 'Good one' },
        heuristic: { difficulty: 'low', one_shot_probability: 0.9, category: 'ui' },
      }),
    );
    await writeFile(path.join(scoresDir, 'gh-2.json'), '{ not json');

    const gh = path.join(binDir, 'gh');
    await writeFile(gh, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(GH_ISSUES)}\nJSON\n`);
    chmodSync(gh, 0o755);
    process.env.PATH = `${binDir}:${prevPath ?? ''}`;

    const { runBatch } = await import('./pipeline.js');
    const result = await runBatch(name, {
      source: 'github',
      label: [],
      limit: 100,
      excludeAssigned: false,
      parallel: 4,
      rescore: false,
      validate: false,
      now: new Date('2026-01-02T00:00:00Z'),
    });

    assert.equal(result.total, 2);
    assert.equal(result.scored, 0);
    assert.equal(result.skipped, 1); // gh-1 skip-existing
    assert.equal(result.failed, 1); // gh-2 corrupt — counted ONCE, not twice
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.code, 'CORRUPT_SCORE_FILE');
    assert.ok(result.report.includes('Scored: 1 issues')); // exactly one row rendered
  } finally {
    process.env.PATH = prevPath;
    await rm(PROJECTS_DIR, { recursive: true, force: true });
  }
});
