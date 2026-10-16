import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  executionTemplateCatalogFlow,
  type HandoffMetadata,
  projectWorkerTemplateSource,
  resolveConfiguredExecutionTemplateSources,
  type SelectedExecutionTemplate,
  selectExecutionTemplate,
  type TaskExecutionProvenance,
  taskInit,
  type TaskInitResult,
  type TaskInitSpec,
} from '@farmslot/agent-runtime';
import {
  isExecutionTemplateReference,
  isRecord,
  isTemplateProvenance,
  type WorkerTerminalContractDocument,
} from '@farmslot/protocol';
import {
  executionSourceContext,
  loadProjectVars,
  loadSlotVars,
  resolveProjectTaskDirName,
  resolveSourceBinding,
} from '@farmslot/slot-config';

import { isLocalPool } from '../slot-context.js';

import { projectRecipeHostOptions } from './recipe-project.js';
import { cliInstallation } from './task.js';

type TaskData = Omit<TaskInitSpec, 'execution' | 'markCommand' | 'template'>;

export interface HostedTaskInitRequest {
  version: 1;
  slotId: string;
  binding: 'project' | 'static';
  task: TaskData;
  template: {
    sourceId: string;
    id: string;
    sha256: string;
    selectionReason: SelectedExecutionTemplate['reason'];
  };
  taskDocumentAdditions?: string;
  templateProvenance?: HandoffMetadata['templateProvenance'];
}

function refusal(message: string, code = 'TASK_INIT_INPUT_INVALID'): Error {
  return Object.assign(new Error(message), {
    code,
    exitCode: 2,
    userAction:
      'Use the matching hosted run and worker task directory. Re-author a new task for a different allocation; never delete or upgrade a retained receipt.',
  });
}
const selectionReasons = [
  'explicit',
  'configured-default',
  'single-domain-candidate',
  'single-general-candidate',
];
const string = (value: unknown): value is string => typeof value === 'string';
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
const optional = (value: unknown, check: (entry: unknown) => boolean) =>
  value === undefined || check(value);
const stringFields = (value: Record<string, unknown>, keys: readonly string[]) =>
  keys.every((key) => optional(value[key], string));

function terminalContract(value: unknown): value is WorkerTerminalContractDocument {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !string(value.flowType) ||
    typeof value.requireSignal !== 'boolean' ||
    !string(value.resolvedAt) ||
    !['builtin', 'project'].includes(String(value.source)) ||
    !isRecord(value.commands) ||
    !Array.isArray(value.whenPresent)
  )
    return false;
  const commands = value.commands;
  return (
    ['complete', 'no-change', 'blocked'].every((key) => {
      const command = commands[key];
      return isRecord(command) && optional(command.report, string) && strings(command.artifacts);
    }) &&
    value.whenPresent.every(
      (entry) => isRecord(entry) && string(entry.path) && strings(entry.alsoRequire),
    ) &&
    optional(
      value.acceptance,
      (entry) =>
        isRecord(entry) &&
        ['require', 'allowWeak'].every((key) =>
          optional(entry[key], (v) => typeof v === 'boolean'),
        ),
    ) &&
    stringFields(value, ['mode']) &&
    ['claimReviewGate'].every((key) =>
      optional(value[key], (entry) => typeof entry === 'boolean'),
    ) &&
    optional(value.recordedEvidenceContractVersion, (entry) => Number.isInteger(entry)) &&
    optional(
      value.deterministicChecks,
      (entries) =>
        Array.isArray(entries) &&
        entries.every(
          (entry) =>
            isRecord(entry) &&
            string(entry.checklist) &&
            Number.isInteger(entry.stepNumber) &&
            string(entry.reference) &&
            string(entry.command),
        ),
    )
  );
}

function provenance(value: unknown): boolean {
  return (
    isRecord(value) &&
    string(value.templatePath) &&
    optional(value.projectRepoPath, string) &&
    isTemplateProvenance({
      ...value,
      templatePath: 'selected-template.md',
      projectRepoPath: undefined,
    })
  );
}

