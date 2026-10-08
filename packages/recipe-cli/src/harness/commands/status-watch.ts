// The live task view behind `status --watch`, and the one-shot `status --task`
// that prints the same thing once. Both read files only: no probe, no launch, no
// write, so watching a slot can never disturb the run it reports on.

import os from 'node:os';
import path from 'node:path';

import { isTerminalWorkerSignalStatus } from '@farmslot/protocol';

import { color } from '../cli-color.js';
import { harnessContextField } from '../context-state.js';
import { harnessHost } from '../host.js';
import { EXIT } from '../shared.js';
import {
  CHECKLIST_LABEL_LIMIT,
  collectTaskView,
  findTaskDir,
  TASK_SILENT_AFTER_MS,
  type TaskView,
  type TaskViewRow,
  type TaskViewSubtask,
} from '../task-view.js';

const REFRESH_MS = 2000;
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export interface StatusWatchOptions {
  target: string;
  taskDir?: string;
  json: boolean;
  watch: boolean;
}

export interface StatusWatchDeps {
  now: () => number;
  wait: (ms: number) => Promise<void>;
  write: (text: string) => void;
  isTty: boolean;
}

export async function handleStatusTaskView(options: StatusWatchOptions): Promise<number> {
  const deps: StatusWatchDeps = {
    now: () => Date.now(),
    wait: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    write: (text) => process.stdout.write(text),
    isTty: Boolean(process.stdout.isTTY),
  };
  if (!options.watch || !deps.isTty) return runStatusWatch(options, deps);

  // The alternate-screen redraw owns the cursor until the loop ends, including
  // the Ctrl-C that is the normal way to leave it.
  const restore = () => deps.write(SHOW_CURSOR);
  const interrupt = () => {
    restore();
    process.exit(EXIT.ok);
  };
  process.on('SIGINT', interrupt);
  deps.write(HIDE_CURSOR);
  try {
    return await runStatusWatch(options, deps);
  } finally {
    process.off('SIGINT', interrupt);
    restore();
  }
}

export async function runStatusWatch(
  options: StatusWatchOptions,
  deps: StatusWatchDeps,
): Promise<number> {
  const title = `${harnessHost().name} status ${options.watch ? '--watch' : '--task'}`;
  let previous: TaskView | undefined;
  // A task that was already finished when watching began is history, not the run
  // to wait for: keep watching until a task is seen in progress and then ends.
  let sawInProgress = false;
  for (;;) {
    const taskDir = options.taskDir ?? findTaskDir(options.target);
    const view = collectTaskView(options.target, taskDir, deps.now());
    const changes = changedLines(previous, view);

    if (options.json && !options.watch) {
      deps.write(`${JSON.stringify({ ...view, ...harnessContextField() }, null, 2)}\n`);
    } else if (options.json) {
      if (changes.length > 0)
        deps.write(`${JSON.stringify({ ...view, ...harnessContextField() })}\n`);
    } else if (options.watch && !deps.isTty) {
      for (const line of changes) deps.write(`${line}\n`);
    } else {
      deps.write(
        `${deps.isTty && options.watch ? CLEAR_SCREEN : ''}${renderTaskView(view, title, options.taskDir !== undefined).join('\n')}\n`,
      );
    }

    previous = view;
    const terminal = isTerminalWorkerSignalStatus(view.signal?.status);
    if (view.activity.ongoing) sawInProgress = true;
    if (!options.watch || (terminal && (sawInProgress || options.taskDir !== undefined)))
      return EXIT.ok;
    await deps.wait(REFRESH_MS);
  }
}

