// `task init`: the one producer of a task directory.
//
// A harness (or an engineer) calls `taskInit` with what it knows and gets the
// same TASK.md, CHECKLIST.md, mark, and inputs/ a Farmslot dispatch writes. The
// gateway composes the same pieces (`renderTemplatePlaceholders`,
// `buildTaskDocument`, `writeTaskDir`) around its control-plane steps.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  type ExecutionTemplateReference,
  type ExecutionTemplateRunMode,
  renderTemplatePlaceholders,
  type TemplateProvenance,
  type WorkerTerminalContractDocument,
} from '@farmslot/protocol';

import { selectExecutionTemplate } from '../execution-template/select.js';
import {
  executionTemplateReference,
  readExecutionTemplateSnapshot,
} from '../execution-template/snapshot.js';
import type { ExecutionTemplateSource } from '../execution-template/types.js';

import {
  buildHandoffMetadata,
  buildTaskDocument,
  HANDOFF_INPUT,
  type HandoffExecutionTemplate,
  type HandoffMetadata,
  type HandoffSourceKind,
} from './task-document.js';
import { writeTaskDir, type WrittenTaskDir } from './write.js';

export * from './task-document.js';
export * from './write.js';
// The renderer lives in protocol; re-exported so CLI wrappers reach it through the runtime entry.
export { renderTemplatePlaceholders } from '@farmslot/protocol';

const require = createRequire(import.meta.url);

type TerminalContractResolver = (
  projectConfig: unknown,
  flowType: string,
  options?: { mode?: string; now?: string },
) => WorkerTerminalContractDocument;

/** Built-in terminal contract for a flow, as the gateway resolves it without project overrides. */
export function builtinTerminalContract(
  flow: string,
  options: { mode?: string; now?: string } = {},
): WorkerTerminalContractDocument {
  const { resolveWorkerTerminalContract } =
    require('../../scripts/worker-terminal-contract.cjs') as {
      resolveWorkerTerminalContract: TerminalContractResolver;
    };
  return resolveWorkerTerminalContract(null, flow, options);
}

export interface TaskInitTemplateSelection {
  sources: ExecutionTemplateSource[];
  explicitId?: string;
}

export interface TaskInitSpec {
  /** Task directory, absolute or relative to cwd; created when missing. */
  taskDir: string;
  /** How the worker should refer to the task dir (`TASK_DIR` placeholder); defaults to `taskDir` as given. */
  taskDirLabel?: string;
  flow: string;
  runMode: ExecutionTemplateRunMode;
  platform: string;
  domain?: string;
  template: TaskInitTemplateSelection;
  task: {
    title: string;
    description?: string;
    acceptanceCriteria?: ReadonlyArray<string>;
    sourceKind: HandoffSourceKind;
    ticket?: string;
    sourceRef?: string;
  };
  handoff: {
    surface: string;
    project: string;
    attemptId?: string;
    repo?: string;
    startedAt?: string;
  };
  /** Extra `{{PLACEHOLDER}}` values for the checklist and task block. */
  vars?: Record<string, string>;
  modePreamble?: string;
  /** Addendum template inserted before the checklist pointer; rendered with the same vars as the checklist. */
  addendum?: string | null;
  markCommand?: string;
  terminalContract?: WorkerTerminalContractDocument;
  bugInput?: unknown;
}

export interface TaskInitResult extends WrittenTaskDir {
  executionTemplate: HandoffExecutionTemplate;
  handoffMetadata: HandoffMetadata;
}

