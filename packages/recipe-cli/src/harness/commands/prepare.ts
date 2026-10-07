// prepare — run the readiness chain for a checkout and record the outcome as
// the protocol readiness record. One file, one verdict: callers read
// sandbox.json instead of re-deriving readiness from scattered step output.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { AdapterPrepare, PlatformAdapter } from '@farmslot/adapter-sdk';
import { READINESS_RECORD, type ReadinessRecord, type ReadinessStep } from '@farmslot/protocol';
import { OperationOutputTail } from '@farmslot/recipe-runner/runtime/operation';

import { detectAdapter, harnessAdapter, harnessAdapters } from '../adapters.js';
import { acquireCheckoutLock, trackCheckoutChild } from '../checkout-lock.js';
import { color, stripAnsi } from '../cli-color.js';
import { recordCommandStage } from '../command-journal.js';
import { runnerProvenance, type RunnerProvenanceOptions } from '../doctor-report.js';
import { harnessHost, hostEnvName } from '../host.js';
import { optionFlag, optionString, parseArgs, targetPath, usageError } from '../parse-args.js';
import { harnessExecutable, PREPARE_PROGRESS_ARTIFACT, recipeRuntimeDir } from '../paths.js';
import { adapterReadiness } from '../readiness.js';
import { EXIT } from '../shared.js';
import { createStageReporter, type ReportedStage, STAGE_LINE } from '../stage-progress.js';

import { formatDuration } from './status-watch.js';

/** A step the host runs after launch (its fixture setup, say). */
export interface PrepareStep {
  id: string;
  // The command the record names when the step is skipped (`<bin> <command>`).
  command: string;
  // Shown on the row before and while the step runs.
  hint?: string;
  argv(context: {
    device: readonly string[];
    forwarded: readonly string[];
    targetArgs: readonly string[];
  }): string[];
}

export interface PrepareCommandOptions {
  // The usage line every usage error ends with.
  usage: string;
  // Steps after launch, in order.
  steps?: readonly PrepareStep[];
  // The launch row's hint.
  launchHint?: string;
  // The device platform option (e.g. --mobile-platform ios|android).
  deviceTarget?: { option: string; flag: string; choices: readonly string[] };
  // How --clear-metro is refused on a platform without it ("mobile only").
  clearMetroOnly?: string;
  // A value option forwarded to launch and the host steps, checked first.
  forward?: {
    option: string;
    flag: string;
    // Throws a usage error when the value is malformed.
    validate?(value: string): void;
  };
  provenance?: RunnerProvenanceOptions;
}

const REPORT_DIR = 'prepare';
const SKIPPED_AFTER_FAILURE = 'previous step failed';
// A step's stage name says what it runs when that is more than its id.
const STAGE_NAME: Record<string, string> = { doctor: 'doctor --fix', launch: 'launch --verify' };

export interface StatusDevice {
  platform?: string;
  selected?: boolean;
}

function reportPathFor(id: string): string {
  return path.join(REPORT_DIR, `${id}.json`);
}

// A step's verdict comes from its exit code and its own JSON report, never from
// scraped console text: banners, warnings, and update notices are not state.
function reportedError(stdout: string | undefined): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout ?? '');
  } catch {
    // Not every command reports a structured error; the exit code still stands.
    return undefined;
  }
  const message = (parsed as { error?: { message?: unknown } })?.error?.message;
  return typeof message === 'string' && message ? message : undefined;
}

// @farmslot/protocol owns ReadinessStep, so how long a step took rides along as
// a local extension of that type until the protocol carries the field itself.
type TimedStep = ReadinessStep & { durationMs: number };

function skippedStep(id: string, command: string, reason: string): TimedStep {
  return { id, command, status: 'skipped', exitCode: 0, reason, durationMs: 0 };
}

type RowState = 'pending' | 'running' | ReadinessStep['status'];

const STEP_MARK: Record<RowState, string> = {
  pending: '·',
  running: '…',
  pass: '✓',
  fail: '✗',
  skipped: '–',
};
const STEP_STYLE: Record<RowState, string> = {
  pending: 'dim',
  running: 'accent',
  pass: 'ok',
  fail: 'err',
  skipped: 'dim',
};

