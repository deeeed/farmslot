import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assignments,
  buildArtifact,
  classifyTest,
  discoverTests,
  parseArgs,
  partitionTests,
  resolveWorkers,
  SERIAL_PRAGMA,
  summaryLines,
  WORKERS_ENV,
} from './run-tsx-tests.mjs';

const FILES = Array.from({ length: 10 }, (_, index) => `src/suite-${index}.test.ts`);

function partitionOf(files, workers, laneFor = () => 'parallel') {
  return partitionTests(files, { workers, classify: laneFor });
}

test('parseArgs separates flags from test roots', () => {
  assert.deepEqual(
    parseArgs(['--cwd', '.', '--tsconfig', 'tsconfig.json', '--workers', '4', 'src', 'other']),
    { roots: ['src', 'other'], cwd: '.', tsconfig: 'tsconfig.json', nodeTest: false, workers: '4' },
  );
  assert.deepEqual(parseArgs(['--node-test', 'src']), {
    roots: ['src'],
    cwd: undefined,
    tsconfig: undefined,
    nodeTest: true,
    workers: undefined,
  });
});

test('worker count defaults to serial and rejects invalid values', () => {
  assert.equal(resolveWorkers(undefined, {}), 1);
  assert.equal(resolveWorkers('', {}), 1);
  assert.equal(resolveWorkers('4', {}), 4);
  assert.equal(resolveWorkers(undefined, { [WORKERS_ENV]: '3' }), 3);
  assert.equal(resolveWorkers('2', { [WORKERS_ENV]: '8' }), 2, 'the explicit flag wins over env');
  for (const bad of ['0', '-1', '2.5', 'many']) {
    assert.throws(
      () => resolveWorkers(bad, {}),
      /positive integer/,
      `expected ${bad} to be rejected`,
    );
  }
});

test('classification keys off module mocks and the serial pragma', () => {
  assert.equal(classifyTest('const x = 1;'), 'parallel');
  assert.equal(
    classifyTest("import { mock } from 'node:test';\nmock.module('./a.js', {});"),
    'module-mock',
  );
  assert.equal(classifyTest(`// ${SERIAL_PRAGMA} — drives tmux\nconst x = 1;`), 'serial');
  assert.equal(
    classifyTest(`// ${SERIAL_PRAGMA}\nmock.module('./a.js', {});`),
    'module-mock',
    'module mocks need the batched runner even when also marked serial',
  );
});

test('every discovered file is assigned exactly once', () => {
  for (const workers of [1, 2, 3, 4, 16]) {
    const partition = partitionOf(FILES, workers, (file) =>
      file.endsWith('3.test.ts')
        ? 'serial'
        : file.endsWith('7.test.ts')
          ? 'module-mock'
          : 'parallel',
    );
    const assigned = assignments(partition).map((entry) => entry.file);
    assert.equal(assigned.length, FILES.length, `workers=${workers} lost or duplicated files`);
    assert.deepEqual(new Set(assigned).size, FILES.length, `workers=${workers} duplicated a file`);
    assert.deepEqual([...assigned].sort(), [...FILES].sort(), `workers=${workers} changed the set`);
  }
});

test('partitioning is deterministic for the same inputs', () => {
  assert.deepEqual(partitionOf(FILES, 4), partitionOf(FILES, 4));
  assert.deepEqual(partitionOf(FILES, 4).parallel, [
    ['src/suite-0.test.ts', 'src/suite-4.test.ts', 'src/suite-8.test.ts'],
    ['src/suite-1.test.ts', 'src/suite-5.test.ts', 'src/suite-9.test.ts'],
    ['src/suite-2.test.ts', 'src/suite-6.test.ts'],
    ['src/suite-3.test.ts', 'src/suite-7.test.ts'],
  ]);
});

test('unsafe shared-fixture suites stay off the parallel lanes', () => {
  const partition = partitionOf(FILES, 4, (file) =>
    file === 'src/suite-2.test.ts' || file === 'src/suite-5.test.ts' ? 'serial' : 'parallel',
  );
  assert.deepEqual(partition.serial, ['src/suite-2.test.ts', 'src/suite-5.test.ts']);
  for (const lane of partition.parallel) {
    assert.ok(!lane.includes('src/suite-2.test.ts'));
    assert.ok(!lane.includes('src/suite-5.test.ts'));
  }
  assert.deepEqual(
    assignments(partition)
      .filter((entry) => entry.lane === 'serial')
      .map((entry) => entry.worker),
    [null, null],
    'serial files are not bound to a worker lane',
  );
});

test('--node-test routes every file through the batched runner', () => {
  const partition = partitionTests(FILES, {
    workers: 4,
    nodeTest: true,
    classify: () => {
      throw new Error('classify must not be consulted in --node-test mode');
    },
  });
  assert.deepEqual(partition.moduleMock, FILES);
  assert.deepEqual(partition.serial, []);
  assert.deepEqual(partition.parallel.flat(), []);
});

