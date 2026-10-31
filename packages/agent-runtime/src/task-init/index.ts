// `task init`: the one producer of a task directory.
//
// A harness (or an engineer) calls `taskInit` with what it knows and gets the
// same TASK.md, CHECKLIST.md, mark, and inputs/ a Farmslot dispatch writes. The
// gateway supplies control-plane data; the node calls this producer with its
// own retained installation.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
import type {
  ExecutionTemplateSource,
  SelectedExecutionTemplate,
} from '../execution-template/types.js';

import { applyArtifactOnlyTaskPolicy, type ArtifactOnlyReplay } from './artifact-only.js';
import {
  completeInterruptedRepin,
  repinTaskExecution,
  retainTaskExecution,
  type TaskExecutionInput,
  taskExecutionPin,
  type TaskExecutionProvenance,
} from './execution-provenance.js';
import { installedTaskCommands, retainedMarkCommand } from './runtime-command.js';
import {
  buildBranchUpdateGuardCommand,
  buildBranchUpdateInstructions,
  buildHandoffMetadata,
  buildTaskDocument,
  HANDOFF_INPUT,
  type HandoffExecutionTemplate,
  type HandoffMetadata,
  type HandoffSourceKind,
} from './task-document.js';
import {
  buildMarkShim,
  MARK_SHIM,
  writeTaskDir,
  type WriteTaskDirInput,
  type WrittenTaskDir,
} from './write.js';

export { applyArtifactOnlyTaskPolicy } from './artifact-only.js';
export * from './artifact-only-guard.js';
export * from './branch-update.js';
export * from './discover.js';
export {
  type TaskExecutionInput,
  type TaskExecutionProvenance,
  type TaskRecipeBindingIdentity,
  verifyTaskExecutionProvenance,
} from './execution-provenance.js';
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
  selection?: SelectedExecutionTemplate;
}

export interface TaskInitSpec {
  /** Task directory, absolute or relative to cwd; created when missing. */
  taskDir: string;
  /** How the worker should refer to the task dir (`TASK_DIR` placeholder); defaults to `taskDir` as given. */
  taskDirLabel?: string;
  flow: string;
  /**
   * Run mode of this run. Templates carry none; it selects project default
   * rules (`when.runMode`), fills `{{MODE}}`, and picks the terminal contract.
   */
  runMode?: ExecutionTemplateRunMode;
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
    affectedArea?: string;
    screenshotsMarkdown?: string;
    commentsMarkdown?: string;
    linkedTicketsMarkdown?: string;
    linkedDescriptionsMarkdown?: string;
    commentSummaryMarkdown?: string;
  };
  handoff: {
    surface: string;
    project: string;
    attemptId?: string;
    repo?: string;
    startedAt?: string;
    templateProvenance?: HandoffMetadata['templateProvenance'];
  };
  /** Extra `{{PLACEHOLDER}}` values for the checklist and task block. */
  vars?: Record<string, string>;
  modePreamble?: string;
  /** Addendum template inserted before the checklist pointer; rendered with the same vars as the checklist. */
  addendum?: string | null;
  markCommand?: string;
  /** Root CLI invocations retain tooling before the task marker is emitted. */
  execution?: TaskExecutionInput;
  terminalContract?: WorkerTerminalContractDocument;
  bugInput?: unknown;
  operatorPlan?: string;
  taskDocumentAdditions?: string;
  artifactOnlyReplay?: ArtifactOnlyReplay;
  authored?: Pick<WriteTaskDirInput, 'taskMarkdown' | 'checklistMarkdown' | 'handoff'>;
}

export interface TaskInitResult extends WrittenTaskDir {
  executionTemplate: HandoffExecutionTemplate;
  handoffMetadata: HandoffMetadata;
  executionProvenance?: TaskExecutionProvenance;
}