function handoff(value: unknown): value is HandoffMetadata {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.taskDocument === 'TASK.md' &&
    ['attemptId', 'surface', 'project', 'domain', 'flow', 'startedAt', 'report', 'learnings'].every(
      (key) => string(value[key]),
    ) &&
    isRecord(value.task) &&
    string(value.task.title) &&
    ['text', 'file', 'github-pr', 'github-issue', 'jira'].includes(String(value.task.sourceKind)) &&
    stringFields(value.task, ['ticket', 'sourceRef']) &&
    optional(value.task.acceptanceCriteria, strings) &&
    optional(value.repo, string) &&
    optional(value.templateProvenance, provenance) &&
    optional(
      value.executionTemplate,
      (entry) =>
        isExecutionTemplateReference(entry) &&
        isRecord(entry) &&
        selectionReasons.includes(String(entry.selectionReason)),
    )
  );
}

/** The private transport accepts task data, never installation or provider authority. */
function isHostedRequest(value: unknown): value is HostedTaskInitRequest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !string(value.slotId) ||
    (value.binding !== 'project' && value.binding !== 'static') ||
    !isRecord(value.task) ||
    !isRecord(value.template)
  )
    return false;
  const task = value.task;
  const template = value.template;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'version',
          'slotId',
          'binding',
          'task',
          'template',
          'taskDocumentAdditions',
          'templateProvenance',
        ].includes(key),
    ) ||
    ['execution', 'markCommand', 'template'].some((key) => key in task) ||
    !['taskDir', 'flow', 'platform'].every((key) => string(task[key])) ||
    !isRecord(task.task) ||
    !string(task.task.title) ||
    !['text', 'file', 'github-pr', 'github-issue', 'jira'].includes(String(task.task.sourceKind)) ||
    !stringFields(task.task, [
      'description',
      'ticket',
      'sourceRef',
      'affectedArea',
      'screenshotsMarkdown',
      'commentsMarkdown',
      'linkedTicketsMarkdown',
      'linkedDescriptionsMarkdown',
      'commentSummaryMarkdown',
    ]) ||
    !optional(task.task.acceptanceCriteria, strings) ||
    !isRecord(task.handoff) ||
    !string(task.handoff.surface) ||
    !string(task.handoff.project) ||
    !stringFields(task.handoff, ['attemptId', 'repo', 'startedAt']) ||
    !stringFields(task, [
      'taskDirLabel',
      'domain',
      'modePreamble',
      'operatorPlan',
      'taskDocumentAdditions',
    ]) ||
    !optional(task.addendum, (entry) => entry === null || string(entry)) ||
    !optional(task.runMode, (entry) =>
      ['interactive', 'autonomous', 'validation'].includes(String(entry)),
    ) ||
    !optional(task.vars, (entry) => isRecord(entry) && Object.values(entry).every(string)) ||
    !optional(task.terminalContract, terminalContract) ||
    !optional(
      task.artifactOnlyReplay,
      (entry) => isRecord(entry) && string(entry.base) && optional(entry.ignoredPaths, strings),
    ) ||
    !optional(
      task.authored,
      (entry) =>
        isRecord(entry) &&
        string(entry.taskMarkdown) &&
        (entry.checklistMarkdown === null || string(entry.checklistMarkdown)) &&
        handoff(entry.handoff),
    ) ||
    !['sourceId', 'id', 'sha256', 'selectionReason'].every((key) => string(template[key])) ||
    !optional(value.taskDocumentAdditions, string)
  )
    return false;
  return (
    optional(value.templateProvenance, provenance) &&
    optional(task.handoff.templateProvenance, provenance) &&
    selectionReasons.includes(String(value.template.selectionReason))
  );
}

export function parseHostedTaskInitRequest(value: unknown): HostedTaskInitRequest {
  if (isHostedRequest(value)) return value;
  throw refusal('Hosted task data has an invalid or forbidden field.');
}

