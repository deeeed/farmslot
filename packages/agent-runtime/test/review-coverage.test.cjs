const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  sha256,
  coverageRowKey,
  readCoverageIndex,
  reusableCoverageRows,
  composeCoverageRows,
  renderCoverage,
  materializeReviewCoverage,
} = require('../scripts/review-coverage.cjs');

function fixture() {
  const definitions = [
    { kind: 'scope', path: 'src/math.ts' },
    {
      kind: 'criterion',
      unitId: 'shared',
      stepNumber: 1,
      ruleSourceSha256: 'rule',
      label: 'Check math',
    },
    {
      kind: 'criterion',
      unitId: 'shared',
      stepNumber: 2,
      ruleSourceSha256: 'rule',
      label: 'Record gaps',
    },
  ];
  const inputs = {
    runId: 'first',
    headSha: 'old',
    authorizationHash: 'scope',
    ruleHash: 'rules',
    definitions,
    sourceHashes: { 'src/math.ts': '100644:old-blob' },
    evidenceHashes: { 'first:proof.json': 'proof' },
  };
  const index = composeCoverageRows(inputs, {
    schemaVersion: 1,
    reuse: [],
    rows: [
      {
        key: coverageRowKey(definitions[0]),
        scope: 'AC1',
        justification: 'Required math implementation',
        sources: [],
        artifacts: [],
      },
      {
        key: coverageRowKey(definitions[1]),
        outcome: 'FINDING',
        evidence: 'F1: rounding is wrong',
        sources: ['src/math.ts'],
        artifacts: ['first:proof.json'],
      },
      {
        key: coverageRowKey(definitions[2]),
        outcome: 'NOT_CHECKED',
        evidence: 'Runtime was not available',
        sources: [],
        artifacts: [],
      },
    ],
  });
  index.reportSha256 = 'report';
  const bytes = JSON.stringify(index);
  const expected = {
    runId: 'first',
    headSha: 'old',
    reportSha256: 'report',
    indexSha256: sha256(bytes),
  };
  const current = { ...inputs, runId: 'second', headSha: 'new' };
  return { index, bytes, expected, current, definitions };
}

test('reuse requires a digest and identity from a validated baseline result', () => {
  const f = fixture();
  assert.deepEqual(readCoverageIndex(f.bytes, f.expected), f.index);
  for (const key of ['indexSha256', 'runId', 'headSha', 'reportSha256'])
    assert.equal(readCoverageIndex(f.bytes, { ...f.expected, [key]: 'different' }), null, key);
  assert.equal(readCoverageIndex(undefined, f.expected), null);
  assert.equal(readCoverageIndex('{', { ...f.expected, indexSha256: sha256('{') }), null);
  assert.deepEqual(reusableCoverageRows(null, f.current).reusable, []);
});

function taskFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-task-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'source');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/math.ts'), 'export const value = 1;\n');
  const commit = () => {
    git('add', '-A');
    git(
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  const head = commit();
  function task(id, headSha, scopePaths, baseline) {
    const dir = path.join(root, id);
    fs.mkdirSync(path.join(dir, 'inputs'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'artifacts'));
    fs.writeFileSync(path.join(dir, 'CHECKLIST.md'), '- [ ] Check math\n');
    fs.writeFileSync(
      path.join(dir, 'inputs/instruction-manifest.json'),
      JSON.stringify({
        reviewCoverage: {
          schemaVersion: 1,
          runId: id,
          repo,
          headSha,
          authorizationHash: 'scope',
          ruleHash: 'rules',
          scopePaths,
          baseline,
        },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'artifacts/review.md'),
      `VERDICT: REQUEST_CHANGES\nCOMMIT: ${headSha}\n\n## Findings\nF1 remains open.\n`,
    );
    // This engine artifact is deliberately invalid JSON; the composer must never read it.
    fs.writeFileSync(
      path.join(dir, 'artifacts/acceptance-status.json'),
      'ENGINE LEDGER IS NOT REVIEW COVERAGE',
    );
    return dir;
  }
  function result(dir, coverage) {
    fs.writeFileSync(
      path.join(dir, 'artifacts/review-result.json'),
      JSON.stringify({
        verdict: 'issues',
        recommendation: 'REQUEST_CHANGES',
        issues: [{ file: 'src/math.ts', line: 1, severity: 'major', description: 'F1 remains' }],
        coverage,
      }),
    );
  }
  return { root, repo, git, commit, head, task, result };
}

test('real task composition renders every row once, retains current findings and ignores the engine ledger', (t) => {
  const f = taskFixture(t);
  const dir = f.task('cold', f.head, ['src/math.ts']);
  f.result(dir, {
    schemaVersion: 1,
    reuse: [],
    rows: [
      {
        kind: 'scope',
        path: 'src/math.ts',
        scope: 'AC1',
        justification: 'Math implementation',
        sources: [],
        artifacts: [],
      },
      {
        kind: 'criterion',
        unitId: 'root',
        stepNumber: 1,
        outcome: 'FINDING',
        evidence: 'F1 remains',
        sources: ['src/math.ts'],
        artifacts: [],
      },
    ],
  });
  const index = materializeReviewCoverage(dir);
  assert.equal(index.rows.length, 2);
  const report = fs.readFileSync(path.join(dir, 'artifacts/review.md'), 'utf8');
  assert.match(report, /F1 remains open/);
  assert.match(report, /\| `src\/math.ts` \| AC1/);
  assert.equal(index.reportSha256, sha256(report));
  assert.equal(
    index.ledgerSha256,
    sha256(fs.readFileSync(path.join(dir, 'artifacts/review-ledger.md'), 'utf8')),
  );
  assert.deepEqual(materializeReviewCoverage(dir), index);
  assert.equal(
    fs.readFileSync(path.join(dir, 'artifacts/acceptance-status.json'), 'utf8'),
    'ENGINE LEDGER IS NOT REVIEW COVERAGE',
  );
});

test('a new contribution path is composed with validated prior rows; changed source cannot reuse them', (t) => {
  const f = taskFixture(t);
  const cold = f.task('cold', f.head, ['src/math.ts']);
  f.result(cold, {
    schemaVersion: 1,
    reuse: [],
    rows: [
      {
        kind: 'scope',
        path: 'src/math.ts',
        scope: 'AC1',
        justification: 'Math',
        sources: [],
        artifacts: [],
      },
      {
        kind: 'criterion',
        unitId: 'root',
        stepNumber: 1,
        outcome: 'FINDING',
        evidence: 'F1',
        sources: ['src/math.ts'],
        artifacts: [],
      },
    ],
  });
  const prior = materializeReviewCoverage(cold);
  const bytes = fs.readFileSync(path.join(cold, 'artifacts/review-coverage.json'), 'utf8');
  fs.writeFileSync(path.join(f.repo, 'README.md'), '# Documentation\n');
  const next = f.commit();
  const baseline = {
    runId: 'cold',
    headSha: f.head,
    reportSha256: prior.reportSha256,
    indexSha256: sha256(bytes),
    evidenceHashes: {},
  };
  const warm = f.task('warm', next, ['src/math.ts', 'README.md'], baseline);
  fs.writeFileSync(path.join(warm, 'inputs/prior-review-coverage.json'), bytes);
  const update = {
    schemaVersion: 1,
    applicabilityChecked: true,
    reuse: prior.rows.map((r) => r.key),
    rows: [
      {
        kind: 'scope',
        path: 'README.md',
        scope: 'AC1',
        justification: 'Required docs',
        sources: [],
        artifacts: [],
      },
    ],
  };
  f.result(warm, update);
  const composed = materializeReviewCoverage(warm);
  assert.equal(composed.rows.length, 3);
  assert.equal(composed.rows.filter((r) => r.provenance.runId === 'cold').length, 2);
  fs.writeFileSync(path.join(f.repo, 'src/math.ts'), 'export const value = 2;\n');
  const changed = f.commit();
  const stale = f.task('stale', changed, ['src/math.ts', 'README.md'], baseline);
  fs.writeFileSync(path.join(stale, 'inputs/prior-review-coverage.json'), bytes);
  f.result(stale, update);
  assert.throws(() => materializeReviewCoverage(stale), /requires current evaluation/);
});

test('engine ledger evidence and escaping citation paths are refused', (t) => {
  const f = taskFixture(t);
  const dir = f.task('cold', f.head, ['src/math.ts']);
  const row = {
    kind: 'scope',
    path: 'src/math.ts',
    scope: 'AC1',
    justification: 'Math',
    sources: [],
    artifacts: ['artifacts/acceptance-status.json'],
  };
  f.result(dir, { schemaVersion: 1, reuse: [], rows: [row] });
  assert.throws(() => materializeReviewCoverage(dir), /never a managed or engine ledger/);
  row.artifacts = [];
  row.sources = ['../outside'];
  f.result(dir, { schemaVersion: 1, reuse: [], rows: [row] });
  assert.throws(() => materializeReviewCoverage(dir), /canonical relative path/);
});

test('a source edit or merge resolution invalidates affected rows, preserving unrelated gaps', () => {
  const f = fixture();
  const selected = reusableCoverageRows(f.index, {
    ...f.current,
    sourceHashes: { 'src/math.ts': '100644:resolved-blob' },
  });
  assert.deepEqual(
    selected.reusable.map((r) => r.value.outcome),
    ['NOT_CHECKED'],
  );
  assert.equal(selected.invalidated.length, 2);
  assert(selected.invalidated.every((r) => r.reason === 'source-changed-or-missing'));
});

test('changed or missing cited evidence forces evaluation even with unchanged source', () => {
  const f = fixture();
  for (const evidenceHashes of [
    {},
    { 'first:proof.json': 'different' },
    { 'first:proof.json': 'missing' },
  ]) {
    const selected = reusableCoverageRows(f.index, { ...f.current, evidenceHashes });
    assert.equal(selected.invalidated.length, 1);
    assert.equal(selected.invalidated[0].reason, 'evidence-changed-or-missing');
  }
});

test('authorization or rule changes invalidate the entire prior mapping', () => {
  const f = fixture();
  for (const key of ['authorizationHash', 'ruleHash']) {
    const selected = reusableCoverageRows(f.index, { ...f.current, [key]: 'changed' });
    assert.equal(selected.reusable.length, 0);
    assert.equal(selected.invalidated.length, 3);
  }
});

test('new paths and inserted/reordered rule identities need current rows', () => {
  const f = fixture();
  const extra = { kind: 'scope', path: 'src/new.ts' };
  const inputs = {
    ...f.current,
    definitions: [...f.definitions, extra],
    sourceHashes: { ...f.current.sourceHashes, 'src/new.ts': '100644:new' },
  };
  const update = {
    schemaVersion: 1,
    applicabilityChecked: true,
    reuse: f.index.rows.map((r) => r.key),
    rows: [],
  };
  assert.throws(() => composeCoverageRows(inputs, update, f.index), /Missing current.*src\/new.ts/);
  update.rows.push({
    key: coverageRowKey(extra),
    scope: 'AC1',
    justification: 'New required test',
    sources: [],
    artifacts: [],
  });
  assert.equal(composeCoverageRows(inputs, update, f.index).rows.length, 4);
  const changed = {
    ...f.current,
    definitions: f.definitions.map((d) =>
      d.kind === 'criterion' ? { ...d, ruleSourceSha256: 'inserted-step' } : d,
    ),
  };
  assert.equal(reusableCoverageRows(f.index, changed).reusable.length, 1);
  const relabeled = {
    ...f.current,
    definitions: f.definitions.map((d) =>
      d.kind === 'criterion' ? { ...d, label: 'Changed rendered rule' } : d,
    ),
  };
  assert.equal(reusableCoverageRows(f.index, relabeled).reusable.length, 1);
});

test('reuse requires an explicit current-delta applicability check and cannot hide missing rows', () => {
  const f = fixture();
  const update = { schemaVersion: 1, reuse: f.index.rows.map((r) => r.key), rows: [] };
  assert.throws(
    () => composeCoverageRows(f.current, update, f.index),
    /applicability confirmation/,
  );
  update.applicabilityChecked = true;
  update.reuse.pop();
  assert.throws(() => composeCoverageRows(f.current, update, f.index), /Missing current/);
  update.reuse.push('unverified');
  assert.throws(
    () => composeCoverageRows(f.current, update, f.index),
    /requires current evaluation/,
  );
});

test('composition retains findings and gaps without producing a current-head verdict', () => {
  const f = fixture();
  const index = composeCoverageRows(
    f.current,
    {
      schemaVersion: 1,
      applicabilityChecked: true,
      reuse: f.index.rows.map((r) => r.key),
      rows: [],
    },
    f.index,
  );
  assert.equal(index.headSha, 'new');
  assert.deepEqual(
    index.rows.slice(1).map((r) => r.value.outcome),
    ['FINDING', 'NOT_CHECKED'],
  );
  assert(!Object.hasOwn(index, 'verdict'));
  const { scope, ledger } = renderCoverage(index);
  assert.match(scope, /src\/math.ts.*AC1.*Reused from old/);
  assert.match(ledger, /F1: rounding is wrong/);
  assert.match(ledger, /NOT_CHECKED.*Runtime was not available/);
  assert.equal((ledger.match(/\| src\/math.ts/g) ?? []).length, 0);
});

test('missing source/evidence never becomes a PASS through a current update', () => {
  const f = fixture();
  const input = { ...f.current, sourceHashes: { 'src/math.ts': 'missing' } };
  const update = {
    schemaVersion: 1,
    reuse: [],
    rows: [
      {
        key: f.index.rows[0].key,
        scope: 'AC1',
        justification: 'Required',
        sources: [],
        artifacts: [],
      },
    ],
  };
  assert.throws(() => composeCoverageRows(input, update, f.index), /input is missing/);
});
