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
  testCommand,
  verifyAssignment,
  WORKERS_ENV,
} from './run-tsx-tests.mjs';

const QUALITY_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(QUALITY_DIR, 'run-tsx-tests.mjs');
const REPO_ROOT = path.resolve(QUALITY_DIR, '..', '..');
// Every entrypoint that prints a timing summary and then exits shares the same
// truncation hazard, so the guard covers all of them, not just this runner.
const DRAIN_SAFE_ENTRYPOINTS = [
  'run-tsx-tests.mjs',
  'run-quality.mjs',
  'run-workspace-quality.mjs',
  'lib/step-timing.mjs',
];

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

test('every value-taking flag rejects a missing or flag-like value', () => {
  // resolveWorkers(undefined) is indistinguishable from an omitted flag, so a bare
  // trailing --workers used to drop the run to serial while the operator believed
  // they had asked for parallelism — a silent breach of the AC5 worker contract.
  assert.throws(() => parseArgs(['src', '--workers']), /--workers requires a value/);
  assert.throws(
    () => parseArgs(['--workers', '--node-test', 'src']),
    /followed by the flag --node-test/,
    'a following flag must not be swallowed as the worker count',
  );
  // Same failure class on the other two value-taking flags: `--cwd --tsconfig x`
  // used to set cwd to the literal '--tsconfig', and a bare trailing --tsconfig
  // silently dropped the tsconfig.
  assert.throws(
    () => parseArgs(['--cwd', '--tsconfig', 'x', 'src']),
    /--cwd requires a value but was followed by the flag --tsconfig/,
  );
  assert.throws(() => parseArgs(['src', '--cwd']), /--cwd requires a value but none was given/);
  assert.throws(
    () => parseArgs(['src', '--tsconfig']),
    /--tsconfig requires a value but none was given/,
  );

  // The valid form is unaffected.
  assert.deepEqual(
    parseArgs(['--cwd', '.', '--tsconfig', 'tsconfig.json', '--workers', '4', 'src']),
    {
      roots: ['src'],
      cwd: '.',
      tsconfig: 'tsconfig.json',
      nodeTest: false,
      workers: '4',
    },
  );
});

