#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

import {
  finish,
  formatDuration,
  isMainModule,
  normalizeTimingsDir,
  rankSlowest,
  writeTimingArtifact,
} from './lib/step-timing.mjs';

export { finish };

/**
 * Opt-in marker for suites that mutate machine-wide or repo-wide state (tmux
 * sessions, the shared `pool/` directory, fixed ports). Marked files run one at
 * a time, never overlapping each other or the parallel lanes.
 */
export const SERIAL_PRAGMA = '@farmslot:serial';

export const WORKERS_ENV = 'FARMSLOT_TSX_TEST_WORKERS';

// Git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (etc.) into hook
// environments (pre-commit, pre-push). A test that spawns `git` to build a
// temp-dir fixture inherits these and — despite setting its own `cwd` — operates
// on the REAL repo: bogus `init` commits land on the checked-out branch and
// `git init --bare` flips `core.bare`. Strip the location vars so fixture git
// commands stay confined to their own working directory. No-op outside hooks.
const GIT_LOCATION_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

/**
 * Read the value that must follow `flag`.
 *
 * A bare trailing `--workers` used to yield `undefined`, which `resolveWorkers`
 * treats exactly like an omitted flag — so the run silently dropped to serial
 * while the operator believed they had asked for parallelism. A following flag
 * token (`--workers --node-test`) was worse: it was swallowed as the value and
 * the real flag disappeared. Both are now hard errors.
 */
function requireFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${flag} requires a value but none was given`);
  if (value.startsWith('--')) {
    throw new Error(`${flag} requires a value but was followed by the flag ${value}`);
  }
  return value;
}

export function parseArgs(argv) {
  const roots = [];
  let cwd;
  let tsconfig;
  let nodeTest = false;
  let workers;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--cwd') {
      cwd = requireFlagValue(argv, index, '--cwd');
      index += 1;
      continue;
    }
    if (arg === '--tsconfig') {
      tsconfig = requireFlagValue(argv, index, '--tsconfig');
      index += 1;
      continue;
    }
    if (arg === '--workers') {
      workers = requireFlagValue(argv, index, '--workers');
      index += 1;
      continue;
    }
    if (arg === '--node-test') {
      nodeTest = true;
      continue;
    }
    roots.push(arg);
  }

  return { roots, cwd, tsconfig, nodeTest, workers };
}

export function resolveWorkers(rawValue, env = process.env) {
  const source = rawValue ?? env[WORKERS_ENV];
  if (source == null || source === '') return 1;
  const parsed = Number(source);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Worker count must be a positive integer, received: ${source}`);
  }
  return parsed;
}

export function collectTests(root, cwd) {
  const absolute = resolve(cwd, root);
  const stat = statSync(absolute);
  if (stat.isFile()) return absolute.endsWith('.test.ts') ? [absolute] : [];
  const tests = [];
  for (const entry of readdirSync(absolute)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === '.turbo')
      continue;
    tests.push(...collectTests(resolve(absolute, entry), cwd));
  }
  return tests;
}

export function discoverTests(roots, cwd) {
  return [...new Set(roots.flatMap((root) => collectTests(root, cwd)))].sort();
}

export function classifyTest(source) {
  if (source.includes('mock.module(')) return 'module-mock';
  if (source.includes(SERIAL_PRAGMA)) return 'serial';
  return 'parallel';
}

/**
 * Deterministic partition of the discovered test files.
 *
 * Contract: every discovered file lands in exactly one lane, and every parallel
 * file lands in exactly one worker bucket. Assignment is round-robin over the
 * sorted file list, so the same input always yields the same plan.
 */
export function partitionTests(tests, { workers = 1, classify, nodeTest = false } = {}) {
  const moduleMock = [];
  const serial = [];
  const parallelFiles = [];

  for (const test of tests) {
    if (nodeTest) {
      moduleMock.push(test);
      continue;
    }
    const lane = classify(test);
    if (lane === 'module-mock') moduleMock.push(test);
    else if (lane === 'serial') serial.push(test);
    else parallelFiles.push(test);
  }

  const laneCount = Math.max(1, workers);
  const parallel = Array.from({ length: laneCount }, () => []);
  parallelFiles.forEach((file, index) => {
    parallel[index % laneCount].push(file);
  });

  return { moduleMock, serial, parallel };
}

/** Flat {file, lane, worker} view used for reporting and assignment checks. */
export function assignments(partition) {
  const entries = [
    ...partition.moduleMock.map((file) => ({ file, lane: 'module-mock', worker: null })),
    ...partition.serial.map((file) => ({ file, lane: 'serial', worker: null })),
    ...partition.parallel.flatMap((lane, worker) =>
      lane.map((file) => ({ file, lane: 'parallel', worker })),
    ),
  ];
  return entries;
}

/**
 * Compare the independently discovered file set against what the partition
 * actually assigned.
 *
 * Both sides must come from different sources for this to mean anything: pass
 * the `discovered` list straight from discovery, never a value derived from the
 * partition. Otherwise the check is tautological and a partition that drops or
 * duplicates a file still reports discovered === assigned.
 */