// Steps long enough that silence reads as a hang. The note is on the row from
// the moment the list is drawn, not from when the step starts: the point is to
// set the expectation before the wait, not to explain it once someone is already
// wondering. Fast steps carry nothing, so a note always means "this one is slow".
// (The host supplies them: PrepareCommandOptions.launchHint and each step's hint.)

// The chain the platform will actually run, known before the first step so the
// whole list can be shown from the start rather than revealed one line at a time.
function stepChain(headless: boolean, steps: readonly PrepareStep[]): string[] {
  return headless
    ? ['doctor', 'status', 'verify']
    : ['doctor', 'status', 'launch', ...steps.map((step) => step.id), 'verify'];
}

// What the last prepare of this checkout spent on each step. It is the only
// honest estimate the harness has, and the one a reader wants while waiting.
function lastRunDurations(recordPath: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch {
    // No previous record, or not a JSON document: there is simply no estimate
    // to offer, and the hints stand on their static text alone.
    return {};
  }
  const steps = (parsed as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return {};
  const durations: Record<string, number> = {};
  for (const step of steps as Array<Record<string, unknown>>) {
    if (
      typeof step?.id === 'string' &&
      typeof step.durationMs === 'number' &&
      step.durationMs > 0
    ) {
      durations[step.id] = step.durationMs;
    }
  }
  return durations;
}

function stepHints(
  chain: readonly string[],
  lastRun: Record<string, number>,
  staticHints: Readonly<Record<string, string>>,
): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const id of chain) {
    const previous = lastRun[id];
    const parts: string[] = [];
    if (staticHints[id]) parts.push(staticHints[id]);
    if (previous !== undefined) parts.push(`last run ${formatDuration(previous)}`);
    if (parts.length > 0) hints[id] = parts.join(', ');
  }
  return hints;
}

interface StepRow {
  id: string;
  state: RowState;
  hint?: string;
  // The running step's latest stage line, in place of its hint.
  detail?: string;
  reason?: string;
  durationMs?: number;
  startedAt?: number;
}

function stepRowLine(row: StepRow, width: number): string {
  const out = (style: string, text: string) => color(style, text, { stream: process.stdout });
  const running = row.state === 'pending' || row.state === 'running';
  const elapsed =
    row.state === 'running' && row.startedAt !== undefined
      ? ` ${out('dim', formatDuration(Date.now() - row.startedAt))}`
      : '';
  // While a step is ahead of or under way, the parenthesis explains the wait;
  // once it is over, the same slot carries what it actually took.
  const note = running
    ? (row.detail ?? row.hint)
    : row.durationMs
      ? formatDuration(row.durationMs)
      : undefined;
  const mark = out(STEP_STYLE[row.state], STEP_MARK[row.state]);
  return (
    `${mark} ${out(running ? 'bold' : 'dim', row.id.padEnd(width))}: ${out(STEP_STYLE[row.state], row.state)}` +
    `${elapsed}${row.reason ? ` — ${row.reason}` : ''}${note ? ` ${out('dim', `(${note})`)}` : ''}`
  );
}

