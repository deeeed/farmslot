#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

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
export const TEST_STATUS_ENV = 'FARMSLOT_TEST_STATUS_FILE';

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
  if (source.includes('mock.module(') || source.includes('mock-pty.test-support'))
    return 'module-mock';
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

/**
 * A private tmux server for one test run. Tests, and the production code they
 * drive, call tmux; from inside a pane `$TMUX` would send those calls to the
 * operator's own server, where a stray `kill-server` ends every session. Test
 * processes get no `TMUX`/`TMUX_PANE` and a `TMUX_TMPDIR` the runner owns, so
 * plain `tmux` lands on a server under that directory.
 * `FARMSLOT_TMUX_SANDBOX` names its socket: tests that run tmux require it and
 * pass it with `-S`.
 */
export function tmuxSandboxEnvironment(env, dir, uid = process.getuid?.() ?? 0) {
  const sandboxed = { ...env, TMUX_TMPDIR: dir };
  delete sandboxed.TMUX;
  delete sandboxed.TMUX_PANE;
  sandboxed.FARMSLOT_TMUX_SANDBOX = join(dir, `tmux-${uid}`, 'default');
  return sandboxed;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** Wait (bounded, synchronously: it also runs on exit) for a process to end. */
function waitForExit(pid, timeoutMs) {
  const until = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (processAlive(pid)) {
    if (Date.now() >= until) return false;
    Atomics.wait(sleeper, 0, 0, 50);
  }
  return true;
}

/**
 * End the run's private tmux server, by its socket only, and remove its
 * directory. The server's own pid, read before `kill-server`, decides whether
 * it stopped; a socket with no server behind it has nothing to end.
 */
export function closeTmuxSandbox(env) {
  const socket = env.FARMSLOT_TMUX_SANDBOX;
  if (socket && existsSync(socket)) {
    const probe = spawnSync('tmux', ['-S', socket, 'display-message', '-p', '#{pid}'], {
      env,
      encoding: 'utf8',
    });
    const pid = probe.status === 0 ? Number.parseInt(probe.stdout.trim(), 10) : Number.NaN;
    spawnSync('tmux', ['-S', socket, 'kill-server'], { env, stdio: 'ignore' });
    if (Number.isInteger(pid) && !waitForExit(pid, 5000)) {
      throw new Error(`[tsx-tests] the tmux sandbox server ${pid} on ${socket} did not stop`);
    }
  }
  rmSync(env.TMUX_TMPDIR, { recursive: true, force: true });
}

/**
 * Create the sandbox directory with the per-user socket directory tmux would
 * make under TMUX_TMPDIR (0700): with `-S`, tmux does not create it.
 */
export function openTmuxSandbox(uid = process.getuid?.() ?? 0) {
  // Short directory name: tmux socket paths are limited to ~100 bytes.
  const dir = mkdtempSync(join(tmpdir(), 'fs-tmux-'));
  mkdirSync(join(dir, `tmux-${uid}`), { mode: 0o700 });
  return dir;
}

function childEnvironment(tmuxDir) {
  const env = tmuxSandboxEnvironment({ ...process.env, NODE_TEST_CONTEXT: '1' }, tmuxDir);
  for (const key of GIT_LOCATION_ENV) delete env[key];
  return env;
}

/** Test processes still running, so an interrupted run can stop them first. */
const activeChildren = new Set();

/** Set when a signal interrupts the run: no further test file starts. */
let interrupted = false;

/**
 * Pass a signal on to the running test processes and wait for them to close,
 * against one deadline, so none recreates files after the run's directories
 * are removed. Asynchronous: Node reaps an exited child only while the event
 * loop runs. Only the yarn children are signalled; yarn passes the signal to
 * the test process, but a process a test started itself is not tracked here.
 */
export async function stopChildren(signal, children = activeChildren, timeoutMs = 5000) {
  const running = [...children].filter(
    (child) => child.exitCode === null && child.signalCode === null,
  );
  const closed = running.map((child) => new Promise((resolve) => child.once('close', resolve)));
  for (const child of running) child.kill(signal);
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([Promise.all(closed), deadline]);
  clearTimeout(timer);
  if (outcome === 'timeout') {
    for (const child of running) {
      if (child.exitCode === null && child.signalCode === null) {
        console.error(`[tsx-tests] test process ${child.pid} did not exit after ${signal}`);
        process.exitCode = 1;
      }
    }
  }
}

function runYarn(args, { cwd, env, buffered }) {
  return new Promise((resolvePromise, rejectPromise) => {
    // An interrupted run starts nothing new: it could outlive the shutdown.
    if (interrupted) {
      resolvePromise({ status: 1, output: '' });
      return;
    }
    const child = spawn('yarn', args, {
      cwd,
      env,
      shell: false,
      stdio: buffered ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    activeChildren.add(child);
    child.once('close', () => activeChildren.delete(child));
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

/**
 * Test files (`<workspace dir>/<path>`) that still leave entries in their
 * TMPDIR. The runner removes their TMPDIR either way, so nothing reaches the
 * machine's. Make a file clean up, then delete its entry. A listed file that
 * left nothing gets a notice, not a failure (some leak only where a tool is
 * installed or a test is not skipped), so shrinking the list is a review step.
 */
export const KNOWN_TMPDIR_LEAKERS = new Set([
  'agent-runtime/src/task-init/discover.test.ts',
  'cli/src/commands/credential.test.ts',
  'cli/src/commands/recipe-artifacts.test.ts',
  'cli/src/commands/run.test.ts',
  'cli/src/gateway-profiles.test.ts',
  'cli/src/onboarding/add.test.ts',
  'cli/src/onboarding/migrations.test.ts',
  'cli/src/onboarding/pack.test.ts',
  'cli/src/onboarding/pool-config.test.ts',
  'cli/src/slot-context.test.ts',
  'gateway/src/backlog/provenance.test.ts',
  'gateway/src/chat/chat-action-normalization.test.ts',
  'gateway/src/chat/chat-actions.test.ts',
  'gateway/src/ci-monitor/blocked-fix.test.ts',
  'gateway/src/ci-monitor/merge-observation.test.ts',
  'gateway/src/copilot-runtime/compatibility.test.ts',
  'gateway/src/copilot-runtime/isolation.test.ts',
  'gateway/src/copilot-runtime/launcher.test.ts',
  'gateway/src/copilot-runtime/session-lifecycle.test.ts',
  'gateway/src/copilot-runtime/session-store.test.ts',
  'gateway/src/copilot-runtime/transcript.test.ts',
  'gateway/src/copilot-runtime/transport.test.ts',
  'gateway/src/family-observability/change-ledger.test.ts',
  'gateway/src/family-observability/context.test.ts',
  'gateway/src/family-observability/provenance.test.ts',
  'gateway/src/family-observability/retrospective.test.ts',
  'gateway/src/family-observability/snapshot.test.ts',
  'gateway/src/fleet/pairing.test.ts',
  'gateway/src/fleet/pressure-history-store.test.ts',
  'gateway/src/fleet/project-config-load.test.ts',
  'gateway/src/fleet/slot-storage-cleanup.test.ts',
  'gateway/src/machine-parking/journal.test.ts',
  'gateway/src/methods/chat.test.ts',
  'gateway/src/methods/dispatch/pressure-admission-control.test.ts',
  'gateway/src/methods/dispatch/pressure-admission.test.ts',
  'gateway/src/methods/dispatch/preview.test.ts',
  'gateway/src/methods/eval.test.ts',
  'gateway/src/methods/gateway-doctor-auth.test.ts',
  'gateway/src/methods/provider-accounts.test.ts',
  'gateway/src/methods/slot/prepare-command.test.ts',
  'gateway/src/node-support/files.test.ts',
  'gateway/src/quality/pr-body-recipe.test.ts',
  'gateway/src/quality/recipe-quality.test.ts',
  'gateway/src/review-workspaces/completion-record.test.ts',
  'gateway/src/run-completion/orchestrator.test.ts',
  'gateway/src/run-completion/retrospective-feedback.test.ts',
  'gateway/src/run-engine/branch-freshness.test.ts',
  'gateway/src/run-engine/budget-usage-sample.test.ts',
  'gateway/src/run-engine/diff-artifacts.test.ts',
  'gateway/src/run-engine/run-monitor.test.ts',
  'gateway/src/runners/model-catalog.test.ts',
  'gateway/src/runners/observability-agreement-log.test.ts',
  'gateway/src/runners/provider-account-select.test.ts',
  'gateway/src/runners/provider-accounts.test.ts',
  'gateway/src/runners/quota-guard.test.ts',
  'gateway/src/runners/usage-exhaustion-ledger.test.ts',
  'gateway/src/runs/analytics.test.ts',
  'gateway/src/runs/store.test.ts',
  'gateway/src/runtime/session-usage-script.test.ts',
  'gateway/src/security/auth.test.ts',
  'gateway/src/server-ws-payload.test.ts',
  'gateway/src/server/authorization.test.ts',
  'gateway/src/tasks/sidecars.test.ts',
  'gateway/src/tasks/writer.test.ts',
  'handoff/test/assemble.test.ts',
  'handoff/test/closeout.test.ts',
  'handoff/test/grade.test.ts',
  'handoff/test/integrity.test.ts',
  'handoff/test/pr-publish.test.ts',
  'handoff/test/resolve.test.ts',
  'handoff/test/safe-path.test.ts',
  'handoff/test/task-io.test.ts',
  'handoff/test/task-key.test.ts',
  'handoff/test/validate.test.ts',
  'handoff/test/write.test.ts',
  'node/src/commands/tmux.test.ts',
  'node/src/gateway-credential.test.ts',
  'protocol/test/node/capture-helper-path.test.ts',
  'recipe-runner/src/core/observations.test.ts',
  'recipe-runner/test/runtime-readiness.test.ts',
  'slot-config/src/session-usage.test.ts',
]);

/**
 * Tool caches tests share through TMPDIR (tsx's transform cache, Node's compile
 * cache): each file's private TMPDIR links them to the real ones, so files keep
 * a warm cache and the links never count as leftovers.
 */
export function sharedToolCaches(uid = process.getuid?.() ?? 0) {
  return [`tsx-${uid}`, 'node-compile-cache'];
}

/**
 * What an installed tool writes to TMPDIR when a test runs it (cursor-agent's
 * logs): not the test's own leftovers, so not counted, but kept in the file's
 * private TMPDIR and removed with it.
 */
export function toolOutputs(uid = process.getuid?.() ?? 0) {
  return [`cursor-agent-logs-${uid}`];
}

/** Link the shared tool caches into a test file's private TMPDIR. */
export function linkToolCaches(fileTmp, realTmp = tmpdir()) {
  for (const name of sharedToolCaches()) {
    const shared = join(realTmp, name);
    mkdirSync(shared, { recursive: true });
    symlinkSync(shared, join(fileTmp, name));
  }
}

/** What a test file left in its private TMPDIR, as a failure line, or null. */
export function tmpdirLeakFailure(label, entries, known = KNOWN_TMPDIR_LEAKERS) {
  if (known.has(label) || entries.length === 0) return null;
  const shown = entries.slice(0, 10).join(', ') + (entries.length > 10 ? ', …' : '');
  return `[tsx-tests] ${label} left ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in its TMPDIR: ${shown}. Remove temp directories in teardown.`;
}

/** A known leaker that left nothing this run: a hint to shrink the list, or null. */
export function knownLeakerNotice(label, entries, known = KNOWN_TMPDIR_LEAKERS) {
  return known.has(label) && entries.length === 0
    ? `[tsx-tests] ${label} left nothing in its TMPDIR this run: if it no longer leaks anywhere, remove it from KNOWN_TMPDIR_LEAKERS.`
    : null;
}

async function runOne(file, context) {
  const started = performance.now();
  // Per-file state and a private TMPDIR, inside the run's root: anything the
  // file (or a process it starts) creates under os.tmpdir() lands there, is
  // checked, and is removed with it. Short names keep socket paths in range.
  // A counter shared by every lane (each lane's context is a copy).
  context.files.count += 1;
  const stateDir = join(context.runRoot, String(context.files.count));
  mkdirSync(stateDir);
  const fileTmp = join(stateDir, 't');
  mkdirSync(fileTmp);
  linkToolCaches(fileTmp);
  const testStatusFile = join(stateDir, '.farm-status.json');
  writeFileSync(testStatusFile, '{"slots":[]}\n');
  let result;
  let leaked = [];
  try {
    result = await runYarn(testCommand(file, context), {
      cwd: context.cwd,
      env: {
        ...context.env,
        ...(context.tsconfig ? { TSX_TSCONFIG_PATH: resolve(context.cwd, context.tsconfig) } : {}),
        [TEST_STATUS_ENV]: testStatusFile,
        TMPDIR: fileTmp,
        TMP: fileTmp,
        TEMP: fileTmp,
      },
      buffered: context.buffered,
    });
    const caches = new Set([...sharedToolCaches(), ...toolOutputs()]);
    // A test that removed its whole TMPDIR left nothing behind.
    leaked = existsSync(fileTmp) ? readdirSync(fileTmp).filter((entry) => !caches.has(entry)) : [];
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
  const label = `${basename(context.cwd)}/${relative(context.cwd, file)}`;
  const leakFailure = tmpdirLeakFailure(label, leaked);
  const leakMessage = leakFailure ?? knownLeakerNotice(label, leaked);
  // Buffered lanes print the message inside this file's own output block.
  if (leakMessage && !context.buffered) console.error(leakMessage);
  const status = leakFailure && result.status === 0 ? 1 : result.status;
  const output = leakMessage ? `${result.output}${leakMessage}\n` : result.output;
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
    if (interrupted) break;
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

  // Every file's state and private TMPDIR live here; removed when the run ends,
  // interrupted or not. Created and registered before the tmux sandbox, so a
  // failure opening that cannot leave it behind.
  const runRoot = mkdtempSync(join(tmpdir(), 'fst-'));
  let env;
  // Each cleanup reports its own failure: one cannot skip the other.
  const cleanupStep = (step) => {
    try {
      step();
    } catch (error) {
      // Reported and failing: a directory or sandbox server left behind is a broken run.
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };
  const closeSandbox = () => {
    cleanupStep(() => rmSync(runRoot, { recursive: true, force: true }));
    if (env) cleanupStep(() => closeTmuxSandbox(env));
  };
  process.once('exit', closeSandbox);
  // An interrupted run stops its test processes, removes its directories and
  // ends its tmux server, then dies by the same signal. A second signal during
  // that shutdown gets the default action: the operator's override, which
  // skips the cleanup.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      interrupted = true;
      stopChildren(signal)
        .catch((error) => {
          // Reported and failing; the directories and sandbox are still removed.
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        })
        .finally(() => {
          closeSandbox();
          process.kill(process.pid, signal);
        });
    });
  }
  env = childEnvironment(openTmuxSandbox());
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
  const context = { cwd, env, tsconfig, toLabel, buffered: false, runRoot, files: { count: 0 } };
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