export function verifyAssignment(discovered, partition) {
  const assigned = assignments(partition).map((entry) => entry.file);
  const discoveredSet = new Set(discovered);
  const seen = new Set();
  const duplicate = [];
  const unexpected = [];
  for (const file of assigned) {
    if (seen.has(file)) duplicate.push(file);
    else {
      seen.add(file);
      if (!discoveredSet.has(file)) unexpected.push(file);
    }
  }
  const missing = discovered.filter((file) => !seen.has(file));
  return {
    discoveredCount: discovered.length,
    assignedCount: assigned.length,
    assignedUniqueCount: seen.size,
    missing: [...missing].sort(),
    duplicate: [...new Set(duplicate)].sort(),
    unexpected: [...new Set(unexpected)].sort(),
    ok: missing.length === 0 && duplicate.length === 0 && unexpected.length === 0,
  };
}

/** Machine-readable diagnostic emitted when the assignment check fails. */
export function assignmentDiagnosticLines(check, toLabel = (file) => file) {
  const lines = [
    `[tsx-tests] assignment check FAILED discovered=${check.discoveredCount}` +
      ` assigned=${check.assignedCount} assigned_unique=${check.assignedUniqueCount}` +
      ` missing=${check.missing.length} duplicate=${check.duplicate.length}` +
      ` unexpected=${check.unexpected.length}`,
  ];
  for (const [label, files] of [
    ['missing', check.missing],
    ['duplicate', check.duplicate],
    ['unexpected', check.unexpected],
  ]) {
    for (const file of files) lines.push(`[tsx-tests]   ${label}: ${toLabel(file)}`);
  }
  return lines;
}

function childEnvironment() {
  const env = { ...process.env, NODE_TEST_CONTEXT: '1' };
  for (const key of GIT_LOCATION_ENV) delete env[key];
  return env;
}

function runYarn(args, { cwd, env, buffered }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('yarn', args, {
      cwd,
      env,
      shell: false,
      stdio: buffered ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let output = '';
    if (buffered) {
      child.stdout.setEncoding('utf-8');
      child.stderr.setEncoding('utf-8');
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
    }
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ status: code ?? 1, output }));
  });
}

/**
 * Command for one test file.
 *
 * Module-mock files need `--experimental-test-module-mocks`, which `tsx` does
 * not forward, so they run through `node --import tsx` instead.
 *
 * They must NOT run under `--test`. These files call `test()` at the top level;
 * under the node test runner that becomes a recursive `run()`, and node responds
 * with "node:test run() is being called recursively within a test file. skipping
 * running files." — printing a warning, executing nothing, and exiting 0. Batched
 * that way, all seven module-mock suites reported green for months while three of
 * them could not even be imported. Executing the file directly is what makes its
 * assertions and its import errors real.
 */
export function testCommand(file, { cwd, tsconfig, moduleMock = false }) {
  const relativeFile = relative(cwd, file);
  if (moduleMock) {
    return ['exec', 'node', '--import', 'tsx', '--experimental-test-module-mocks', relativeFile];
  }
  const command = ['exec', 'tsx'];
  if (tsconfig) command.push('--tsconfig', tsconfig);
  command.push(relativeFile);
  return command;
}

async function runOne(file, context) {
  const started = performance.now();
  const { status, output } = await runYarn(testCommand(file, context), {
    cwd: context.cwd,
    env: context.env,
    buffered: context.buffered,
  });
  const ms = performance.now() - started;
  if (context.buffered) {
    process.stdout.write(
      `\n[tsx-tests] ${relative(context.cwd, file)} status=${status === 0 ? 'ok' : 'fail'} ms=${Math.round(ms)}\n${output}`,
    );
  }
  return { file, ms, status };
}

async function runLaneSequentially(files, context) {
  const records = [];
  for (const file of files) {
    records.push(await runOne(file, context));
  }
  return records;
}

/**
 * Reporting view over one run.
 *
 * `records` carries per-execution timings: one entry per file, in every lane —
 * module-mock files included, now that they run one process per file.
 *
 * `discovered` is the pre-partition file list; reporting it separately from the
 * assignment count is what makes `discovered=N assigned=N` a real claim.
 */
export function summaryLines({
  workspace,
  workers,
  discovered,
  partition,
  records,
  failures,
  totalMs,
}) {
  const check = verifyAssignment(discovered, partition);
  const parallelCount = partition.parallel.reduce((sum, lane) => sum + lane.length, 0);
  const lines = [
    `\n[tsx-tests] summary workspace="${workspace}" workers=${workers}` +
      ` discovered=${check.discoveredCount} assigned=${check.assignedUniqueCount}` +
      ` module_mock=${partition.moduleMock.length} serial=${partition.serial.length}` +
      ` parallel=${parallelCount}` +
      ` failed=${failures.length} total_ms=${Math.round(totalMs)} total=${formatDuration(totalMs)}`,
  ];
  if (records.length > 0) {
    lines.push('[tsx-tests] slowest:');
    rankSlowest(records).forEach((record, index) => {
      lines.push(
        `[tsx-tests]   ${index + 1}. ${record.label} ms=${Math.round(record.ms)} (${formatDuration(record.ms)})`,
      );
    });
  }
  if (failures.length > 0) {
    lines.push('[tsx-tests] failures:');
    for (const failure of failures) {
      lines.push(`[tsx-tests]   - ${failure.label} exit=${failure.status}`);
    }
  }
  return lines;
}