test('a single worker keeps everything on one lane', () => {
  const partition = partitionOf(FILES, 1);
  assert.equal(partition.parallel.length, 1);
  assert.deepEqual(partition.parallel[0], FILES);
});

test('discovery finds .test.ts files recursively and skips build output', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-tsx-discovery-'));
  try {
    mkdirSync(path.join(root, 'src/nested'), { recursive: true });
    mkdirSync(path.join(root, 'src/node_modules'), { recursive: true });
    mkdirSync(path.join(root, 'src/dist'), { recursive: true });
    writeFileSync(path.join(root, 'src/a.test.ts'), '');
    writeFileSync(path.join(root, 'src/a.ts'), '');
    writeFileSync(path.join(root, 'src/nested/b.test.ts'), '');
    writeFileSync(path.join(root, 'src/node_modules/c.test.ts'), '');
    writeFileSync(path.join(root, 'src/dist/d.test.ts'), '');

    const found = discoverTests(['src'], root).map((file) => path.relative(root, file));
    assert.deepEqual(found, ['src/a.test.ts', 'src/nested/b.test.ts']);

    const deduped = discoverTests(['src', 'src/a.test.ts'], root);
    assert.equal(deduped.length, 2, 'overlapping roots must not double-assign a file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function report(overrides = {}) {
  const partition = partitionOf(['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'], 2);
  const records = [
    { file: 'src/a.test.ts', label: 'src/a.test.ts', ms: 4000, status: 0 },
    { file: 'src/c.test.ts', label: 'src/c.test.ts', ms: 500, status: 0 },
    { file: 'src/b.test.ts', label: 'src/b.test.ts', ms: 1200, status: 1 },
  ];
  return {
    workspace: 'gateway',
    workers: 2,
    partition,
    records,
    failures: records.filter((record) => record.status !== 0),
    totalMs: 5700,
    toLabel: (file) => file,
    ...overrides,
  };
}

test('the summary reports the worker contract, complete assignment, and totals', () => {
  const lines = summaryLines(report());
  assert.equal(
    lines[0],
    '\n[tsx-tests] summary workspace="gateway" workers=2 discovered=3 assigned=3' +
      ' module_mock=0 serial=0 parallel=3 failed=1 total_ms=5700 total=5.7s',
  );
  assert.ok(lines.includes('[tsx-tests]   1. src/a.test.ts ms=4000 (4.0s)'));
});

test('failures are aggregated rather than reported one at a time', () => {
  const failing = report();
  failing.records[1].status = 2;
  failing.failures = failing.records.filter((record) => record.status !== 0);

  const lines = summaryLines(failing);
  assert.ok(lines[0].includes('failed=2'));
  assert.deepEqual(lines.slice(lines.indexOf('[tsx-tests] failures:') + 1), [
    '[tsx-tests]   - src/c.test.ts exit=2',
    '[tsx-tests]   - src/b.test.ts exit=1',
  ]);
});

test('the artifact records the worker contract and every assigned file exactly once', () => {
  const artifact = buildArtifact(report());
  assert.equal(artifact.kind, 'tsx-tests');
  assert.equal(artifact.workspace, 'gateway');
  assert.equal(artifact.workers, 2);
  assert.equal(artifact.discoveredCount, 3);
  assert.equal(artifact.assignedCount, 3);
  assert.equal(artifact.status, 'fail');
  assert.deepEqual(artifact.files.map((entry) => entry.file).sort(), [
    'src/a.test.ts',
    'src/b.test.ts',
    'src/c.test.ts',
  ]);
  assert.equal(new Set(artifact.files.map((entry) => entry.file)).size, 3);
  assert.deepEqual(
    artifact.files.find((entry) => entry.file === 'src/b.test.ts'),
    {
      file: 'src/b.test.ts',
      lane: 'parallel',
      worker: 1,
      ms: 1200,
      status: 'fail',
    },
  );
  assert.deepEqual(artifact.failures, [{ label: 'src/b.test.ts', status: 1 }]);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(artifact)));
});

test('module-mock files share the batch verdict and carry no per-file duration', () => {
  const partition = partitionTests(['src/m1.test.ts', 'src/m2.test.ts'], {
    workers: 2,
    classify: () => 'module-mock',
  });
  const artifact = buildArtifact({
    workspace: 'gateway',
    workers: 2,
    partition,
    records: [{ batch: true, label: 'module-mock batch (2 files)', ms: 900, status: 1 }],
    failures: [{ label: 'module-mock batch (2 files)', status: 1 }],
    totalMs: 900,
    toLabel: (file) => file,
  });
  assert.deepEqual(
    artifact.files.map((entry) => [entry.file, entry.lane, entry.ms, entry.status]),
    [
      ['src/m1.test.ts', 'module-mock', null, 'fail'],
      ['src/m2.test.ts', 'module-mock', null, 'fail'],
    ],
  );
});