export async function taskInit(spec: TaskInitSpec): Promise<TaskInitResult> {
  const selected = selectExecutionTemplate({
    sources: spec.template.sources,
    flow: spec.flow,
    platform: spec.platform,
    runMode: spec.runMode,
    ...(spec.domain ? { domain: spec.domain } : {}),
    ...(spec.template.explicitId ? { explicitId: spec.template.explicitId } : {}),
  });
  const taskDirLabel = spec.taskDirLabel ?? spec.taskDir;
  const vars: Record<string, string> = {
    TICKET: spec.task.ticket ?? '',
    TITLE: spec.task.title,
    FLOW: spec.flow,
    MODE: spec.runMode,
    PLATFORM: spec.platform,
    ...(spec.domain ? { DOMAIN: spec.domain } : {}),
    TEMPLATE: selected.entry.id,
    TASK_DIR: taskDirLabel,
    ...(spec.task.sourceRef
      ? /^https?:\/\//.test(spec.task.sourceRef)
        ? { TICKET_URL: spec.task.sourceRef }
        : { SOURCE_REF: spec.task.sourceRef }
      : {}),
    ...(spec.vars ?? {}),
  };

  const source = `Execution template ${selected.entry.id} (${selected.entry.sourceId})`;
  const checklistMarkdown = renderTemplatePlaceholders(
    readExecutionTemplateSnapshot(selected.entry).markdown,
    vars,
    source,
  );
  const reference = executionTemplateReference(selected.entry, checklistMarkdown);
  const executionTemplate: HandoffExecutionTemplate = {
    selectionReason: selected.reason,
    ...reference,
  };

  const terminalContract =
    spec.terminalContract ?? builtinTerminalContract(spec.flow, { mode: spec.runMode });
  const handoffMetadata = buildHandoffMetadata({
    attemptId: spec.handoff.attemptId ?? randomUUID(),
    surface: spec.handoff.surface,
    project: spec.handoff.project,
    flow: spec.flow,
    repo: spec.handoff.repo,
    domain: spec.domain,
    title: spec.task.title,
    sourceKind: spec.task.sourceKind,
    ticket: spec.task.ticket,
    sourceRef: spec.task.sourceRef,
    terminalContract,
    startedAt: spec.handoff.startedAt,
    executionTemplate,
  });

  const taskMarkdown = buildTaskDocument({
    flowType: spec.flow,
    modePreamble: spec.modePreamble ?? '',
    vars,
    description: spec.task.description ?? '',
    acceptanceCriteria: spec.task.acceptanceCriteria ?? [],
    addendum: spec.addendum
      ? renderTemplatePlaceholders(spec.addendum, vars, 'Task document addendum')
      : null,
    hasTicketData: spec.bugInput !== undefined,
  });

  const written = await writeTaskDir({
    taskDir: spec.taskDir,
    taskMarkdown,
    checklistMarkdown,
    markCommand: spec.markCommand,
    handoff: handoffMetadata,
    terminalContract,
    bugInput: spec.bugInput,
  });
  return { ...written, executionTemplate, handoffMetadata };
}

export interface TaskProvenance {
  executionTemplate?: HandoffExecutionTemplate | ExecutionTemplateReference;
  templateProvenance?: Omit<TemplateProvenance, 'executionTemplate'>;
}

/**
 * Selected-template provenance for a task dir. Reads `inputs/handoff.json`;
 * falls back to the pre-0.9 `inputs/template-provenance.json` for task dirs
 * written before the merge. Drop the fallback next release.
 */
export function readTaskProvenance(taskDir: string): TaskProvenance | null {
  const handoffPath = path.join(taskDir, HANDOFF_INPUT);
  if (existsSync(handoffPath)) {
    const handoff = JSON.parse(readFileSync(handoffPath, 'utf-8')) as HandoffMetadata;
    if (handoff.executionTemplate || handoff.templateProvenance) {
      return {
        ...(handoff.executionTemplate ? { executionTemplate: handoff.executionTemplate } : {}),
        ...(handoff.templateProvenance ? { templateProvenance: handoff.templateProvenance } : {}),
      };
    }
  }
  const legacyPath = path.join(taskDir, 'inputs', 'template-provenance.json');
  if (!existsSync(legacyPath)) return null;
  const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8')) as TemplateProvenance;
  const { executionTemplate, ...templateProvenance } = legacy;
  return { ...(executionTemplate ? { executionTemplate } : {}), templateProvenance };
}
