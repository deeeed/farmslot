// The live task view behind `status --watch`, and the one-shot `status --task`
// that prints the same thing once. Task files supply worker progress; a bound
// run supplies its lifecycle through the authenticated control-plane read stream.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isTerminalWorkerSignalStatus } from '@farmslot/protocol';

import { color } from '../cli-color.js';
import { harnessContext, harnessContextField } from '../context-state.js';
import { listRunEvidenceHistory } from '../evidence-view.js';
import { loadRunEvidenceTemplate } from '../evidence-view-page.js';
import { harnessHost, withRecipeSignals } from '../host.js';
import { EXIT } from '../shared.js';
import { observeTaskRun, type TaskRunBinding, type TaskRunObserver } from '../task-run.js';
import {
  applyTaskRunLifecycle,
  CHECKLIST_LABEL_LIMIT,
  collectTaskView,
  findTaskDir,
  TASK_SILENT_AFTER_MS,
  type TaskView,
  type TaskViewRow,
  type TaskViewSubtask,
} from '../task-view.js';

import { recipeRunAttemptsRoot } from './run.js';
import { type RunEvidenceServer, serveRunEvidence } from './view.js';

const REFRESH_MS = 2000;
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const EVIDENCE_KEY = 'v';
/** Raw mode delivers Ctrl-C as this key instead of SIGINT. */
const CTRL_C = '\u0003';
const EVIDENCE_HINT = `${EVIDENCE_KEY}  open the live run evidence page`;
const EVIDENCE_MESSAGE_MS = 6000;
const CALL_START_SLACK_MS = 2000;

export interface StatusWatchOptions {
  target: string;
  taskDir?: string;
  json: boolean;
  watch: boolean;
  fast?: boolean;
}

export interface StatusWatchDeps {
  now: () => number;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  write: (text: string) => void;
  isTty: boolean;
  observeRun?: (binding: TaskRunBinding, signal?: AbortSignal) => Promise<TaskRunObserver>;
  /** Keypresses while a terminal watch redraws; returns the unsubscribe. */
  keys?: (onKey: (keys: string) => void) => () => void;
  /** Serves the live evidence pages of a folder of runs until the watch ends. */
  serveEvidence?: (runsRoot: string) => Promise<Pick<RunEvidenceServer, 'url' | 'close'>>;
  openUrl?: (url: string) => void;
}

export async function handleStatusTaskView(options: StatusWatchOptions): Promise<number> {
  const deps: StatusWatchDeps = {
    now: () => Date.now(),
    wait: (ms, signal) =>
      new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      }),
    write: (text) => process.stdout.write(text),
    isTty: Boolean(process.stdout.isTTY),
    ...(process.stdin.isTTY
      ? {
          keys: (onKey: (keys: string) => void) => {
            const stdin = process.stdin;
            stdin.setRawMode(true);
            stdin.setEncoding('utf8');
            stdin.on('data', onKey);
            stdin.resume();
            return () => {
              stdin.off('data', onKey);
              stdin.setRawMode(false);
              stdin.pause();
            };
          },
        }
      : {}),
    serveEvidence: async (dir) => {
      const project = harnessContext()?.project;
      const template = project?.viewer?.template
        ? await loadRunEvidenceTemplate(path.resolve(project.root, project.viewer.template))
        : undefined;
      return serveRunEvidence({ dir, ...(template ? { template } : {}) });
    },
    openUrl: (url) => {
      const opener =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'explorer'
            : 'xdg-open';
      const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
      // No browser opener on this machine: the footer already prints the URL to open by hand.
      child.on('error', () => undefined);
      child.unref();
    },
  };
  if (!options.watch || !deps.isTty) return runStatusWatch(options, deps);

  // The alternate-screen redraw owns the cursor until the loop ends, including
  // the Ctrl-C that is the normal way to leave it.
  const restore = () => deps.write(SHOW_CURSOR);
  deps.write(HIDE_CURSOR);
  try {
    return await runStatusWatch(options, deps);
  } finally {
    restore();
  }
}