// `explicitTask` is true when the caller named the task directory: its rows are
// shown even when it is not in progress, because that is what was asked for.
export function renderTaskView(view: TaskView, title: string, explicitTask = false): string[] {
  const out = (style: string, text: string) => color(style, text, { stream: process.stdout });
  // Details of a task that is not in progress are history; they would read as
  // the current run, so they appear only for a live task or one named explicitly.
  const showTask = view.activity.ongoing || explicitTask;
  const lines: string[] = [
    joinParts(
      [
        out('label', title),
        out('bold', path.basename(view.checkout.target)),
        view.checkout.branch && out('info', view.checkout.branch),
        view.checkout.head && out('dim', `@${view.checkout.head}`),
        showTask &&
          view.elapsedMs !== undefined &&
          out('dim', `${formatDuration(view.elapsedMs)} elapsed`),
      ],
      '  ',
    ),
  ];

  const isolation = view.isolation;
  const device =
    isolation &&
    joinParts([isolation.platform, isolation.simulator, shortUdid(isolation.simulatorUdid)], ' ');
  const devServer = isolation?.metroPort ?? isolation?.watcherPort ?? isolation?.devServerPort;
  const runtimeLine = joinParts([
    isolation?.slotId && `slot ${out('ok', isolation.slotId)}`,
    device && out('ok', device),
    devServer !== undefined && `metro ${out('ok', String(devServer))}`,
    isolation?.cdpPort !== undefined && `cdp ${out('ok', String(isolation.cdpPort))}`,
    isolation?.extensionId && `extension ${out('ok', isolation.extensionId)}`,
    showTask &&
      view.harness?.version &&
      `harness ${out('info', view.harness.version)}${view.harness.sourceKind ? out('dim', ` (${view.harness.sourceKind})`) : ''}`,
  ]);
  if (runtimeLine) lines.push(runtimeLine);

  const template = showTask ? view.template : undefined;
  const templateLine = joinParts([
    template?.id &&
      `template ${out('accent', template.id)}${template.sourceId ? out('dim', ` (${template.sourceId})`) : ''}`,
    template?.flow && `flow ${out('info', template.flow)}`,
    template?.domain && `domain ${out('info', template.domain)}`,
    template?.surface && `via ${out('info', template.surface)}`,
  ]);
  if (templateLine) lines.push(templateLine);

  const taskLine = joinParts(
    [
      template?.ticket && out('bold', template.ticket),
      template?.title && out('info', template.title.trim()),
    ],
    ' ',
  );
  if (taskLine) lines.push(`${out('label', 'task')} ${taskLine}`);

  const contextLine = joinParts([
    view.libraries.length > 0 &&
      `libraries ${out('info', view.libraries.map(libraryLabel).join(' '))}`,
    showTask &&
      view.fixture &&
      `fixture ${out('info', path.basename(view.fixture.fixture ?? 'unknown'))} ${statusWord(out, view.fixture.status)}${view.fixture.walletReset ? out('warn', ' reset') : ''}`,
    showTask &&
      (view.prepare
        ? `sandbox ${out('info', 'preparing')}`
        : view.sandbox?.ready !== undefined &&
          `sandbox ${view.sandbox.ready ? out('ok', 'ready') : out('warn', 'not ready')}`),
  ]);
  if (contextLine) lines.push(contextLine);

  if (showTask && view.acceptance?.length) lines.push('', ...renderAcceptanceLines(view));

  if (showTask && view.prepare) {
    lines.push(
      `prepare ${out('info', view.prepare.step)} · ${view.prepare.completed}/${view.prepare.total} steps · ${formatDuration(view.prepare.elapsedMs)} elapsed`,
    );
  }

  // A step that runs many harness commands without ticking a row is still live;
  // the journal is the proof, so show it.
  const last = view.lastCommand;
  if (showTask && last) {
    lines.push(
      joinParts([
        `last command ${out('info', joinParts([last.command, last.subject], ' '))}`,
        last.verdict && statusWord(out, last.verdict),
        last.ageMs !== undefined && `${formatDuration(last.ageMs)} ago`,
      ]),
    );
  }

  lines.push(...renderOperations(view));
  lines.push('');
  if (!view.activity.ongoing) {
    lines.push(out('warn', 'no ongoing task detected'));
    lines.push(out('dim', idleReason(view)));
    if (!view.taskDir || !explicitTask) return lines;
    lines.push('');
  }
  let phase: string | undefined;
  for (const row of view.checklist) {
    if (row.phase && row.phase !== phase) {
      const inPhase = view.checklist.filter((other) => other.phase === row.phase);
      const done = inPhase.filter((other) => other.checked).length;
      lines.push(out('dim', `  ${row.phase}  ${done}/${inPhase.length}`));
    }
    phase = row.phase;
    lines.push(renderRow(row, view.currentStep, out));
    // A child unit's rows belong to the parent row that owns it, so they are
    // printed under it rather than as steps of their own.
    for (const unit of view.subtasks.filter((entry) => entry.parentStep === row.number)) {
      lines.push(...renderSubtask(unit, out));
    }
  }

  const signal = view.signal;
  if (signal) {
    const age = view.checklist.find((row) => row.runningMs !== undefined)?.runningMs;
    lines.push('');
    lines.push(
      joinParts([
        `signal ${statusWord(out, signal.status)}`,
        // SIGNAL.json records the last row ticked, not the row in progress.
        signal.step && `last ticked ${out('info', stepLabel(signal.step))}`,
        // A cancelled agent leaves status "running"; the age is the only honest hint.
        age !== undefined &&
          `no update for ${out(age > TASK_SILENT_AFTER_MS ? 'warn' : 'dim', formatDuration(age))}`,
      ]),
    );
  }
  return lines;
}

