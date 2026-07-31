import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assignmentDiagnosticLines,
  assignments,
  buildArtifact,
  classifyTest,
  discoverTests,
  finish,
  parseArgs,
  partitionTests,
  resolveWorkers,
  SERIAL_PRAGMA,
  summaryLines,
  verifyAssignment,
  WORKERS_ENV,
} from './run-tsx-tests.mjs';

const RUNNER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'run-tsx-tests.mjs');

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

// The runner prints its aggregate failure list immediately before exiting. If it
// exits via process.exit(), Node tears down without flushing pending writes and
// pipe-backed stdout truncates at the pipe buffer — the exit status stays correct
// while the diagnostics a red build needs disappear. These two tests pin the
// drain-safe exit: one asserts the mechanism end-to-end over a pipe, the other
// stops process.exit() from creeping back into the module.
const LARGE_PAYLOAD_BYTES = 1_000_000;

function runDetached(source) {
  const dir = mkdtempSync(path.join(tmpdir(), 'farmslot-exit-drain-'));
  const script = path.join(dir, 'probe.mjs');
  writeFileSync(script, source);
  try {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      // Pipe-backed stdout is the condition that triggers the truncation;
      // an inherited TTY would hide it.
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout: result.stdout ?? '', status: result.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a failing run flushes its full output over a pipe before exiting', () => {
  const probe = `
    import { finish } from ${JSON.stringify(RUNNER_PATH)};
    process.stdout.write('x'.repeat(${LARGE_PAYLOAD_BYTES}));
    process.stdout.write('\\n[tsx-tests] failures:\\n[tsx-tests]   - src/last.test.ts exit=1\\n');
    finish(1);
  `;
  const { stdout, status } = runDetached(probe);

  assert.equal(status, 1, 'a failing run must still exit non-zero');
  assert.ok(
    stdout.length > LARGE_PAYLOAD_BYTES,
    `stdout truncated to ${stdout.length} of >${LARGE_PAYLOAD_BYTES} bytes — pending writes were dropped`,
  );
  assert.ok(
    stdout.endsWith('[tsx-tests]   - src/last.test.ts exit=1\n'),
    'the trailing failure list must survive; it is written last and is dropped first',
  );
});

test('the runner never calls process.exit()', () => {
  const source = readFileSync(RUNNER_PATH, 'utf8');
  const calls = source
    .split('\n')
    .filter((line) => /process\.exit\(/.test(line) && !line.trimStart().startsWith('*'));
  assert.deepEqual(
    calls,
    [],
    'use `process.exitCode` / finish() instead — process.exit() drops buffered stdout on a pipe',
  );
});

test('finish sets the exit status without ending the process', () => {
  const previous = process.exitCode;
  try {
    finish(1);
    assert.equal(process.exitCode, 1);
    finish(0);
    assert.equal(process.exitCode, 0);
  } finally {
    process.exitCode = previous;
  }
});

// Gateway runs at --workers 4, so any suite touching machine-wide or repo-wide
// state must carry the serial pragma. This inventory is the reviewed list; the
// test below fails both when a listed file loses its pragma and when a new file
// gains one without being reviewed into the list. Keep it sorted.
const GATEWAY_SERIAL_INVENTORY = [
  'src/agents/contexts.test.ts', //          writes fixtures into the repo pool/
  'src/agents/runtime-recovery.test.ts', //  real tmux sessions + repo pool/
  'src/live-recipe/context.test.ts', //      writes fixtures into the repo pool/
  'src/methods/filesystem.test.ts', //       writes fixtures into the repo pool/
  'src/tasks/writer.test.ts', //             fixed-name file in templates/worker/
];

test('the gateway serial lane matches its reviewed inventory', () => {
  const gatewaySrc = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../services/gateway/src',
  );
  const marked = discoverTests(['.'], gatewaySrc)
    .filter((file) => readFileSync(file, 'utf8').includes(SERIAL_PRAGMA))
    .map((file) => `src/${path.relative(gatewaySrc, file).split(path.sep).join('/')}`)
    .sort();
  assert.deepEqual(
    marked,
    GATEWAY_SERIAL_INVENTORY,
    'gateway serial pragmas drifted from the reviewed inventory — a suite that mutates shared ' +
      'state must be listed here and carry the pragma, or parallel lanes can corrupt it',
  );
});