export function buildArtifact({
  workspace,
  invocation,
  workers,
  discovered,
  partition,
  records,
  failures,
  totalMs,
  toLabel,
}) {
  const byFile = new Map(records.filter((record) => record.file).map((r) => [r.file, r]));
  const check = verifyAssignment(discovered, partition);
  return {
    kind: 'tsx-tests',
    workspace,
    invocation: invocation ?? null,
    workers,
    discoveredCount: check.discoveredCount,
    assignedCount: check.assignedUniqueCount,
    assignment: {
      ok: check.ok,
      assignedTotal: check.assignedCount,
      missing: check.missing.map(toLabel),
      duplicate: check.duplicate.map(toLabel),
      unexpected: check.unexpected.map(toLabel),
    },
    status: failures.length > 0 ? 'fail' : 'ok',
    totalMs: Math.round(totalMs),
    // Every lane now runs one process per file, so each file carries its own
    // duration and verdict. A file with no record is genuinely 'skipped' — which
    // is a real signal, not a reporting artefact of a shared batch process.
    files: assignments(partition).map((entry) => {
      const record = byFile.get(entry.file);
      return {
        file: toLabel(entry.file),
        lane: entry.lane,
        worker: entry.worker,
        ms: record ? Math.round(record.ms) : null,
        status: record ? (record.status === 0 ? 'ok' : 'fail') : 'skipped',
      };
    }),
    failures: failures.map((failure) => ({ label: failure.label, status: failure.status })),
    slowest: rankSlowest(records).map((record) => ({
      label: record.label,
      ms: Math.round(record.ms),
    })),
  };
}

async function main() {
  // Argument errors are operator typos, not crashes: surface the one-line reason
  // the way the usage error below does, rather than seven frames of module-loader
  // stack burying it.
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const { roots, cwd: cwdArg, tsconfig, nodeTest, workers: workersArg } = parsed;
  const cwd = cwdArg ? resolve(cwdArg) : process.cwd();

  if (roots.length === 0) {
    console.error(
      'Usage: run-tsx-tests.mjs [--cwd <dir>] [--tsconfig <file>] [--node-test] [--workers <n>] <dir-or-test-file> [...]',
    );
    process.exitCode = 1;
    return;
  }

  normalizeTimingsDir();
  const workers = resolveWorkers(workersArg);
  const tests = discoverTests(roots, cwd);
  if (tests.length === 0) {
    console.error(`No .test.ts files found under: ${roots.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const partition = partitionTests(tests, {
    workers,
    nodeTest,
    classify: (file) => classifyTest(readFileSync(file, 'utf8')),
  });

  const env = childEnvironment();
  const toLabel = (file) => relative(cwd, file);

  // Reject a bad partition before spending minutes running tests: a lost file
  // would otherwise look like a green run over a smaller suite.
  const assignmentCheck = verifyAssignment(tests, partition);
  if (!assignmentCheck.ok) {
    for (const line of assignmentDiagnosticLines(assignmentCheck, toLabel)) console.error(line);
    process.exitCode = 1;
    return;
  }

  // Buffer per-file output only when lanes can actually interleave; a single
  // active lane keeps the historical live-streaming behaviour.
  const activeLanes = partition.parallel.filter((lane) => lane.length > 0);
  const buffered = activeLanes.length > 1;
  const context = { cwd, env, tsconfig, toLabel, buffered: false };
  const started = performance.now();
  const records = [];

  // One process per file, sequentially: module mocks are process-global, and a
  // shared process is what let `--test` skip the whole batch silently.
  records.push(
    ...(await runLaneSequentially(partition.moduleMock, { ...context, moduleMock: true })),
  );

  records.push(...(await runLaneSequentially(partition.serial, context)));
  const parallelRecords = await Promise.all(
    activeLanes.map((lane) => runLaneSequentially(lane, { ...context, buffered })),
  );
  records.push(...parallelRecords.flat());

  const totalMs = performance.now() - started;
  const labelled = records.map((record) => ({ ...record, label: toLabel(record.file) }));
  const failures = labelled.filter((record) => record.status !== 0);
  const report = {
    workspace: basename(cwd),
    invocation: roots.join(' '),
    workers,
    discovered: tests,
    partition,
    records: labelled,
    failures,
    totalMs,
    toLabel,
  };

  for (const line of summaryLines(report)) console.log(line);
  const artifactPath = writeTimingArtifact(
    `tsx-tests-${report.workspace}.json`,
    buildArtifact(report),
  );
  if (artifactPath) console.log(`[tsx-tests] timings artifact: ${artifactPath}`);

  finish(failures.length > 0 ? 1 : 0);
}

if (isMainModule(import.meta.url)) await main();