export function renderAcceptanceLines(view: TaskView): string[] {
  if (!view.acceptance?.length) return [];
  const out = (style: string, text: string) => color(style, text, { stream: process.stdout });
  const proven = view.acceptance.filter((row) => row.status?.verdict === 'proven').length;
  return [
    `acceptance criteria ${proven}/${view.acceptance.length} proven`,
    ...view.acceptance.map((row) => {
      const verdict = row.status?.verdict ?? 'no verdict';
      const style =
        verdict === 'proven'
          ? 'ok'
          : verdict === 'weak'
            ? 'warn'
            : verdict === 'no verdict'
              ? 'dim'
              : 'err';
      return `  ${row.id} [${out(style, verdict)}] ${row.text}`;
    }),
  ];
}

// One sentence saying why nothing is in progress, built only from allowlisted fields.
function idleReason(view: TaskView): string {
  if (!view.taskDir) return 'no task directory under temp/tasks';
  const { reason, idleMs, branchCarriesTicket } = view.activity;
  if (reason === 'no-task') return `${path.basename(view.taskDir)} holds no task files yet`;
  const what = reason === 'finished' ? (view.signal?.status ?? 'finished') : 'silent';
  return joinParts(
    [
      `last task ${path.basename(view.taskDir)}: ${what}`,
      idleMs !== undefined && `last update ${formatDuration(idleMs)} ago`,
      branchCarriesTicket === false &&
        `checkout is on ${view.checkout.branch}, which does not carry ${view.template?.ticket}`,
    ],
    ', ',
  );
}