test('assignment verification compares the discovered set, not a self-derived count', () => {
  const partition = partitionOf(FILES, 4);
  const healthy = verifyAssignment(FILES, partition);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.discoveredCount, 10);
  assert.equal(healthy.assignedUniqueCount, 10);
  assert.deepEqual([healthy.missing, healthy.duplicate, healthy.unexpected], [[], [], []]);
});

test('a partition that drops a file is rejected', () => {
  const partition = partitionOf(FILES, 4);
  partition.parallel[2].pop();
  const check = verifyAssignment(FILES, partition);
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, ['src/suite-6.test.ts']);
  assert.equal(check.assignedUniqueCount, 9);
  assert.equal(check.discoveredCount, 10, 'discovered must stay independent of the partition');
});

test('a partition that duplicates a file across lanes is rejected', () => {
  const partition = partitionOf(FILES, 4);
  partition.serial.push(partition.parallel[0][0]);
  const check = verifyAssignment(FILES, partition);
  assert.equal(check.ok, false);
  assert.deepEqual(check.duplicate, ['src/suite-0.test.ts']);
  assert.equal(check.assignedCount, 11, 'total assignments exceed the discovered set');
  assert.equal(check.assignedUniqueCount, 10);
});

test('a partition containing a file that was never discovered is rejected', () => {
  const partition = partitionOf(FILES, 4);
  partition.parallel[1].push('src/ghost.test.ts');
  const check = verifyAssignment(FILES, partition);
  assert.equal(check.ok, false);
  assert.deepEqual(check.unexpected, ['src/ghost.test.ts']);
});

test('the assignment diagnostic names every offending file', () => {
  const partition = partitionOf(FILES, 4);
  partition.parallel[2].pop();
  partition.serial.push(partition.parallel[0][0]);
  const lines = assignmentDiagnosticLines(verifyAssignment(FILES, partition));
  assert.equal(
    lines[0],
    '[tsx-tests] assignment check FAILED discovered=10 assigned=10 assigned_unique=9' +
      ' missing=1 duplicate=1 unexpected=0',
  );
  assert.ok(lines.includes('[tsx-tests]   missing: src/suite-6.test.ts'));
  assert.ok(lines.includes('[tsx-tests]   duplicate: src/suite-0.test.ts'));
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

const REPORT_FILES = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];

function report(overrides = {}) {
  const partition = partitionOf(REPORT_FILES, 2);
  const records = [
    { file: 'src/a.test.ts', label: 'src/a.test.ts', ms: 4000, status: 0 },
    { file: 'src/c.test.ts', label: 'src/c.test.ts', ms: 500, status: 0 },
    { file: 'src/b.test.ts', label: 'src/b.test.ts', ms: 1200, status: 1 },
  ];
  return {
    workspace: 'gateway',
    workers: 2,
    discovered: REPORT_FILES,
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
  assert.deepEqual(artifact.assignment, {
    ok: true,
    assignedTotal: 3,
    missing: [],
    duplicate: [],
    unexpected: [],
  });
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

test('a lost file surfaces in the artifact instead of a silent discovered===assigned', () => {
  const partition = partitionOf(REPORT_FILES, 2);
  partition.parallel[1].pop();
  const artifact = buildArtifact(report({ partition }));
  assert.equal(artifact.discoveredCount, 3);
  assert.equal(artifact.assignedCount, 2);
  assert.equal(artifact.assignment.ok, false);
  assert.deepEqual(artifact.assignment.missing, ['src/b.test.ts']);
  assert.ok(
    summaryLines(report({ partition }))[0].includes('discovered=3 assigned=2'),
    'the summary must show the mismatch rather than two equal derived counts',
  );
});

test('module-mock files share the batch verdict and carry no per-file duration', () => {
  const files = ['src/m1.test.ts', 'src/m2.test.ts'];
  const partition = partitionTests(files, {
    workers: 2,
    classify: () => 'module-mock',
  });
  const artifact = buildArtifact({
    workspace: 'gateway',
    workers: 2,
    discovered: files,
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