export async function readTaskView(
  target: string,
  taskDir: string | undefined,
  now: number,
  observeRun: NonNullable<StatusWatchDeps['observeRun']> = observeTaskRun,
): Promise<TaskView> {
  const view = collectTaskView(target, taskDir, now);
  if (!view.run) return view;
  const binding = view.run;
  return withRecipeSignals(async (signal) => {
    const observer = await observeRun(binding, signal);
    try {
      signal.throwIfAborted();
      return applyTaskRunLifecycle(view, observer.current());
    } finally {
      await observer.close();
    }
  });
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
  let observer: TaskRunObserver | undefined;
  let observed: string | undefined;
  const control = new AbortController();
  const interrupt = () => control.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  process.on('SIGHUP', interrupt);
  // The evidence key works only where the watch redraws a terminal it owns.
  const interactive = options.watch && deps.isTty && !options.json;
  let wake = new AbortController();
  let wantEvidence = false;
  let evidence: { root: string; server: Pick<RunEvidenceServer, 'url' | 'close'> } | undefined;
  let evidenceLine: { text: string; ok: boolean; at: number } | undefined;
  const offKeys = interactive
    ? deps.keys?.((keys) => {
        for (const key of keys) {
          if (key === CTRL_C) control.abort();
          else if (key === EVIDENCE_KEY) {
            wantEvidence = true;
            wake.abort();
          }
        }
      })
    : undefined;
  // The newest run of the task this watch shows, served live: the task it was asked for or
  // sees in progress, else the writer's binding. Retained history never stands in for it.
  const openEvidence = async (view: TaskView): Promise<{ text: string; ok: boolean }> => {
    const root = recipeRunAttemptsRoot(options.target, {
      ...(options.taskDir ? { explicit: options.taskDir } : {}),
      ...(view.activity.ongoing && view.taskDir ? { active: view.taskDir } : {}),
    });
    const latestRun = fs.existsSync(root) ? listRunEvidenceHistory(root)[0] : undefined;
    let page = latestRun && { root, id: latestRun.id };
    let kind = 'run';
    if (!page) {
      // Before the first recipe run a task usually proves single actions with `call`; they
      // leave the same evidence package, so show the newest one made during this task.
      const startedAt = taskStartedAt(view.taskDir);
      page = newestEvidence(
        [
          ...(view.taskDir ? [path.join(view.taskDir, 'artifacts', 'calls')] : []),
          path.join(path.dirname(recipeRunAttemptsRoot(options.target, {})), 'calls'),
        ],
        startedAt,
      );
      kind = 'call';
    }
    if (!page)
      return {
        text: `${EVIDENCE_KEY}: no recipe run or call yet under ${root}; the evidence page opens after the first one`,
        ok: false,
      };
    if (evidence?.root !== page.root) {
      await evidence?.server.close();
      evidence = undefined;
      evidence = {
        root: page.root,
        server: await (deps.serveEvidence ?? defaultServeEvidence)(page.root),
      };
    }
    const url = `${evidence.server.url}runs/${encodeURIComponent(page.id)}/#story`;
    deps.openUrl?.(url);
    return {
      text: `evidence ${kind === 'call' ? `(latest call, no recipe run yet) ` : ''}${url}`,
      ok: true,
    };
  };
  try {
    for (;;) {
      if (control.signal.aborted) return EXIT.ok;
      const taskDir = options.taskDir ?? findTaskDir(options.target);
      let view = collectTaskView(options.target, taskDir, deps.now(), observer?.current());
      // Released task files do not end the lifecycle already bound by this watch.
      if (!view.run && previous?.run && observer && !view.template?.surface)
        view = applyTaskRunLifecycle(
          {
            ...previous,
            checkout: view.checkout,
            operations: view.operations,
            ...(view.isolation ? { isolation: view.isolation } : {}),
          },
          observer.current(),
        );
      const binding = view.run
        ? JSON.stringify([view.taskDir, view.run.id, view.run.project, view.run.slotId])
        : undefined;
      if (binding !== observed) {
        await observer?.close();
        observer = undefined;
        observed = binding;
        if (view.run && !options.fast)
          observer = await (deps.observeRun ?? observeTaskRun)(view.run, control.signal);
        view = applyTaskRunLifecycle(view, observer?.current());
      }
      if (control.signal.aborted) return EXIT.ok;
      if (wantEvidence) {
        wantEvidence = false;
        const result = await openEvidence(view).catch(
          // A page that cannot start is reported in the footer; the watch itself goes on.
          (error: unknown) => ({
            text: `evidence page failed: ${error instanceof Error ? error.message : String(error)}`,
            ok: false,
          }),
        );
        evidenceLine = { ...result, at: deps.now() };
      }
      const changes = changedLines(previous, view);

      if (options.json && !options.watch) {
        deps.write(`${JSON.stringify({ ...view, ...harnessContextField() }, null, 2)}\n`);
      } else if (options.json) {
        if (changes.length > 0)
          deps.write(`${JSON.stringify({ ...view, ...harnessContextField() })}\n`);
      } else if (options.watch && !deps.isTty) {
        for (const line of changes) deps.write(`${line}\n`);
      } else {
        // A key press answers in the footer, highlighted so it reads as a reaction,
        // and clears after a few seconds instead of looking like part of the page.
        if (evidenceLine && deps.now() - evidenceLine.at > EVIDENCE_MESSAGE_MS)
          evidenceLine = undefined;
        const footer =
          interactive && offKeys
            ? [
                '',
                ...(evidenceLine
                  ? [
                      color(
                        evidenceLine.ok ? 'ok' : 'warn',
                        `${evidenceLine.ok ? '✓' : '!'} ${evidenceLine.text}`,
                        {
                          stream: process.stdout,
                        },
                      ),
                    ]
                  : []),
                color('dim', EVIDENCE_HINT, { stream: process.stdout }),
              ]
            : [];
        deps.write(
          `${deps.isTty && options.watch ? CLEAR_SCREEN : ''}${[...renderTaskView(view, title, options.taskDir !== undefined, deps.isTty && options.watch ? process.stdout.columns : undefined), ...footer].join('\n')}\n`,
        );
      }

      previous = view;
      const terminal = view.run
        ? view.run.terminal === true
        : isTerminalWorkerSignalStatus(view.signal?.status);
      if (view.activity.ongoing) sawInProgress = true;
      if (!options.watch || (terminal && (sawInProgress || options.taskDir !== undefined)))
        return EXIT.ok;
      const changed = new AbortController();
      const offChange = observer?.onChange?.(() => changed.abort());
      wake = new AbortController();
      try {
        await deps.wait(REFRESH_MS, AbortSignal.any([control.signal, changed.signal, wake.signal]));
      } finally {
        offChange?.();
      }
    }
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    process.off('SIGHUP', interrupt);
    offKeys?.();
    await observer?.close();
    await evidence?.server.close();
  }
}