// Piped output is a log: one line per thing that actually moved, never a redraw.
export function changedLines(previous: TaskView | undefined, next: TaskView): string[] {
  // A different task directory is a new context, announced like the first one.
  if (!previous || previous.taskDir !== next.taskDir) {
    return [
      joinParts(
        [
          path.basename(next.checkout.target),
          next.taskDir ? path.basename(next.taskDir) : 'no-task-dir',
          `status=${next.signal?.status ?? 'unknown'}`,
          `step=${next.signal?.step ? stepLabel(next.signal.step) : 'none'}`,
        ],
        ' ',
      ),
      ...(next.acceptance ?? []).map(
        (row) => `${row.id} ${row.status?.verdict ?? 'no verdict'} ${row.text}`,
      ),
      ...(next.prepare
        ? [
            `prepare ${next.prepare.step} started (${next.prepare.completed}/${next.prepare.total} steps)`,
          ]
        : []),
    ];
  }
  const lines: string[] = [];
  for (const operation of next.operations) {
    const before = previous.operations.find((entry) => entry.id === operation.id);
    if (
      !before ||
      before.status !== operation.status ||
      before.stage !== operation.stage ||
      before.ownerAlive !== operation.ownerAlive
    ) {
      lines.push(
        `operation ${operation.command} ${operation.status}${operation.stage ? ` · ${operation.stage}` : ''} · log ${operation.logPath}`,
      );
    }
  }
  for (const step of next.prepare?.steps ?? []) {
    if (
      !previous.prepare?.steps.some((prior) => prior.id === step.id && prior.status === step.status)
    ) {
      lines.push(`prepare ${step.id} ${step.status} (${formatDuration(step.durationMs)})`);
    }
  }
  if (
    next.prepare &&
    (previous.prepare?.step !== next.prepare.step ||
      previous.prepare.startedAt !== next.prepare.startedAt)
  ) {
    lines.push(
      `prepare ${next.prepare.step} started (${next.prepare.completed}/${next.prepare.total} steps)`,
    );
  }
  const before = new Map(previous.checklist.map((row) => [row.number, row.checked]));
  const beforeAcceptance = new Map(
    previous.acceptance?.map((row) => [row.id, row.status?.verdict]),
  );
  for (const row of next.acceptance ?? []) {
    if (beforeAcceptance.get(row.id) !== row.status?.verdict || !beforeAcceptance.has(row.id)) {
      lines.push(`${row.id} ${row.status?.verdict ?? 'no verdict'} ${row.text}`);
    }
  }
  for (const row of next.checklist) {
    if (!row.checked || before.get(row.number) === true) continue;
    lines.push(
      `checked ${row.number} ${row.label}${row.durationMs !== undefined ? ` (${formatDuration(row.durationMs)})` : ''}`,
    );
  }
  const beforeUnits = new Map(previous.subtasks.map((unit) => [unit.id, unit]));
  for (const unit of next.subtasks) {
    const before = beforeUnits.get(unit.id);
    if (!before) {
      lines.push(
        `subtask ${unit.id} registered on step ${unit.parentStep} (${unit.rows.length} rows)`,
      );
    }
    const beforeRows = new Map((before?.rows ?? []).map((row) => [row.number, row.checked]));
    for (const row of unit.rows) {
      if (!row.checked || beforeRows.get(row.number) === true) continue;
      lines.push(`subtask ${unit.id} checked ${row.number} ${row.label}`);
    }
    if (before && before.status !== unit.status) {
      lines.push(`subtask ${unit.id} ${unit.status ?? 'unknown'}`);
    }
  }
  if (previous.signal?.step !== next.signal?.step && next.signal?.step) {
    lines.push(`step ${stepLabel(next.signal.step)}`);
  }
  if (previous.signal?.status !== next.signal?.status) {
    lines.push(`status ${next.signal?.status ?? 'unknown'}`);
  }
  // A long step shows its life through the journal, so a log watcher sees it too.
  if (next.lastCommand && previous.lastCommand?.at !== next.lastCommand.at) {
    lines.push(
      `command ${joinParts([next.lastCommand.command, next.lastCommand.subject], ' ')}${next.lastCommand.verdict ? ` ${next.lastCommand.verdict}` : ''}`,
    );
  }
  return lines;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours === 0) return `${minutes}:${seconds}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
}

function renderRow(
  row: TaskViewRow,
  currentStep: number | undefined,
  out: (style: string, text: string) => string,
): string {
  const marker = row.checked
    ? out('ok', '✓')
    : row.number === currentStep
      ? out('accent', '▶')
      : out('dim', '·');
  const timing =
    row.durationMs !== undefined
      ? formatDuration(row.durationMs)
      : row.runningMs !== undefined
        ? `${formatDuration(row.runningMs)} …`
        : '';
  const number = String(row.number).padStart(2);
  const label = timing ? row.label.padEnd(CHECKLIST_LABEL_LIMIT) : row.label;
  const text = row.checked ? out('dim', label) : out('bold', label);
  return ` ${marker} ${out('dim', number)} ${text}${timing ? ` ${out('dim', timing)}` : ''}`;
}

// The child header names the unit and its source, then its rows, all indented
// one level deeper than the parent row so the nesting is visible in a redraw.
function renderSubtask(
  unit: TaskViewSubtask,
  out: (style: string, text: string) => string,
): string[] {
  const done = unit.rows.filter((row) => row.checked).length;
  const header = joinParts([
    `${out('label', 'subtask')} ${out('accent', unit.id)}`,
    statusWord(out, unit.status),
    `${done}/${unit.rows.length}`,
    unit.source?.ref && out('dim', unit.source.ref),
  ]);
  const current = unit.rows.find((row) => !row.checked);
  return [
    `     ${header}`,
    ...unit.rows.map((row) => `    ${renderRow(row, current?.number, out)}`),
  ];
}

function libraryLabel(library: { name?: string; path: string }): string {
  const home = os.homedir();
  const location =
    home && library.path.startsWith(`${home}/`)
      ? `~${library.path.slice(home.length)}`
      : library.path;
  return library.name ? `${library.name}=${location}` : location;
}

function statusWord(
  out: (style: string, text: string) => string,
  status: string | undefined,
): string {
  if (!status) return out('dim', 'unknown');
  const style = ['pass', 'ready', 'complete', 'no-change'].includes(status)
    ? 'ok'
    : ['running', 'started'].includes(status)
      ? 'accent'
      : 'err';
  return out(style, status);
}

// SIGNAL.json records the whole checklist line as its step; the number is what
// a reader tracks between refreshes.
function stepLabel(step: string): string {
  return /^\s*(\d+)\./u.exec(step)?.[1] ?? step.trim();
}

function shortUdid(udid: string | undefined): string | undefined {
  if (!udid) return undefined;
  return `(${udid.split('-')[0]})`;
}

function joinParts(parts: Array<string | false | undefined>, separator = ' · '): string {
  return parts.filter((part): part is string => Boolean(part)).join(separator);
}

function renderOperations(view: TaskView): string[] {
  const active = view.operations.filter(
    (operation) => operation.status === 'running' && operation.ownerAlive,
  );
  const selected = active.length ? active : view.operations.slice(-1);
  return selected.flatMap((operation) => {
    const elapsed =
      Date.parse(operation.finishedAt ?? new Date().toISOString()) -
      Date.parse(operation.startedAt);
    const state =
      operation.status === 'running'
        ? operation.ownerAlive
          ? 'owner alive'
          : 'owner exited; outcome unknown'
        : operation.status;
    const age = operation.lastOutputAt
      ? formatDuration(Date.now() - Date.parse(operation.lastOutputAt)) + ' ago'
      : 'none recorded';
    const quoted = "'" + operation.logPath.replace(/'/g, "'\\''") + "'";
    return [
      `${operation.parentId ? '  ' : ''}operation ${operation.command} · ${state} · ${formatDuration(elapsed)} elapsed`,
      ...(operation.stage ? [`  stage ${operation.stage}`] : []),
      `  last output ${age}`,
      `  follow: tail -n 50 -F ${quoted}`,
    ];
  });
}