export async function taskInit(spec: TaskInitSpec): Promise<TaskInitResult> {
  const selected =
    spec.template.selection ??
    selectExecutionTemplate({
      sources: spec.template.sources,
      flow: spec.flow,
      platform: spec.platform,
      ...(spec.runMode ? { runMode: spec.runMode } : {}),
      ...(spec.domain ? { domain: spec.domain } : {}),
      ...(spec.template.explicitId ? { explicitId: spec.template.explicitId } : {}),
    });
  if (
    spec.authored &&
    (spec.authored.handoff.project !== spec.handoff.project ||
      spec.authored.handoff.flow !== spec.flow)
  )
    throw new Error('Authored task handoff belongs to a different project or flow.');
  const templateRoot =
    spec.template.sources.find((source) => source.id === selected.entry.sourceId)?.root ??
    path.dirname(selected.entry.path);
  const taskDirLabel = spec.taskDirLabel ?? spec.taskDir;
  const taskCommands = spec.execution
    ? installedTaskCommands((file) => {
        const relative = path.relative(spec.execution!.distributionRoot, file);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          throw new Error('The task runtime must belong to the retained CLI distribution.');
        return path.join(taskExecutionPin(spec.taskDir, spec.execution!), 'cli', relative);
      })
    : installedTaskCommands();
  for (const key of Object.keys(taskCommands)) {
    if (spec.execution && spec.vars?.[key] !== undefined)
      throw new Error(
        `Task variable ${key} is derived from retained tooling and cannot be overridden.`,
      );
  }
  const vars: Record<string, string> = {
    TICKET: spec.task.ticket ?? '',
    TITLE: spec.task.title,
    FLOW: spec.flow,
    // Same rule as DOMAIN below: an unset value supplies no placeholder, so a
    // template that spells {{MODE}} fails the guard instead of rendering a
    // made-up default.
    ...(spec.runMode ? { MODE: spec.runMode } : {}),
    PLATFORM: spec.platform,
    ...(spec.domain ? { DOMAIN: spec.domain } : {}),
    TEMPLATE: selected.entry.id,
    TASK_DIR: taskDirLabel,
    ...taskCommands,
    ...(spec.task.sourceRef
      ? /^https?:\/\//.test(spec.task.sourceRef)
        ? { TICKET_URL: spec.task.sourceRef }
        : { SOURCE_REF: spec.task.sourceRef }
      : {}),
    ...(spec.vars ?? {}),
  };
  if (vars.PUBLICATION_BASE?.trim()) {
    vars.BRANCH_UPDATE_GUARD_CMD = buildBranchUpdateGuardCommand(vars);
    vars.BRANCH_UPDATE_PUSH_CMD = buildBranchUpdateGuardCommand(vars, 'push');
    vars.BRANCH_UPDATE_INSTRUCTIONS = buildBranchUpdateInstructions(
      vars.PUBLICATION_BASE,
      vars.BRANCH_UPDATE_GUARD_CMD,
      vars.BRANCH_UPDATE_PUSH_CMD,
    );
  }

  const source = `Execution template ${selected.entry.id} (${selected.entry.sourceId})`;
  const snapshot = readExecutionTemplateSnapshot(selected.entry);
  const renderedTemplate = spec.authored
    ? snapshot.markdown
    : renderTemplatePlaceholders(snapshot.markdown, vars, source);
  const terminalContract =
    spec.terminalContract ??
    builtinTerminalContract(spec.flow, { ...(spec.runMode ? { mode: spec.runMode } : {}) });
  let checklistMarkdown = spec.authored
    ? spec.authored.checklistMarkdown
    : (spec.operatorPlan ?? renderedTemplate);
  let taskMarkdown =
    spec.authored?.taskMarkdown ??
    (spec.operatorPlan !== undefined
      ? `${renderedTemplate.trimEnd()}\n`
      : buildTaskDocument({
          flowType: spec.flow,
          modePreamble: spec.modePreamble ?? '',
          vars,
          description: spec.task.description ?? '',
          acceptanceCriteria: spec.task.acceptanceCriteria ?? [],
          affectedArea: spec.task.affectedArea,
          screenshotsMarkdown: spec.task.screenshotsMarkdown,
          commentsMarkdown: spec.task.commentsMarkdown,
          linkedTicketsMarkdown: spec.task.linkedTicketsMarkdown,
          linkedDescriptionsMarkdown: spec.task.linkedDescriptionsMarkdown,
          commentSummaryMarkdown: spec.task.commentSummaryMarkdown,
          addendum: spec.addendum
            ? renderTemplatePlaceholders(spec.addendum, vars, 'Task document addendum')
            : null,
          hasTicketData: spec.bugInput !== undefined,
        }));
  if (spec.operatorPlan !== undefined && spec.modePreamble)
    taskMarkdown = taskMarkdown.replace(/^(#.+\n)/, `$1\n${spec.modePreamble}\n`);
  if (spec.taskDocumentAdditions)
    taskMarkdown = `${taskMarkdown.trimEnd()}${spec.taskDocumentAdditions.startsWith('\n') ? '' : '\n\n'}${spec.taskDocumentAdditions}`;
  if (spec.artifactOnlyReplay) {
    if (checklistMarkdown !== null)
      checklistMarkdown = applyArtifactOnlyTaskPolicy(
        checklistMarkdown,
        spec.artifactOnlyReplay,
        taskMarkdown,
      );
    taskMarkdown = applyArtifactOnlyTaskPolicy(taskMarkdown, spec.artifactOnlyReplay);
  }
  const executionTemplate: HandoffExecutionTemplate = {
    selectionReason: selected.reason,
    ...executionTemplateReference(selected.entry, checklistMarkdown ?? taskMarkdown),
  };
  if (
    executionTemplate.firstSubtask === 'derive-acceptance' &&
    (spec.handoff.surface !== 'farmslot' || spec.terminalContract?.acceptanceContractVersion !== 1)
  )
    throw new Error(
      'Derived PR-completion acceptance requires a gateway-owned run and supported acceptance contract.',
    );
  const handoffMetadata =
    spec.authored?.handoff ??
    buildHandoffMetadata({
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
      acceptanceCriteria: spec.task.acceptanceCriteria,
      terminalContract,
      startedAt: spec.handoff.startedAt,
      executionTemplate,
      templateProvenance: spec.handoff.templateProvenance,
    });

  if (!handoffMetadata.executionTemplate) handoffMetadata.executionTemplate = executionTemplate;

  const executionProvenance = spec.execution
    ? retainTaskExecution(spec.taskDir, spec.execution, [templateRoot])
    : undefined;
  const written = await writeTaskDir({
    taskDir: spec.taskDir,
    taskMarkdown,
    checklistMarkdown,
    fixedMarkCommand: executionProvenance !== undefined,
    markCommand: executionProvenance
      ? retainedMarkCommand(executionProvenance.resolvedExecutable)
      : spec.markCommand,
    handoff: handoffMetadata,
    terminalContract,
    bugInput: spec.bugInput,
    deterministicCommands: vars,
  });
  return {
    ...written,
    executionTemplate,
    handoffMetadata,
    ...(executionProvenance ? { executionProvenance } : {}),
  };
}

/**
 * ADR-068 Amendment 8: retain the task checkout's changed provider in a new pin and
 * point the generated marker at its CLI. The caller verified `previous` and the
 * selection change. Documents, checklist state, acceptance identity and evidence stay.
 */
export function repinTask(
  taskDir: string,
  execution: TaskExecutionInput,
  previous: TaskExecutionProvenance,
  checkoutRoot: string,
): TaskExecutionProvenance {
  const receipt = repinTaskExecution(taskDir, execution, previous, checkoutRoot);
  followRepinnedMarker(taskDir, previous, receipt);
  return receipt;
}

/** Finish a repin stopped between its renames; null when none is pending. */
export function resumeTaskRepin(
  taskDir: string,
): { previous: TaskExecutionProvenance; receipt: TaskExecutionProvenance } | null {
  const resumed = completeInterruptedRepin(taskDir);
  if (resumed) followRepinnedMarker(taskDir, resumed.previous, resumed.receipt);
  return resumed;
}

// An authored marker stays as written; the generated one follows the new pin.
function followRepinnedMarker(
  taskDir: string,
  previous: TaskExecutionProvenance,
  receipt: TaskExecutionProvenance,
): void {
  const mark = path.join(taskDir, MARK_SHIM);
  const shim = (executable: string) => buildMarkShim(retainedMarkCommand(executable), true);
  if (!existsSync(mark) || readFileSync(mark, 'utf8') !== shim(previous.resolvedExecutable)) return;
  const staged = `${mark}.${path.basename(receipt.pin)}`;
  writeFileSync(staged, shim(receipt.resolvedExecutable), { mode: 0o755 });
  renameSync(staged, mark);
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