// The whole chain as one block: pending steps up front so the wait is bounded,
// the running one counting up, the finished ones carrying their duration. On a
// terminal the block is rewritten in place; piped, it is a plain log.
function createStepView(chain: readonly string[], hints: Record<string, string>) {
  const rows = new Map<string, StepRow>(
    chain.map((id) => [id, { id, state: 'pending', hint: hints[id] }]),
  );
  const width = Math.max(...chain.map((id) => id.length));
  const tty = Boolean(process.stdout.isTTY);
  // A row wider than the terminal wraps onto a second physical line, and the
  // redraw counts logical lines — one wrapped hint and every later repaint lands
  // in the wrong place. Piped output has no width to respect.
  const block = () => {
    // Only a width we actually know truncates anything. A pty can report 0 (or
    // nothing at all) when no one is looking at it, and trimming to that blanks
    // the whole block instead of fitting it.
    const terminalColumns = process.stdout.columns;
    const columns =
      tty && typeof terminalColumns === 'number' && terminalColumns > 0
        ? terminalColumns
        : Number.POSITIVE_INFINITY;
    return [...rows.values()].map((row) => {
      const line = stepRowLine(row, width);
      // Slicing a styled string can cut an escape in half, so an over-wide row
      // gives up its colour rather than its shape.
      return stripAnsi(line).length <= columns ? line : stripAnsi(line).slice(0, columns);
    });
  };
  let painted = 0;
  let lastFrame = '';
  let ended = false;
  let timer: NodeJS.Timeout | undefined;

  const repaint = (): void => {
    const lines = block();
    const frame = lines.join('\n');
    // Nothing moved since the last paint; repainting would only cost flicker.
    if (frame === lastFrame) return;
    lastFrame = frame;
    const up = painted > 0 ? `\x1b[${painted}A` : '';
    painted = lines.length;
    process.stdout.write(`${up}${lines.map((line) => `\x1b[2K${line}`).join('\n')}\n`);
  };
  const writeBlock = (): void => {
    process.stdout.write(`${block().join('\n')}\n`);
  };

  return {
    begin(): void {
      if (tty) repaint();
      else writeBlock();
    },
    start(id: string, startedAt: number): void {
      const row = rows.get(id);
      if (!row) return;
      row.state = 'running';
      row.startedAt = startedAt;
      if (!tty) return;
      repaint();
      // Ticked four times a second, not once: a busy moment in the event loop
      // then costs a late repaint rather than a whole missed second, and the
      // clock on screen never sits further behind the wall than a quarter of a
      // second. repaint writes nothing when the rendered second has not changed.
      //
      // The timer is deliberately NOT unref'd. An unref'd timer does not hold
      // the loop awake, so through a step that stays quiet for minutes — verify
      // waiting on its probe — the loop sleeps and the clock on screen stops
      // while the wall clock does not. end() always clears it, so a ref'd timer
      // cannot outlive the run.
      timer = setInterval(repaint, 250);
    },
    finish(step: TimedStep): void {
      clearInterval(timer);
      timer = undefined;
      const row = rows.get(step.id);
      // Core records launch and fixtures as skipped without ever listing them:
      // its chain is doctor, status, verify, and the record keeps the rest.
      if (!row) return;
      row.state = step.status;
      row.startedAt = undefined;
      row.reason = step.reason;
      row.durationMs = step.durationMs;
      if (tty) repaint();
      else process.stdout.write(`${stepRowLine(row, width)}\n`);
    },
    // Shown on the next tick of the live view.
    detail(id: string, text: string): void {
      const row = rows.get(id);
      if (row) row.detail = text;
    },
    // Idempotent: the caller ends the view where the final block belongs in the
    // output, and a `finally` ends it again on the paths that never got there.
    // The ticker holds the event loop awake, so this must run either way.
    end(): void {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      timer = undefined;
      // The terminal already holds the finished block; piped output gets it once.
      if (!tty) writeBlock();
    },
  };
}

// Capture a step's streams the way spawnSync did — stdout for the report file,
// stderr held back for the failure path — while leaving the event loop free so
// the running line can tick during a step that takes minutes. The child's own
// stage lines go to onStageLine as they arrive instead of the held-back stderr.
function spawnStep(
  executable: string,
  args: readonly string[],
  target: string,
  onStageLine?: (line: string) => void,
): Promise<{ error?: Error; status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], {
      cwd: target,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The update nudge is an interactive courtesy; it has no place in the
      // stream a recorded readiness step captures.
      env: { ...process.env, [hostEnvName('NO_UPDATE_CHECK')]: '1' },
    });
    if (child.pid) trackCheckoutChild(target, child.pid);
    let stdout = '';
    const stderr = new OperationOutputTail();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    let partial = '';
    child.stderr?.on('data', (chunk: string) => {
      const lines = `${partial}${chunk}`.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (onStageLine && STAGE_LINE.test(line)) onStageLine(line);
        else stderr.append(`${line}\n`);
      }
    });
    child.on('error', (error: Error) =>
      resolve({ error, status: null, stdout, stderr: stderr.toString() }),
    );
    child.on('close', (status) => {
      stderr.append(partial);
      resolve({ status, stdout, stderr: stderr.toString() });
    });
  });
}

