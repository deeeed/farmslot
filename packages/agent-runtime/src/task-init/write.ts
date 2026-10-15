// The task-dir writer: the only code that lays out a task directory. A control
// plane and a harness both call it, so the two surfaces cannot drift.

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  EXECUTION_CHECKLIST_DOCUMENT,
  WORKER_TERMINAL_CONTRACT_INPUT,
  type WorkerTerminalContractDocument,
} from '@farmslot/protocol';

import { installedRuntimeScriptCommand } from './runtime-command.js';
import {
  BUG_INPUT,
  HANDOFF_INPUT,
  type HandoffMetadata,
  normalizeAcceptanceCriteria,
} from './task-document.js';

export { quoteMarkCommandWord } from './runtime-command.js';

export const TASK_DOCUMENT = 'TASK.md';
export const MARK_SHIM = 'mark';
/** Whole-command override for existing unfrozen mark shims. */
export const MARK_COMMAND_ENV = 'FARMSLOT_MARK_CMD';

const require = createRequire(import.meta.url);
const { deterministicChecks } = require('../../scripts/worker-terminal-contract.cjs') as {
  deterministicChecks: {
    freeze: (
      contract: WorkerTerminalContractDocument,
      markdown: string,
      checklist: string,
      commands?: Record<string, string>,
    ) => WorkerTerminalContractDocument;
  };
};

/** Generic default: this package's mark engine. A control plane or harness passes its own. */
export function defaultMarkCommand(): string {
  return installedRuntimeScriptCommand('mark-checklist-step.cjs');
}

/**
 * The `mark` shim. One env override, one recorded default; `markCommand` is a
 * whole command line and stays unquoted so multi-word commands split and `$HOME`
 * expands on the machine that runs it.
 */
export function buildMarkShim(markCommand: string, fixed = false): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    fixed
      ? `exec ${markCommand} "$DIR" "$@"`
      : `exec \${${MARK_COMMAND_ENV}:-${markCommand}} "$DIR" "$@"`,
    '',
  ].join('\n');
}

export interface WriteTaskDirInput {
  /** Absolute task directory; created when missing. */
  taskDir: string;
  taskMarkdown: string;
  /** null when the caller already wrote CHECKLIST.md (lightweight interactive dev). */
  checklistMarkdown: string | null;
  markCommand?: string;
  /** Frozen tasks always enter their verified CLI gates. */
  fixedMarkCommand?: boolean;
  handoff: HandoffMetadata;
  terminalContract: WorkerTerminalContractDocument;
  /** Project command references made available to the selected checklist. */
  deterministicCommands?: Record<string, string>;
  /** Ticket data as fetched, written to inputs/bug-input.json when present. */
  bugInput?: unknown;
}

export interface WrittenTaskDir {
  taskDir: string;
  taskDocument: string;
  checklist: string | null;
  mark: string;
  handoff: string;
  terminalContract: string;
  bugInput: string | null;
}

export async function writeTaskDir(input: WriteTaskDirInput): Promise<WrittenTaskDir> {
  const taskDir = path.resolve(input.taskDir);
  await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });

  const taskDocument = path.join(taskDir, TASK_DOCUMENT);
  await writeFile(taskDocument, input.taskMarkdown, 'utf-8');

  const terminalContract = deterministicChecks.freeze(
    input.terminalContract,
    input.checklistMarkdown ?? input.taskMarkdown,
    input.checklistMarkdown === null ? TASK_DOCUMENT : EXECUTION_CHECKLIST_DOCUMENT,
    input.deterministicCommands,
  );
  return { taskDocument, ...(await ensureTaskRuntime({ ...input, terminalContract }, true)) };
}

/** Initialize existing author-owned tasks through the same runtime producer. */
export async function ensureTaskRuntime(
  input: Omit<WriteTaskDirInput, 'taskMarkdown'>,
  replaceExisting = false,
): Promise<Omit<WrittenTaskDir, 'taskDocument'>> {
  const taskDir = path.resolve(input.taskDir);
  if (input.checklistMarkdown !== null) {
    input = {
      ...input,
      terminalContract: deterministicChecks.freeze(
        input.terminalContract,
        input.checklistMarkdown,
        EXECUTION_CHECKLIST_DOCUMENT,
        input.deterministicCommands,
      ),
    };
  }
  if (!replaceExisting) {
    const existing = async (name: string) => {
      try {
        return JSON.parse(await readFile(path.join(taskDir, name), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const handoff = await existing(HANDOFF_INPUT);
    const identity = (value: HandoffMetadata) => ({
      schemaVersion: value.schemaVersion,
      project: value.project,
      flow: value.flow,
      domain: value.domain ?? '',
      ticket: value.task?.ticket,
      criteria: normalizeAcceptanceCriteria(value.task?.acceptanceCriteria ?? []),
      report: value.report,
      learnings: value.learnings,
    });
    if (handoff !== undefined && !isDeepStrictEqual(identity(handoff), identity(input.handoff)))
      throw new Error(
        'Existing task handoff differs from the requested flow, identity or acceptance criteria. Use a matching task or a new task directory.',
      );
    const contract = await existing(WORKER_TERMINAL_CONTRACT_INPUT);
    const contractIdentity = ({
      resolvedAt: _resolvedAt,
      ...value
    }: WorkerTerminalContractDocument) => value;
    if (
      contract !== undefined &&
      !isDeepStrictEqual(contractIdentity(contract), contractIdentity(input.terminalContract))
    )
      throw new Error(
        'Existing worker terminal contract differs from the requested contract. Use a matching task or a new task directory.',
      );
  }
  await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
  await mkdir(path.join(taskDir, 'artifacts'), { recursive: true });
  const write = async (file: string, text: string): Promise<boolean> => {
    try {
      await writeFile(file, text, { encoding: 'utf8', flag: replaceExisting ? 'w' : 'wx' });
      return true;
    } catch (error) {
      if (!replaceExisting && (error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  };

  let checklist: string | null = null;
  if (input.checklistMarkdown !== null) {
    checklist = path.join(taskDir, EXECUTION_CHECKLIST_DOCUMENT);
    await write(checklist, input.checklistMarkdown);
  }

  const mark = path.join(taskDir, MARK_SHIM);
  if (
    await write(
      mark,
      buildMarkShim(input.markCommand ?? defaultMarkCommand(), input.fixedMarkCommand),
    )
  )
    await chmod(mark, 0o755);
  else if (input.markCommand !== undefined) {
    const current = await readFile(mark, 'utf8');
    // Refresh only the shared generated shim, leaving authored executables intact.
    if (
      current.startsWith('#!/usr/bin/env bash\nset -euo pipefail\nDIR=') &&
      current.includes('${FARMSLOT_MARK_CMD:-')
    )
      await writeFile(mark, buildMarkShim(input.markCommand, input.fixedMarkCommand), 'utf8');
  }

  const handoff = path.join(taskDir, HANDOFF_INPUT);
  await write(handoff, `${JSON.stringify(input.handoff, null, 2)}\n`);

  const terminalContract = path.join(taskDir, WORKER_TERMINAL_CONTRACT_INPUT);
  await write(terminalContract, `${JSON.stringify(input.terminalContract, null, 2)}\n`);

  let bugInput: string | null = null;
  if (input.bugInput !== undefined) {
    bugInput = path.join(taskDir, BUG_INPUT);
    await write(bugInput, `${JSON.stringify(input.bugInput, null, 2)}\n`);
  }

  return { taskDir, checklist, mark, handoff, terminalContract, bugInput };
}