/** When the task started, from its handoff; unknown counts as the beginning of time. */
function taskStartedAt(taskDir: string | undefined): number {
  if (!taskDir) return Number.NEGATIVE_INFINITY;
  try {
    const handoff = JSON.parse(
      fs.readFileSync(path.join(taskDir, 'inputs', 'handoff.json'), 'utf8'),
    ) as {
      startedAt?: unknown;
    };
    const at = typeof handoff.startedAt === 'string' ? Date.parse(handoff.startedAt) : Number.NaN;
    return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

/**
 * The newest evidence package across `roots`, optionally only ones made at or after `since`.
 * A package's recorded start is compared exactly; without one, its file time is used with
 * slack, because file times come from a coarse clock that can trail the process clock.
 */
function newestEvidence(
  roots: string[],
  since = Number.NEGATIVE_INFINITY,
): { root: string; id: string } | undefined {
  let best: { root: string; id: string; at: string } | undefined;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of listRunEvidenceHistory(root)) {
      const made = entry.startedAt
        ? Date.parse(entry.startedAt) >= since
        : Date.parse(entry.updatedAt) >= since - CALL_START_SLACK_MS;
      if (!made) continue;
      const at = entry.startedAt ?? entry.updatedAt;
      if (!best || at > best.at) best = { root, id: entry.id, at };
    }
  }
  return best && { root: best.root, id: best.id };
}