// Each step is the harness re-entering itself, so a task-local install prepares
// the checkout with the same executable that will later run the proof.
async function runStep(
  executable: string,
  target: string,
  artifactsDir: string,
  id: string,
  args: readonly string[],
  {
    json,
    onSpawn,
    onStageLine,
  }: {
    json: boolean;
    onSpawn?: (startedAt: number) => void;
    onStageLine?: (line: string) => void;
  },
): Promise<TimedStep> {
  const command = [executable, ...args].join(' ');
  // One timestamp, taken at the spawn: the elapsed a reader watches tick and the
  // durationMs the record keeps are then the same measurement, not two.
  const startedAt = Date.now();
  onSpawn?.(startedAt);
  const result = await spawnStep(executable, args, target, onStageLine);
  const durationMs = Date.now() - startedAt;
  if (result.error) {
    return { id, command, status: 'fail', exitCode: 1, reason: result.error.message, durationMs };
  }
  const report = reportPathFor(id);
  const file = path.join(artifactsDir, report);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, result.stdout);
  const exitCode = result.status ?? 1;
  if (exitCode === 0) {
    return { id, command, status: 'pass', exitCode, reportPath: report, durationMs };
  }
  // The failing step's own diagnostics carry the recovery a human must act on;
  // --json keeps stdout a single document and leaves them in the report file.
  if (!json && result.stderr) process.stderr.write(result.stderr);
  return {
    id,
    command,
    status: 'fail',
    exitCode,
    reportPath: report,
    reason: reportedError(result.stdout) ?? `exited ${exitCode}`,
    durationMs,
  };
}

function readDevices(artifactsDir: string): StatusDevice[] {
  const file = path.join(artifactsDir, reportPathFor('status'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A status report that is absent or not a JSON document simply carries no
    // device list; the caller then reports the target as ambiguous.
    return [];
  }
  const devices = (parsed as { devices?: unknown })?.devices;
  return Array.isArray(devices) ? (devices as StatusDevice[]) : [];
}

function ambiguousTarget(
  json: boolean,
  error: { code: string; message: string; userAction: string },
): number {
  const { code, message, userAction } = error;
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: 'prepare',
          status: 'fail',
          exitCode: EXIT.runtime,
          error: { code, message, userAction },
        },
        null,
        2,
      ),
    );
  } else {
    console.error(`✗ ${harnessHost().name} prepare: ${message}`);
    console.error(`  Next: ${userAction}`);
  }
  return EXIT.runtime;
}

function resolvePlatform(
  requested: string | undefined,
  target: string,
  usage: string,
): { surface: PlatformAdapter; prepare: AdapterPrepare } {
  const platform = requested ?? detectAdapter(target);
  const surface =
    platform && harnessAdapters().has(platform) ? harnessAdapter(platform) : undefined;
  const prepare = surface ? adapterReadiness(surface).prepare : undefined;
  if (surface && prepare) return { surface, prepare };
  throw usageError(`could not detect the platform of ${target}\n  Next: ${usage}`);
}

export async function handlePrepare(
  argv: string[],
  commandOptions: PrepareCommandOptions,
): Promise<number> {
  const { options } = parseArgs(argv);
  const target = targetPath(options);
  if (!fs.existsSync(target)) return handlePrepareLocked(argv, commandOptions);
  const lock = acquireCheckoutLock(target, 'prepare');
  if ('message' in lock) {
    if (optionFlag(options, 'json'))
      console.log(
        JSON.stringify({
          status: 'fail',
          error: { code: 'SANDBOX_BUSY', message: lock.message },
          exitCode: EXIT.runtime,
        }),
      );
    else
      console.error(
        `${lock.message} Next: inspect the owning operation with ${harnessHost().name} status --watch`,
      );
    return EXIT.runtime;
  }
  try {
    return await handlePrepareLocked(argv, commandOptions);
  } finally {
    lock.release();
  }
}

