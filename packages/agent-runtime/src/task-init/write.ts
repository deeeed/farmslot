// The task-dir writer: the only code that lays out a task directory. A control
// plane and a harness both call it, so the two surfaces cannot drift.

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  EXECUTION_CHECKLIST_DOCUMENT,
  WORKER_TERMINAL_CONTRACT_INPUT,
  type WorkerTerminalContractDocument,
} from '@farmslot/protocol';

import {
  BUG_INPUT,
  HANDOFF_INPUT,
  type HandoffMetadata,
  normalizeAcceptanceCriteria,
} from './task-document.js';

export const TASK_DOCUMENT = 'TASK.md';
export const MARK_SHIM = 'mark';
/** Whole-command env override honoured by every `mark` shim. */
export const MARK_COMMAND_ENV = 'FARMSLOT_MARK_CMD';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Quote one word for the shim's default command: double quotes keep spaces
 * together while `$HOME` (a remote slot's home) still expands.
 */
export function quoteMarkCommandWord(word: string): string {
  return `"${word.replace(/(["\\`])/g, '\\$1')}"`;
}

/** Generic default: this package's mark engine. A control plane or harness passes its own. */
export function defaultMarkCommand(): string {
  return `node ${quoteMarkCommandWord(path.join(packageRoot, 'scripts', 'mark-checklist-step.cjs'))}`;
}

/**
 * The `mark` shim. One env override, one recorded default; `markCommand` is a
 * whole command line and stays unquoted so multi-word commands split and `$HOME`
 * expands on the machine that runs it.
 */
export function buildMarkShim(markCommand: string): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    `exec \${${MARK_COMMAND_ENV}:-${markCommand}} "$DIR" "$@"`,
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
  handoff: HandoffMetadata;
  terminalContract: WorkerTerminalContractDocument;
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

  return { taskDocument, ...(await ensureTaskRuntime(input, true)) };
}

/** Initialize existing author-owned tasks through the same runtime producer. */
export async function ensureTaskRuntime(
  input: Omit<WriteTaskDirInput, 'taskMarkdown'>,
  replaceExisting = false,
): Promise<Omit<WrittenTaskDir, 'taskDocument'>> {
  const taskDir = path.resolve(input.taskDir);
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
  if (await write(mark, buildMarkShim(input.markCommand ?? defaultMarkCommand())))
    await chmod(mark, 0o755);
  else if (input.markCommand !== undefined) {
    const current = await readFile(mark, 'utf8');
    // Refresh only the shared generated shim, leaving authored executables intact.
    if (
      current.startsWith('#!/usr/bin/env bash\nset -euo pipefail\nDIR=') &&
      current.includes('${FARMSLOT_MARK_CMD:-')
    )
      await writeFile(mark, buildMarkShim(input.markCommand), 'utf8');
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
