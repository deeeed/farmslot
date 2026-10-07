// checklist — expose @farmslot/agent-runtime checklist progress through the
// host's front door: `mark <task-dir> <step>` and, when the host stages them,
// `closeout <task-dir>`.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { HANDOFF_INPUT } from '@farmslot/agent-runtime';
import {
  enumerateChecklistCheckboxes,
  isTerminalWorkerSignalStatus,
  type SubtaskIndex,
} from '@farmslot/protocol';

import { harnessHost } from '../host.js';
import { EXIT } from '../shared.js';

const require = createRequire(import.meta.url);
const MARK_SCRIPT = require.resolve('@farmslot/agent-runtime/scripts/mark-checklist-step.cjs');
// The runtime owns which checklist and signal a task directory marks. An absent
// checklist-target.json means the worker default; only a role switch writes it,
// and an invalid one is an error the resolver raises rather than a silent
// fallback to a different file than the one gateway progress counts.
const { resolveChecklistPaths } =
  require('@farmslot/agent-runtime/scripts/checklist-target.cjs') as {
    resolveChecklistPaths: (taskDir: string) => {
      taskPath: string;
      signalPath: string;
      target: { checklist: string; signal: string };
    };
  };
const { readSubtaskIndex, SubtaskRefusal } =
  require('@farmslot/agent-runtime/scripts/subtask-unit.cjs') as {
    readSubtaskIndex: (taskDir: string) => SubtaskIndex | null;
    SubtaskRefusal: new (...args: unknown[]) => Error & { code: number };
  };

const CHECKLIST_VALUE_OPTIONS = new Set([
  '--reason',
  '--checklist',
  '--signal',
  '--config',
  '--destination',
  '--metadata',
]);

/** A checklist row whose label matches `label` cannot be marked until `ready`. */
export interface ChecklistStepGate {
  label: RegExp;
  // Prints its own recovery and returns false while the step is blocked.
  ready(taskDir: string, step: string): boolean;
}

export interface ChecklistCommandOptions {
  // Stage the task's learning package (`closeout <task-dir>`, and after a
  // successful complete/no-change mark). Absent: closeout is not offered.
  closeout?(
    taskDir: string,
    args: readonly string[],
    stdio: 'inherit' | 'pipe',
  ):
    | SpawnSyncReturns<string>
    | {
        status: number | null;
        error?: Error;
      };
  // Gates on numbered steps.
  stepGates?: readonly ChecklistStepGate[];
  // Before a `complete` mark is forwarded (teach the closure artifacts, say).
  beforeComplete?(taskDir: string): void;
}

function parseChecklistArgv(argv: string[]): {
  action?: string;
  taskDir?: string;
  step?: string;
  forwarded: string[];
} {
  const positionals: Array<{ index: number; value: string }> = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg.startsWith('-')) {
      const option = arg.split('=', 1)[0] ?? arg;
      if (CHECKLIST_VALUE_OPTIONS.has(option) && !arg.includes('=')) index += 1;
      continue;
    }
    positionals.push({ index, value: arg });
  }
  const consumed = new Set(positionals.slice(0, 2).map(({ index }) => index));
  return {
    action: positionals[0]?.value,
    taskDir: positionals[1]?.value,
    step: positionals[2]?.value,
    forwarded: argv.filter((_, index) => !consumed.has(index)),
  };
}

function stageLearningPackage(
  taskDir: string,
  step: string | undefined,
  markArgs: string[],
  options: ChecklistCommandOptions,
): void {
  if (
    !options.closeout ||
    !['complete', 'no-change'].includes(step ?? '') ||
    markArgs.includes('--skip-learnings') ||
    !fs.existsSync(path.join(taskDir, HANDOFF_INPUT))
  ) {
    return;
  }
  try {
    const result = options.closeout(taskDir, ['--json'], 'pipe');
    if (result.status === 0) return;
  } catch {
    // Learning capture cannot change a successful task verdict.
  }
  console.error(
    `Warning: learning capture could not be staged; rerun: ${harnessHost().name} checklist closeout ${taskDir}; task verdict is unchanged.`,
  );
}