async function handlePrepareLocked(
  argv: string[],
  commandOptions: PrepareCommandOptions,
): Promise<number> {
  const { options } = parseArgs(argv);
  const json = optionFlag(options, 'json');
  const target = targetPath(options);
  const usage = commandOptions.usage;
  const { surface, prepare } = resolvePlatform(optionString(options, 'platform'), target, usage);
  const platform = surface.id;
  const hostSteps = commandOptions.steps ?? [];
  const artifactsDir = path.resolve(
    optionString(options, 'artifactsDir') ?? path.join(target, recipeRuntimeDir()),
  );
  const executable = harnessExecutable();
  const targetArgs = ['--target', target];

  // doctor teaches "--clear-metro if the failure persists", so the sanctioned
  // prepare path has to be able to carry it. It stays an explicit operator
  // decision: nothing here ever clears the transform cache on its own.
  const clearMetro = optionFlag(options, 'clearMetro');
  if (clearMetro && !prepare.clearMetro) {
    throw usageError(
      `--clear-metro is ${commandOptions.clearMetroOnly ?? 'not supported here'}; this checkout is ${platform}\n  Next: ${usage}`,
    );
  }

  // Forwarded verbatim to launch and to the host steps, which own its grammar;
  // the step record keeps the full command, so sandbox.json shows the value.
  const forward = commandOptions.forward;
  const forwardValue = forward ? optionString(options, forward.option) : undefined;
  if (forward && forwardValue !== undefined) {
    if (surface.headless) {
      throw usageError(
        `${forward.flag} needs an app runtime; this checkout is ${platform}\n  Next: ${usage}`,
      );
    }
    forward.validate?.(forwardValue);
  }
  const forwarded = forward && forwardValue !== undefined ? [forward.flag, forwardValue] : [];

  const deviceTarget = commandOptions.deviceTarget;
  let devicePlatform = deviceTarget ? optionString(options, deviceTarget.option) : undefined;
  if (
    deviceTarget &&
    devicePlatform !== undefined &&
    !deviceTarget.choices.includes(devicePlatform)
  ) {
    throw usageError(
      `${deviceTarget.flag} must be ${deviceTarget.choices.join(' or ')}; received '${devicePlatform}'\n  Next: ${usage}`,
    );
  }
  const recordPath = path.join(artifactsDir, READINESS_RECORD);
  const progressPath = path.join(artifactsDir, PREPARE_PROGRESS_ARTIFACT);
  // --json owns stdout as a single document, so it gets no step block.
  const chain = stepChain(surface.headless, hostSteps);
  const staticHints: Record<string, string> = {
    ...(commandOptions.launchHint ? { launch: commandOptions.launchHint } : {}),
    ...Object.fromEntries(hostSteps.flatMap((step) => (step.hint ? [[step.id, step.hint]] : []))),
  };
  const view = json
    ? undefined
    : createStepView(chain, stepHints(chain, lastRunDurations(recordPath), staticHints));
  view?.begin();
  // Stage lines on stderr, unless the live view is repainting this terminal:
  // there the running row carries the step's latest stage line instead.
  const stages = json || !process.stdout.isTTY ? createStageReporter() : undefined;

  const steps: TimedStep[] = [];
  let activeStep: { id: string; startedAt: string } | undefined;
  const startedAt = new Date().toISOString();
  const writeProgress = (): void => {
    fs.mkdirSync(path.dirname(progressPath), { recursive: true });
    const temporaryPath = `${progressPath}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify({
        schemaVersion: 1,
        startedAt,
        updatedAt: new Date().toISOString(),
        total: chain.length,
        steps: steps
          .filter(({ id }) => chain.includes(id))
          .map(({ id, status, durationMs }) => ({ id, status, durationMs })),
        ...(activeStep ? { active: activeStep } : {}),
      })}\n`,
    );
    fs.renameSync(temporaryPath, progressPath);
  };
  const failed = () => steps.some((step) => step.status === 'fail');
  const addStep = (step: TimedStep): TimedStep => {
    steps.push(step);
    activeStep = undefined;
    writeProgress();
    view?.finish(step);
    return step;
  };
  const run = async (id: string, args: readonly string[]): Promise<TimedStep> => {
    if (failed()) {
      return addStep(skippedStep(id, [executable, ...args].join(' '), SKIPPED_AFTER_FAILURE));
    }
    let stage: ReportedStage | undefined;
    const step = await runStep(executable, target, artifactsDir, id, args, {
      json,
      onSpawn: (stepStartedAt) => {
        recordCommandStage(id);
        activeStep = { id, startedAt: new Date(stepStartedAt).toISOString() };
        writeProgress();
        view?.start(id, stepStartedAt);
        stage = stages?.stage(STAGE_NAME[id] ?? id, {
          index: chain.indexOf(id) + 1,
          total: chain.length,
        });
      },
      onStageLine: (line) => (stage ? stage.forward(line) : view?.detail(id, line)),
    });
    if (step.status === 'pass') stage?.done();
    else stage?.failed(step.reason);
    return addStep(step);
  };

  const heartbeat = setInterval(() => {
    if (activeStep) writeProgress();
  }, 10_000);

  // The ticker holds the event loop awake so it cannot miss a second, which
  // makes ending the view mandatory on every way out of the chain — the early
  // return below, or a step that throws on an unwritable report path.
  try {
    await run('doctor', ['doctor', '--fix', '--json', '--adapter', platform, ...targetArgs]);
    await run('status', ['status', '--json', ...targetArgs]);

    const devicePlatformFor = prepare.devicePlatform;
    if (devicePlatformFor && !devicePlatform && !failed()) {
      devicePlatform = devicePlatformFor(target, readDevices(artifactsDir));
      if (!devicePlatform) {
        return ambiguousTarget(
          json,
          prepare.ambiguousTarget?.() ?? {
            code: 'PREPARE_DEVICE_TARGET_AMBIGUOUS',
            message: 'could not infer the device target from the connected devices',
            userAction: `choose the device target, then rerun this command: ${usage}`,
          },
        );
      }
    }

    if (surface.headless) {
      // A headless platform reads its files directly and verify is its only
      // readiness gate.
      const reason = `${platform} is headless: no app surface to launch or seed`;
      addStep(skippedStep('launch', `${executable} launch`, reason));
      for (const step of hostSteps)
        addStep(skippedStep(step.id, `${executable} ${step.command}`, reason));
    } else {
      // devicePlatform is set unless an earlier step already failed, in which
      // case these steps are recorded as skipped and the device target is
      // unknowable. A platform without devices records the option but launches none.
      const device = devicePlatformFor && devicePlatform ? [devicePlatform] : [];
      await run('launch', [
        'launch',
        ...device,
        ...(clearMetro ? ['--clear-metro'] : []),
        ...forwarded,
        '--verify',
        '--json',
        ...targetArgs,
      ]);
      for (const step of hostSteps)
        await run(step.id, step.argv({ device, forwarded, targetArgs }));
    }

    await run('verify', ['verify', '--json', '--adapter', platform, ...targetArgs]);
  } finally {
    clearInterval(heartbeat);
    stages?.close('failed', 'prepare stopped');
    view?.end();
  }

  const provenance = runnerProvenance(surface.actions.manifestPath(), commandOptions.provenance);
  const record: ReadinessRecord = {
    schemaVersion: 1,
    harness: {
      name: provenance.packageName,
      version: provenance.version,
      source: `${provenance.installKind}/${provenance.packageSource}`,
      executable: provenance.executablePath,
    },
    platform,
    // The protocol's mobilePlatform is ios or android; another device target is
    // not recorded.
    ...(devicePlatform && (devicePlatform === 'ios' || devicePlatform === 'android')
      ? { mobilePlatform: devicePlatform }
      : {}),
    steps,
    ready: steps.every((step) => step.status !== 'fail'),
    recordedAt: new Date().toISOString(),
  };

  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  fs.rmSync(progressPath, { force: true });

  if (json) {
    console.log(JSON.stringify(record, null, 2));
  } else {
    console.log(`readiness record: ${recordPath}`);
  }
  return record.ready ? EXIT.ok : EXIT.runtime;
}