function ownedTaskDirectory(checkout: string, taskDirName: string, requested: string): string {
  const target = path.resolve(requested);
  const root = path.join(fs.realpathSync(checkout), taskDirName);
  if (!target.startsWith(`${root}${path.sep}`))
    throw refusal('The task directory is outside its selected checkout.');
  let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const actual = fs.realpathSync(existing);
  if (
    actual !== root &&
    !actual.startsWith(`${root}${path.sep}`) &&
    actual !== fs.realpathSync(checkout)
  )
    throw refusal('The task directory resolves outside its selected checkout.');
  return target;
}

export function hostedTerminalPolicy(
  task: TaskData,
  configured: WorkerTerminalContractDocument,
): WorkerTerminalContractDocument {
  if (task.authored) return task.terminalContract ?? configured;
  const identity = ({
    resolvedAt: _time,
    claimReviewGate: _gate,
    recordedEvidenceContractVersion: _version,
    ...policy
  }: WorkerTerminalContractDocument): unknown => JSON.parse(JSON.stringify(policy));
  if (
    task.terminalContract &&
    !isDeepStrictEqual(identity(task.terminalContract), identity(configured))
  )
    throw refusal(
      'Task terminal policy differs from the node configuration.',
      'TASK_INIT_POLICY_CHANGED',
    );
  return {
    ...configured,
    claimReviewGate: task.terminalContract?.claimReviewGate,
    recordedEvidenceContractVersion: task.terminalContract?.recordedEvidenceContractVersion,
  };
}

