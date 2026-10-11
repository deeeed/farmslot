import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validator = resolve(repoRoot, 'scripts/validate-cross-review-loop-json.mjs');
const artifacts = [
  '.agents/skills/cross-model-orchestrator/templates/CROSS-REVIEW-LOOP.json',
  'docs/operations/evidence/adr032/pr81-CROSS-REVIEW-LOOP.json',
  'docs/operations/evidence/adr032/invalid-paths-guard-CROSS-REVIEW-LOOP.json',
];

function validate(files) {
  return spawnSync(process.execPath, [validator, ...files], { cwd: repoRoot, encoding: 'utf8' });
}

test('migrated templates and retained evidence still resolve their schema and validate', () => {
  for (const artifact of artifacts) {
    const document = JSON.parse(readFileSync(resolve(repoRoot, artifact), 'utf8'));
    const schema = resolve(repoRoot, dirname(artifact), document.$schema);
    assert.ok(existsSync(schema), `${artifact} schema must exist`);
  }
  const result = validate(artifacts);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, artifacts.length);
});

test('invalid retained evidence cannot pass after migration', (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'cross-review-artifact-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const original = JSON.parse(readFileSync(resolve(repoRoot, artifacts[1]), 'utf8'));
  for (const [name, mutate] of [
    ['missing-status', (document) => delete document.status],
    [
      'invalid-verdict',
      (document) => {
        document.cycleRecords[0].reviewerVerdicts[0].verdict = 'UNKNOWN';
      },
    ],
  ]) {
    const document = structuredClone(original);
    mutate(document);
    const artifact = resolve(directory, `${name}.json`);
    writeFileSync(artifact, JSON.stringify(document));
    const result = validate([artifact]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing required field status|invalid verdict UNKNOWN/);
  }
});