function defaultServeEvidence(dir: string): Promise<RunEvidenceServer> {
  return serveRunEvidence({ dir });
}

// `explicitTask` is true when the caller named the task directory: its rows are
// shown even when it is not in progress, because that is what was asked for.
export function renderTaskView(
  view: TaskView,
  title: string,
  explicitTask = false,
  width?: number,
): string[] {
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
  // Titles often start with the ticket key; print the key once.
  const taskTitle = template?.title?.trim();
  const titleText =
    taskTitle && template?.ticket && taskTitle.startsWith(template.ticket)
      ? taskTitle.slice(template.ticket.length).replace(/^[\s:·-]+/, '')
      : taskTitle;
  const taskLine = joinParts(
    [template?.ticket && out('bold', template.ticket), titleText && out('info', titleText)],
    ' ',
  );

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

  // Sections, each under a colored heading, so the page reads as task, now,
  // acceptance and checklist instead of one stream of lines.
  if (showTask && (taskLine || templateLine || view.plan)) {
    lines.push('', taskLine ? `${out('label', 'task')}  ${taskLine}` : out('label', 'task'));
    if (templateLine) lines.push(`  ${templateLine}`);
    if (view.plan) {
      lines.push(
        `  ${joinParts([
          `plan ${view.plan.approved ? out('ok', 'approved') : out('warn', 'not matching its approval')} ${out('info', view.plan.path)}`,
          `sha ${out('dim', view.plan.sha256.slice(0, 8))}`,
          view.plan.approvedBy && `by ${out('info', view.plan.approvedBy)}`,
          view.plan.base && `base ${out('dim', view.plan.base)}`,
        ])}`,
      );
    }
    const step = view.checklist.find((row) => row.number === view.currentStep);
    if (step && !step.checked) {
      lines.push(
        `  step ${out('accent', '▶')} ${out('bold', `${step.number} ${step.label}`)}${step.runningMs !== undefined ? out('dim', ` · ${formatDuration(step.runningMs)}`) : ''}`,
      );
    }
  }

  const now = [
    ...(showTask && view.prepare
      ? [
          `  prepare ${out('info', view.prepare.step)} · ${view.prepare.completed}/${view.prepare.total} steps · ${formatDuration(view.prepare.elapsedMs)}`,
        ]
      : []),
    ...renderOperations(view, out),
  ];
  // A step that runs many harness commands without ticking a row is still live;
  // the journal is the proof, so show it.
  const last = view.lastCommand;
  if (showTask && last) {
    now.push(
      out(
        'dim',
        `  ${joinParts([
          `last command ${joinParts([last.command, last.subject], ' ')}`,
          last.verdict,
          last.ageMs !== undefined && `${formatDuration(last.ageMs)} ago`,
        ])}`,
      ),
    );
  }
  if (view.run)
    now.push(`  run ${view.run.id.slice(0, 8)} ${view.run.status ?? 'lifecycle unavailable'}`);
  if (now.length > 0) lines.push('', out('label', 'now'), ...now);

  if (showTask && view.acceptance?.length) lines.push('', ...renderAcceptanceLines(view, width));
  lines.push('');
  if (!view.activity.ongoing) {
    if (view.activity.reason !== 'run-unavailable')
      lines.push(out('warn', 'no ongoing task detected'));
    lines.push(out('dim', idleReason(view)));
    if (!view.taskDir || !explicitTask) return lines;
    lines.push('');
  }
  if (view.checklist.length > 0) lines.push(out('label', 'checklist'));
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

export function renderAcceptanceLines(
  view: Pick<TaskView, 'acceptance'>,
  width?: number,
): string[] {
  if (!view.acceptance?.length) return [];
  const out = (style: string, text: string) => color(style, text, { stream: process.stdout });
  const proven = view.acceptance.filter((row) => row.status?.verdict === 'proven').length;
  // The interactive watch keeps each criterion to one line; the full text stays in TASK.md.
  const fit = (text: string, used: number) => {
    if (!width) return text;
    const chars = [...text.replace(/\s+/g, ' ').trim()];
    const room = width - used - 1;
    if (room < 1) return '…';
    return chars.length > room ? `${chars.slice(0, room - 1).join('')}…` : chars.join('');
  };
  return [
    `${out('label', 'acceptance')}  ${proven}/${view.acceptance.length} proven`,
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
      return `  ${row.id} [${out(style, verdict)}] ${fit(row.text, row.id.length + verdict.length + 6)}`;
    }),
  ];
}