export async function runHostedTaskInit(inputFile: string): Promise<TaskInitResult> {
  const file = path.resolve(inputFile);
  if (!/^\.task-init-[0-9a-f-]{36}\.json$/.test(path.basename(file)))
    throw refusal('Only owned temporary task-init transport files are accepted.');
  const stat = fs.lstatSync(file);
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
      throw refusal('Hosted task request must be a regular file of at most 8 MiB.');
    const request = parseHostedTaskInitRequest(JSON.parse(fs.readFileSync(file, 'utf8')));
    const slot = await loadSlotVars(request.slotId);
    if (!isLocalPool(slot))
      throw refusal('Task initialization must run on the selected execution node.');
    const project = await loadProjectVars(slot.projectName);
    if (
      request.task.handoff.project !== slot.projectName ||
      request.task.platform !== slot.platform
    )
      throw refusal('Task project or platform differs from its selected slot.');
    const taskDir = ownedTaskDirectory(
      slot.remoteRepo,
      resolveProjectTaskDirName(project.projectJson),
      request.task.taskDir,
    );
    const shared = await import('@farmslot/recipe-cli/harness');
    if (fs.existsSync(path.join(taskDir, 'artifacts/harness-provenance.json'))) {
      let receipt: TaskExecutionProvenance;
      try {
        receipt = shared.verifySelectedTask(taskDir);
      } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT')
          throw refusal(
            'The retained task belongs to another installation or task directory.',
            'TASK_PROVENANCE_RELOCATED',
          );
        throw error;
      }
      const metadata: unknown = JSON.parse(
        fs.readFileSync(path.join(taskDir, 'inputs/handoff.json'), 'utf8'),
      );
      if (
        !handoff(metadata) ||
        metadata.attemptId !== request.task.handoff.attemptId ||
        metadata.project !== slot.projectName ||
        metadata.flow !== request.task.flow ||
        !metadata.executionTemplate
      )
        throw refusal(
          'Existing task identity differs from this run.',
          'TASK_INIT_IDENTITY_CHANGED',
        );
      return {
        taskDir,
        taskDocument: path.join(taskDir, 'TASK.md'),
        checklist: fs.existsSync(path.join(taskDir, 'CHECKLIST.md'))
          ? path.join(taskDir, 'CHECKLIST.md')
          : null,
        mark: path.join(taskDir, 'mark'),
        handoff: path.join(taskDir, 'inputs/handoff.json'),
        terminalContract: path.join(taskDir, 'inputs/worker-terminal-contract.json'),
        bugInput: fs.existsSync(path.join(taskDir, 'inputs/bug-input.json'))
          ? path.join(taskDir, 'inputs/bug-input.json')
          : null,
        executionTemplate: metadata.executionTemplate,
        handoffMetadata: metadata,
        executionProvenance: receipt,
      };
    }
    if (
      fs.existsSync(path.join(taskDir, 'inputs/recipe-binding.json')) ||
      (!request.task.authored && fs.existsSync(path.join(taskDir, 'mark')))
    )
      throw refusal(
        'Task initialization is incomplete; preserve its files and recover the original initialization.',
        'TASK_INIT_PARTIAL',
      );
    const admittedSources = await executionSourceContext();
    const configured = resolveConfiguredExecutionTemplateSources(
      project.projectJson.execution_templates,
      {
        projectPackRoot: path.dirname(project.projectConfig),
        env: { ...slot.machineEnv, ...process.env },
        ...(admittedSources
          ? {
              resolveSourceBinding: (selection) =>
                resolveSourceBinding(selection, admittedSources.materialization),
            }
          : {}),
      },
    );
    const sources = [
      projectWorkerTemplateSource(slot.projectName, project.projectTemplatesDir),
      ...configured.sources,
    ];
    const selected = selectExecutionTemplate({
      sources,
      flow: executionTemplateCatalogFlow(
        sources,
        project.projectJson.qa?.profiles,
        request.task.flow,
        request.template.id,
      ),
      platform: slot.platform,
      runMode: request.task.runMode,
      domain: request.task.domain,
      explicitId: request.template.id,
      defaults: project.projectJson.execution_templates?.defaults,
    });
    if (
      selected.entry.sourceId !== request.template.sourceId ||
      selected.entry.sha256 !== request.template.sha256
    )
      throw refusal(
        'Selected task template differs from the configured node catalog.',
        'TASK_TEMPLATE_CHANGED',
      );
    const {
      resolveWorkerTerminalContract,
    }: {
      resolveWorkerTerminalContract(
        config: unknown,
        flow: string,
        options: { mode?: string },
      ): WorkerTerminalContractDocument;
    } = createRequire(import.meta.url)(
      '@farmslot/agent-runtime/scripts/worker-terminal-contract.cjs',
    );
    const projectConfig = isRecord(project.projectJson)
      ? project.projectJson.worker_terminal
      : undefined;
    const terminal = hostedTerminalPolicy(
      request.task,
      resolveWorkerTerminalContract(projectConfig, request.task.flow, {
        mode: request.task.runMode,
      }),
    );
    const installation = cliInstallation();
    const produce = async (execution: import('@farmslot/agent-runtime').TaskExecutionInput) =>
      taskInit({
        ...request.task,
        terminalContract: terminal,
        taskDir,
        taskDirLabel: path.relative(slot.remoteRepo, taskDir),
        template: { sources, selection: { ...selected, reason: request.template.selectionReason } },
        vars: {
          ...request.task.vars,
          TASK_DIR: path.relative(slot.remoteRepo, taskDir),
          REPO: slot.remoteRepo,
          SLOT: slot.slotId,
          SLOT_ID: slot.slotId,
          PLATFORM: slot.platform,
        },
        taskDocumentAdditions: request.taskDocumentAdditions,
        handoff: { ...request.task.handoff, templateProvenance: request.templateProvenance },
        execution,
      });
    if (request.binding === 'static') {
      if (project.projectJson.recipe?.provider || project.projectJson.vars?.mark_cmd)
        throw refusal('Static tasks cannot discard a declared provider or marker policy.');
      return produce({
        ...installation,
        bindingIdentity: null,
        inputs: [path.dirname(project.projectConfig)],
        selectedConfiguration: '{"identity":null}',
      });
    }
    const host = await projectRecipeHostOptions('task', slot.remoteRepo, {
      project: slot.projectName,
      slot: slot.slotId,
      platform: slot.platform,
      app: slot.resourceVars.app,
    });
    return shared.withProjectRecipeHost(host, async (selectedHost) => {
      if (
        !selectedHost.provider.commandOptions?.task ||
        !Array.isArray(selectedHost.provider.commandOptions.task.stepGates)
      )
        throw refusal('The selected provider does not declare task gates.');
      const execution = await shared.projectTaskExecution(selectedHost, installation);
      return produce(execution);
    });
  } finally {
    if (stat.isFile() || stat.isSymbolicLink()) fs.rmSync(file, { force: true });
  }
}
