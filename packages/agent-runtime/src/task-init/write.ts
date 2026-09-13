// The task-dir writer: the only code that lays out a task directory. A control
// plane and a harness both call it, so the two surfaces cannot drift.

import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHECKLIST_TARGET_MANIFEST,
  EXECUTION_CHECKLIST_DOCUMENT,
  WORKER_TERMINAL_CONTRACT_INPUT,
  type WorkerTerminalContractDocument,
} from '@farmslot/protocol';

import { BUG_INPUT, HANDOFF_INPUT, type HandoffMetadata } from './task-document.js';

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
  /**
   * Transition only: also write `checklist-target.json` with the default target so
   * a mark engine older than 0.9 (which fails closed without it) keeps working on
   * slots not yet redeployed. Absent means the same thing. Remove next release.
   */
  writeChecklistManifest?: boolean;
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

  let checklist: string | null = null;
  if (input.checklistMarkdown !== null) {
    checklist = path.join(taskDir, EXECUTION_CHECKLIST_DOCUMENT);
    await writeFile(checklist, input.checklistMarkdown, 'utf-8');
  }

  const mark = path.join(taskDir, MARK_SHIM);
  await writeFile(mark, buildMarkShim(input.markCommand ?? defaultMarkCommand()), 'utf-8');
  await chmod(mark, 0o755);

  const handoff = path.join(taskDir, HANDOFF_INPUT);
  await writeFile(handoff, `${JSON.stringify(input.handoff, null, 2)}\n`, 'utf-8');

  const terminalContract = path.join(taskDir, WORKER_TERMINAL_CONTRACT_INPUT);
  await writeFile(
    terminalContract,
    `${JSON.stringify(input.terminalContract, null, 2)}\n`,
    'utf-8',
  );

  if (input.writeChecklistManifest) {
    const checklistName = existsSync(path.join(taskDir, EXECUTION_CHECKLIST_DOCUMENT))
      ? EXECUTION_CHECKLIST_DOCUMENT
      : TASK_DOCUMENT;
    await writeFile(
      path.join(taskDir, CHECKLIST_TARGET_MANIFEST),
      `${JSON.stringify({ checklist: checklistName, signal: 'SIGNAL.json' }, null, 2)}\n`,
      'utf-8',
    );
  }

  let bugInput: string | null = null;
  if (input.bugInput !== undefined) {
    bugInput = path.join(taskDir, BUG_INPUT);
    await writeFile(bugInput, `${JSON.stringify(input.bugInput, null, 2)}\n`, 'utf-8');
  }

  return { taskDir, taskDocument, checklist, mark, handoff, terminalContract, bugInput };
}