// One sentence saying why nothing is in progress, built only from allowlisted fields.
function idleReason(view: TaskView): string {
  if (!view.taskDir) return 'no task directory under temp/tasks';
  const { reason, idleMs } = view.activity;
  if (reason === 'foreign-task') return `task binding belongs to ${view.binding?.target}`;
  if (reason === 'run-unavailable') return `Next: farmslot run get ${view.run?.id}`;
  if (reason === 'no-task') return `${path.basename(view.taskDir)} holds no task files yet`;
  const what =
    reason === 'finished' ? (view.run?.status ?? view.signal?.status ?? 'finished') : 'silent';
  return joinParts(
    [
      `last task ${path.basename(view.taskDir)}: ${what}`,
      idleMs !== undefined && `last update ${formatDuration(idleMs)} ago`,
    ],
    ', ',
  );
}

// Piped output is a log: one line per thing that actually moved, never a redraw.
export function changedLines(previous: TaskView | undefined, next: TaskView): string[] {
  // A different task directory is a new context, announced like the first one.
  if (!previous || previous.taskDir !== next.taskDir || previous.run?.id !== next.run?.id) {
    return [
      joinParts(
        [
          path.basename(next.checkout.target),
          next.taskDir ? path.basename(next.taskDir) : 'no-task-dir',
          `status=${next.run?.status ?? (next.run ? 'unavailable' : next.signal?.status) ?? 'unknown'}`,
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
  if (previous.run?.status !== next.run?.status && next.run)
    lines.push(`run ${next.run.id.slice(0, 8)} ${next.run.status ?? 'lifecycle unavailable'}`);
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

function renderOperations(view: TaskView, out: (style: string, text: string) => string): string[] {
  const active = view.operations.filter(
    (operation) => operation.status === 'running' && operation.ownerAlive,
  );
  const elapsedOf = (operation: (typeof view.operations)[number]) =>
    formatDuration(
      Date.parse(operation.finishedAt ?? new Date().toISOString()) -
        Date.parse(operation.startedAt),
    );
  if (active.length === 0) {
    const last = view.operations.at(-1);
    if (!last) return [];
    const state = last.status === 'running' ? 'owner exited; outcome unknown' : last.status;
    return [out('dim', `  last operation ${last.command} · ${state} · ${elapsedOf(last)}`)];
  }
  // The innermost running operation is what is happening now; its parents are context.
  const innermost =
    active.find((operation) => !active.some((other) => other.parentId === operation.id)) ??
    active.at(-1)!;
  const lines: string[] = [];
  for (const operation of active) {
    if (operation === innermost) continue;
    lines.push(
      out(
        'dim',
        `  ${operation.command} · ${operation.stage ?? 'running'} · ${elapsedOf(operation)}`,
      ),
    );
  }
  const age = innermost.lastOutputAt
    ? `output ${formatDuration(Date.now() - Date.parse(innermost.lastOutputAt))} ago`
    : 'no output yet';
  lines.push(
    `  ${out('accent', '▶')} ${out('bold', innermost.command)} · ${out('info', innermost.stage ?? 'running')} · ${elapsedOf(innermost)} · ${out('dim', age)}`,
  );
  const quoted = "'" + innermost.logPath.replace(/'/g, "'\\''") + "'";
  lines.push(out('dim', `    log: tail -n 50 -F ${quoted}`));
  return lines;
}