function terminalSignalStatus(taskDir: string): string | null {
  const { signalPath } = resolveChecklistPaths(taskDir);
  let signal: { status?: string };
  try {
    signal = JSON.parse(fs.readFileSync(signalPath, 'utf8')) as { status?: string };
  } catch {
    // No signal yet (or a half-written one): the task has no terminal verdict to
    // preserve, which is the normal state before the first mark.
    return null;
  }
  return isTerminalWorkerSignalStatus(signal.status) ? (signal.status ?? null) : null;
}

function preserveTerminalSignal(taskDir: string, step: string | undefined): boolean {
  if (step !== 'start' && numericMarkStep(step) === null) return false;

  const status = terminalSignalStatus(taskDir);
  if (!status) return false;

  console.log(`signal already terminal: status=${status}; ignoring non-terminal mark ${step}`);
  return true;
}

function numericMarkStep(step: string | undefined): number | null {
  const stepNumber = Number(step);
  return Number.isInteger(stepNumber) && stepNumber >= 1 ? stepNumber : null;
}

// Step N is the box `mark N` ticks: the protocol enumeration, so a gate reads the
// same row the mark writes (skip sections and <details> included).
function stepGatesReady(
  taskDir: string,
  step: string | undefined,
  gates: readonly ChecklistStepGate[],
  parentChecklist?: string,
): boolean {
  const stepNumber = numericMarkStep(step);
  if (stepNumber === null || gates.length === 0) return true;

  const taskPath = parentChecklist
    ? path.join(taskDir, parentChecklist)
    : resolveChecklistPaths(taskDir).taskPath;
  let checklist = '';
  try {
    checklist = fs.readFileSync(taskPath, 'utf8');
  } catch {
    // No checklist file means no step declares a gate; marking is unblocked.
    return true;
  }
  const row = enumerateChecklistCheckboxes(checklist).find(
    (item) => item.stepNumber === stepNumber,
  );
  if (!row) return true;
  return gates.every((gate) => !gate.label.test(row.rawLabel) || gate.ready(taskDir, String(step)));
}

export async function handleChecklist(
  argv: string[],
  options: ChecklistCommandOptions = {},
): Promise<number> {
  const host = harnessHost().name;
  const usage = options.closeout
    ? `${host} checklist <mark <task-dir> <step> | closeout <task-dir>> [options]`
    : `${host} checklist mark <task-dir> <step> [options]`;
  const { action, taskDir, step, forwarded } = parseChecklistArgv(argv);
  if (!taskDir) {
    console.error(`usage: ${usage}`);
    return EXIT.usage;
  }

  const resolvedTaskDir = path.resolve(taskDir);
  if (action === 'closeout' && options.closeout) {
    const result = options.closeout(resolvedTaskDir, forwarded, 'inherit');
    if (result.error) {
      console.error(`${host} checklist closeout: ${result.error.message}`);
      return EXIT.runtime;
    }
    return result.status ?? EXIT.runtime;
  }
  if (action !== 'mark' || !step) {
    console.error(`usage: ${usage}`);
    return EXIT.usage;
  }
  if (preserveTerminalSignal(resolvedTaskDir, step)) return EXIT.ok;
  const gates = options.stepGates ?? [];
  if (step === 'sub' && forwarded[2] === 'complete') {
    try {
      const unit = readSubtaskIndex(resolvedTaskDir)?.units.find(
        (candidate) => candidate.id === forwarded[1],
      );
      if (
        unit &&
        !stepGatesReady(
          resolvedTaskDir,
          String(unit.parent.stepNumber),
          gates,
          unit.parent.checklist,
        )
      ) {
        return EXIT.runtime;
      }
    } catch (error) {
      if (!(error instanceof SubtaskRefusal)) throw error;
      console.error(error.message);
      return error.code;
    }
  }
  if (!stepGatesReady(resolvedTaskDir, step, gates)) return EXIT.runtime;
  if (step === 'complete') options.beforeComplete?.(resolvedTaskDir);

  const result = spawnSync(process.execPath, [MARK_SCRIPT, resolvedTaskDir, ...forwarded], {
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`${host} checklist mark: ${result.error.message}`);
    return EXIT.runtime;
  }
  const status = result.status ?? EXIT.runtime;
  if (status === EXIT.ok) {
    stageLearningPackage(resolvedTaskDir, step, forwarded, options);
  }
  return status;
}