test('the CLI surfaces a missing --workers value rather than running serial', () => {
  const result = spawnSync(
    process.execPath,
    [RUNNER_PATH, '--cwd', REPO_ROOT, 'src', '--workers'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.notEqual(result.status, 0, `expected a non-zero exit\n${out}`);
  assert.match(out, /--workers requires a value/);
  assert.ok(
    !/\[tsx-tests\] summary/.test(out),
    'the run must abort before executing anything, not report a serial summary',
  );
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
    'module mocks need the module-mock lane even when also marked serial',
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

test('no quality entrypoint calls process.exit()', () => {
  const offenders = [];
  for (const entry of DRAIN_SAFE_ENTRYPOINTS) {
    const source = readFileSync(path.resolve(QUALITY_DIR, entry), 'utf8');
    for (const line of source.split('\n')) {
      if (!/process\.exit\(/.test(line)) continue;
      if (line.trimStart().startsWith('*')) continue; // doc comment
      offenders.push(`${entry}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'use `process.exitCode` / finish() instead — process.exit() drops buffered stdout on a pipe',
  );
});

// The shared finish() in lib/step-timing.mjs is the one mechanism all three
// entrypoints exit through, so proving drainage once here plus the source guard
// above (every entrypoint uses it, none calls process.exit) covers all of them.
// Probing each entrypoint directly would mean re-exporting finish from modules
// that have no other reason to expose it.
test('the shared finish() flushes a large summary over a pipe', () => {
  const probe = `
    import { finish } from ${JSON.stringify(path.resolve(QUALITY_DIR, 'lib/step-timing.mjs'))};
    process.stdout.write('x'.repeat(${LARGE_PAYLOAD_BYTES}));
    process.stdout.write('\\n[quality] failed step="last" status=1\\n');
    finish(1);
  `;
  const { stdout, status } = runDetached(probe);
  assert.equal(status, 1, 'a failing run must still exit non-zero');
  assert.ok(
    stdout.length > LARGE_PAYLOAD_BYTES,
    `stdout truncated to ${stdout.length} bytes — pending writes were dropped`,
  );
  assert.ok(
    stdout.endsWith('[quality] failed step="last" status=1\n'),
    'the trailing failure line must survive; it is written last and is dropped first',
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
  'src/agents/contexts.test.ts', //                   writes fixtures into the repo pool/
  'src/agents/runtime-recovery.test.ts', //           real tmux sessions + repo pool/
  'src/ci-monitor/inline-fix.test.ts', //             real template dirs under repo projects/
  'src/core/state.test.ts', //                        rewrites the root .farm-status.json
  'src/live-recipe/context.test.ts', //               writes fixtures into the repo pool/
  'src/methods/config.test.ts', //                    real dirs under repo projects/
  'src/methods/filesystem.test.ts', //                writes fixtures into the repo pool/
  'src/methods/run/replay-step.test.ts', //           rewrites the root .farm-status.json
  'src/methods/slot/release.test.ts', //              rewrites the root .farm-status.json
  'src/methods/terminal-attachment-target.test.ts', // writes fixtures into the repo pool/
  'src/roadmap/store.test.ts', //                     real dirs under repo projects/
  'src/run-completion/artifact-mirror.test.ts', //    real JSON under repo pool/
  'src/run-engine/publish-package-refresh.test.ts', // real JSON under repo pool/
  'src/tasks/writer.test.ts', //                      fixed-name file in templates/worker/
];

// Discovery, not just a lock. The inventory above only catches a *lost* pragma;
// four review rounds running found suites that were never listed because a
// matcher was too narrow — poolDir reached via a re-export, statusFile via an
// imported symbol, then a dynamic import, then a pool path built with
// path.join(farmslotRoot, 'pool', …) that no identifier match could see.
//
// So match the shared *location*, however the path is spelled: the named
// accessors, the status file, and any join rooted at farmslotRoot into a shared
// repo subtree. A test reaching those must carry the pragma or be listed below
// with the reason it is safe.
const SHARED_STATE_PATTERNS = [
  /\bstatusFile\b/, //                                    core/state.js accessor
  /\bpoolDir\b/, //                                       core/config.js accessor
  /\bprojectsDir\b/, //                                   core/config.js accessor
  /\.farm-status/, //                                      the status file by name
  /farmslotRoot\s*,\s*['"`](pool|projects|templates)\b/, // path.join(farmslotRoot, 'pool', …)
];

export function reachesSharedState(source) {
  return SHARED_STATE_PATTERNS.some((pattern) => pattern.test(source));
}

// Justified exceptions. A suite lands here only when it cannot collide with a
// parallel lane; "it happens to pass today" is not a reason. Note the asymmetry
// with the serial inventory: mkdtemp names are unique per call, so two lanes
// cannot target the same path — but a FIXED-name write through any of the
// accessors above must be serial, which is why the guard matches the accessor
// rather than the write.
const SHARED_STATE_READ_ONLY = {
  'src/projects/repo-root.test.ts': 'asserts resolved paths only; never writes',
  'src/runtime/session-usage-script.test.ts': 'declares its own temp poolDir under a mkdtemp root',
  'src/methods/run.test.ts':
    'writes under the real projectsDir but only via mkdtempSync, so every fixture path is unique ' +
    'per call and cannot collide with another lane; it must move to the serial lane if it ever ' +
    'writes a fixed name there',
};

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

test('the shared-state matcher sees pool paths built from farmslotRoot', () => {
  // Regression for rev7: both omitted suites built the pool path this way, and an
  // identifier-only matcher (statusFile|poolDir) scored them clean.
  const viaFarmslotRoot = "const poolFile = path.join(farmslotRoot, 'pool', `${testId}.json`);";
  assert.equal(reachesSharedState(viaFarmslotRoot), true, 'missed path.join(farmslotRoot, "pool")');
  assert.equal(
    reachesSharedState(
      "await rm(path.join(farmslotRoot, 'projects', project), { recursive: true }));",
    ),
    true,
    'missed a shared repo projects/ path',
  );
  assert.equal(
    reachesSharedState("const workerDir = path.join(farmslotRoot, 'templates', 'worker');"),
    true,
    'missed a shared repo templates/ path',
  );

  // The earlier identifier and literal shapes must keep matching.
  assert.equal(reachesSharedState("import { poolDir } from '../core/config.js';"), true);
  assert.equal(
    reachesSharedState("const { statusFile } = await import('../../core/state.js');"),
    true,
  );
  assert.equal(reachesSharedState("await readFile('.farm-status.json');"), true);

  // A temp-dir pool must NOT trip the guard, or every fixture becomes serial.
  assert.equal(
    reachesSharedState("const dir = path.join(tmpdir(), 'pool');"),
    false,
    'temp-dir pools are isolated and must stay on parallel lanes',
  );
  assert.equal(reachesSharedState('const x = 1;'), false);
});

test('every gateway suite that can reach shared state is serial or justified', () => {
  const gatewaySrc = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../services/gateway/src',
  );
  const unguarded = [];
  for (const file of discoverTests(['.'], gatewaySrc)) {
    const source = readFileSync(file, 'utf8');
    if (!reachesSharedState(source)) continue;
    const rel = `src/${path.relative(gatewaySrc, file).split(path.sep).join('/')}`;
    if (source.includes(SERIAL_PRAGMA)) continue;
    if (rel in SHARED_STATE_READ_ONLY) continue;
    unguarded.push(rel);
  }
  assert.deepEqual(
    unguarded,
    [],
    'these gateway suites touch the shared .farm-status.json or repo pool/ but run on parallel ' +
      'lanes — add the @farmslot:serial pragma, or record why they are read-only in ' +
      'SHARED_STATE_READ_ONLY',
  );
});

test('the shared-state read-only allowlist stays honest', () => {
  const gatewaySrc = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../services/gateway/src',
  );
  for (const [rel, reason] of Object.entries(SHARED_STATE_READ_ONLY)) {
    const source = readFileSync(path.join(gatewaySrc, rel.replace(/^src\//, '')), 'utf8');
    assert.ok(
      reachesSharedState(source),
      `${rel} no longer touches shared state — drop it from the allowlist`,
    );
    assert.ok(reason.length > 0, `${rel} needs a reason`);
  }
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

test('--node-test routes every file through the module-mock lane', () => {
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

// The summary-rendering test above builds finished records by hand, so it stays
// green even if the runner stopped at the first failing file. This one drives the
// real runner end to end: two failing files with a passing file sorted AFTER them,
// so a fail-fast runner could not produce the passing file's marker or the second
// failure. Deliberately slower than the rest of this suite — it spawns real
// `yarn exec tsx` processes — because that is the only way to prove the execution
// contract rather than the reporting of it.
// The module-mock lane used to batch every file into one
// `node --import tsx --experimental-test-module-mocks --test <files...>` process.
// Those files call test() at top level, so under --test node reported
// "run() is being called recursively within a test file. skipping running files.",
// executed nothing, and exited 0 — seven suites reported green for months while
// three of them could not even be imported. These tests pin the command shape and
// prove a skipped file cannot present as green.
test('module-mock files run one per process and never under --test', () => {
  const cmd = testCommand('/repo/src/a.test.ts', { cwd: '/repo', moduleMock: true });
  assert.deepEqual(cmd, [
    'exec',
    'node',
    '--import',
    'tsx',
    '--experimental-test-module-mocks',
    'src/a.test.ts',
  ]);
  assert.ok(!cmd.includes('--test'), '--test makes node skip the file and still exit 0');
  assert.equal(
    cmd.filter((part) => part.endsWith('.test.ts')).length,
    1,
    'exactly one file per process — a shared process is what allowed the silent skip',
  );

  // The non-mock shape is unchanged.
  assert.deepEqual(
    testCommand('/repo/src/b.test.ts', { cwd: '/repo', tsconfig: 'tsconfig.json' }),
    ['exec', 'tsx', '--tsconfig', 'tsconfig.json', 'src/b.test.ts'],
  );
});

test('a module-mock file that fails cannot present as green', () => {
  const fixtureDir = path.join(REPO_ROOT, 'temp', `tsx-runner-mm-${process.pid}`);
  mkdirSync(fixtureDir, { recursive: true });
  // Uses mock.module, so the runner classifies it into the module-mock lane, and
  // calls test() at top level — exactly the shape that --test skipped.
  writeFileSync(
    path.join(fixtureDir, 'mm-fails.test.ts'),
    [
      "import { mock, test } from 'node:test';",
      "mock.module('node:os', { namedExports: { hostname: () => 'fixture-host' } });",
      "test('deliberately failing module-mock suite', () => {",
      "  throw new Error('MM-FIXTURE-EXECUTED');",
      '});',
    ].join('\n') + '\n',
  );

  try {
    const result = spawnSync(
      process.execPath,
      [RUNNER_PATH, '--cwd', REPO_ROOT, path.relative(REPO_ROOT, fixtureDir)],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 },
    );
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    assert.match(out, /module_mock=1/, `the fixture must land in the module-mock lane\n${out}`);
    assert.notEqual(result.status, 0, `a failing module-mock file must fail the run\n${out}`);
    assert.ok(
      out.includes('MM-FIXTURE-EXECUTED'),
      `the file must actually execute, not be skipped\n${out}`,
    );
    assert.ok(
      !/skipping running files/.test(out),
      `node must not report the recursive-run skip\n${out}`,
    );
    assert.match(out, /failed=1/, `the failure must be counted\n${out}`);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('a failing run executes every file and aggregates all failures', () => {
  // temp/ is gitignored and inside the repo, so `yarn exec tsx` still resolves
  // the workspace. Cleanup removes only this uniquely named subdirectory.
  const fixtureDir = path.join(REPO_ROOT, 'temp', `tsx-runner-e2e-${process.pid}`);
  mkdirSync(fixtureDir, { recursive: true });
  const write = (name, body) => writeFileSync(path.join(fixtureDir, name), body);
  write('a-fails.test.ts', "console.log('E2E-MARKER-A');\nprocess.exit(1);\n");
  write('b-fails.test.ts', "console.log('E2E-MARKER-B');\nprocess.exit(1);\n");
  write('c-passes.test.ts', "console.log('E2E-MARKER-C');\n");

  try {
    const result = spawnSync(
      process.execPath,
      [RUNNER_PATH, '--cwd', REPO_ROOT, '--workers', '1', path.relative(REPO_ROOT, fixtureDir)],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 },
    );
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    assert.notEqual(result.status, 0, `a run with failing files must exit non-zero\n${out}`);

    // Execution contract: every file ran, including the one after both failures.
    for (const marker of ['E2E-MARKER-A', 'E2E-MARKER-B', 'E2E-MARKER-C']) {
      assert.ok(out.includes(marker), `${marker} missing — the runner stopped early\n${out}`);
    }

    // Aggregation contract: both failures reported, not just the first.
    assert.ok(
      /\[tsx-tests\] summary .*discovered=3 assigned=3 .*failed=2/.test(out),
      `summary should report 3 files and 2 failures\n${out}`,
    );
    assert.ok(out.includes('a-fails.test.ts exit=1'), `first failure not listed\n${out}`);
    assert.ok(out.includes('b-fails.test.ts exit=1'), `second failure not listed\n${out}`);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
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

test('module-mock files carry their own duration and verdict', () => {
  // Previously these files shared one batch process, so the artifact recorded a
  // single verdict and no per-file timing. One process per file means each has its
  // own record — and a file with no record is a genuine skip, not a reporting gap.
  const files = ['src/m1.test.ts', 'src/m2.test.ts'];
  const partition = partitionTests(files, { workers: 2, classify: () => 'module-mock' });
  const artifact = buildArtifact({
    workspace: 'gateway',
    workers: 2,
    discovered: files,
    partition,
    records: [
      { file: 'src/m1.test.ts', label: 'src/m1.test.ts', ms: 900, status: 0 },
      { file: 'src/m2.test.ts', label: 'src/m2.test.ts', ms: 400, status: 1 },
    ],
    failures: [{ label: 'src/m2.test.ts', status: 1 }],
    totalMs: 1300,
    toLabel: (file) => file,
  });
  assert.deepEqual(
    artifact.files.map((entry) => [entry.file, entry.lane, entry.ms, entry.status]),
    [
      ['src/m1.test.ts', 'module-mock', 900, 'ok'],
      ['src/m2.test.ts', 'module-mock', 400, 'fail'],
    ],
  );
});
