import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SelectedExecutionTemplate, TaskInitSpec } from '@farmslot/agent-runtime';
import {
  type ExecutionTemplateReference,
  isExecutionTemplateReference,
  isRecord,
  type Run,
} from '@farmslot/protocol';
import {
  currentProjectSources,
  farmslotRoot,
  sourceExecutionEnvironment,
} from '@farmslot/slot-config';
import {
  runTaskRuntime,
  TASK_RUNTIME_TIMEOUT_MS,
  type TaskRuntimeRequest,
} from '@farmslot/slot-config/task-runtime';

import { assertCleanupCurrent, cleanupSignal, trackCleanupCommand } from '../core/cleanup-scope.js';
import type { SlotVars } from '../core/config.js';
import {
  EXEC_TIMEOUT_EXIT_CODE,
  execOnSlot,
  isLocal,
  localCommandEnvironment,
} from '../core/exec.js';
import { expandTemplate } from '../core/hooks.js';
import { machineShellEnv, withMachineEnv } from '../core/project-env.js';
import { isShellHomePath } from '../core/remote-paths.js';
import {
  slotDeletePath,
  slotFileExists,
  slotMkdir,
  slotReadFile,
  slotWriteFiles,
} from '../core/slot-io.js';
import { shellQuote } from '../core/tmux.js';
import { getNode } from '../fleet/machine-registry.js';
import { usesNodeLink } from '../fleet/node-link-policy.js';
import { taskRuntimeThroughNodeLink } from '../fleet/node-link-process.js';
import { nodeTaskRuntime } from '../fleet/node-rpc.js';
import {
  NodeSupportPendingError,
  resolveRemoteFarmCommand,
} from '../node-support/remote-command.js';
import { measureManagedOperation } from '../observability/performance.js';

import { farmslotDirectoryForSlot } from './agent-runtime-script.js';
import { copyPreparedTaskRootSidecars, copyTaskDirSubdirectories } from './sidecars.js';

const producedTaskFiles = [
  'TASK.md',
  'CHECKLIST.md',
  'mark',
  'inputs/handoff.json',
  'inputs/worker-terminal-contract.json',
  'inputs/bug-input.json',
  'inputs/recipe-binding.json',
  'artifacts/harness-provenance.json',
] as const;

async function hostedTaskRuntime(
  slot: SlotVars,
  action: TaskRuntimeRequest['action'],
  taskPath: string,
) {
  assertCleanupCurrent();
  const nodeLink = usesNodeLink(slot.machine);
  const node = getNode(slot.machine);
  const supported = nodeLink
    ? node?.nodeLink?.operations?.includes('task.runtime') === true
    : node?.taskRuntime === 1;
  // Negotiate before execution. A failed runtime call may already have changed task files.
  if (!supported) {
    console.warn(
      `[hosted-task] Node ${slot.machine} does not advertise task.runtime; using CLI for ${action}.`,
    );
    const command = await hostedTaskCommand(
      slot,
      action === 'init' ? ['internal', 'task-init', taskPath] : ['task', 'verify', taskPath],
    );
    return execOnSlot(slot, command, {
      timeout: TASK_RUNTIME_TIMEOUT_MS[action],
      maxBuffer: 8 * 1024 * 1024,
      noRetry: true,
    });
  }
  const local = isLocal(slot.host, slot.machine) && !nodeLink;
  const support = expandTemplate('{{farmslot_dir}}', slot);
  let supportDir = support;
  if (!local) {
    try {
      supportDir = await resolveRemoteFarmCommand(slot, support, {
        budgetMs: TASK_RUNTIME_TIMEOUT_MS[action],
      });
    } catch (error) {
      if (!(error instanceof NodeSupportPendingError)) throw error;
      return { exitCode: EXEC_TIMEOUT_EXIT_CODE, stdout: '', stderr: error.message };
    }
  }
  const sources = currentProjectSources();
  if (sources) {
    const { verifyExecutionSources } = await import('../sources/runtime.js');
    await verifyExecutionSources(slot.machine, sources.execution ?? sources.materialization);
  }
  const request: TaskRuntimeRequest = {
    action,
    taskPath,
    supportDir,
    env: { ...machineShellEnv(slot), ...(sources ? sourceExecutionEnvironment(sources) : {}) },
  };
  const signal = cleanupSignal();
  if (local)
    return trackCleanupCommand(
      measureManagedOperation('exec', 'node', () =>
        runTaskRuntime(request, farmslotRoot(), localCommandEnvironment(), signal),
      ),
    );
  if (nodeLink)
    return measureManagedOperation('exec', 'node', () =>
      taskRuntimeThroughNodeLink(slot, request, {
        timeout: TASK_RUNTIME_TIMEOUT_MS[action],
        signal,
      }),
    );
  const result = await trackCleanupCommand(
    nodeTaskRuntime(slot.machine, request, TASK_RUNTIME_TIMEOUT_MS[action], signal),
  );
  if (
    !isRecord(result) ||
    typeof result.exitCode !== 'number' ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string'
  )
    throw new Error('Node task runtime returned an invalid result.');
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

export interface HostedTaskInput {
  runner?: string;
  /** An artifact-only scripted command run: the node resolves the command-result contract. */
  scriptedCommand?: true;
  binding: 'project' | 'static';
  task: Omit<TaskInitSpec, 'execution' | 'markCommand' | 'template'>;
  template: SelectedExecutionTemplate;
}

/** Keep CLI distribution, node pools and captured project scripts independently selected. */
export async function hostedTaskCommand(slot: SlotVars, args: readonly string[]): Promise<string> {
  const farm = await farmslotDirectoryForSlot(slot);
  const support = expandTemplate('{{farmslot_dir}}', slot);
  const supportArg = isShellHomePath(support) ? support : shellQuote(support);
  const script =
    'farm="$1"; support="$2"; shift 2; unset FARMSLOT_ROOT; export FARMSLOT_CLI="${FARMSLOT_CLI:-$HOME/.local/bin/farmslot}"; source "$support/scripts/lib/resolve-farmslot-cli.sh" && exec "$FARMSLOT_CLI" --json "$@"';
  return withMachineEnv(
    `bash -c ${shellQuote(script)} hosted-task ${shellQuote(farm)} ${supportArg} ${args.map(shellQuote).join(' ')}`,
    slot,
  );
}

/** The private request `internal task-init` consumes, refused above its 8 MiB bound. */
export function hostedTaskRequest(slotId: string, input: HostedTaskInput): string {
  const request = JSON.stringify({
    version: 1,
    slotId,
    ...(input.runner === 'scripted' ? { runner: 'scripted' } : {}),
    ...(input.scriptedCommand ? { scriptedCommand: true } : {}),
    binding: input.binding,
    task: input.task,
    template: {
      sourceId: input.template.entry.sourceId,
      id: input.template.entry.id,
      sha256: input.template.entry.sha256,
      selectionReason: input.template.reason,
    },
    taskDocumentAdditions: input.task.taskDocumentAdditions,
    templateProvenance: input.task.handoff.templateProvenance,
  });
  if (Buffer.byteLength(request) > 8 * 1024 * 1024)
    throw new Error('Hosted task request exceeds 8 MiB.');
  return request;
}

/** The gateway transports task data and mirrors the one producer's final bytes. */
export async function initializeHostedTaskOnSlot(
  slot: SlotVars,
  gatewayTaskDir: string,
  input: HostedTaskInput,
  run?: Run,
  options?: { deferSidecars?: boolean },
): Promise<ExecutionTemplateReference> {
  const requestPath = path.posix.join(input.task.taskDir, `.task-init-${randomUUID()}.json`);
  const request = hostedTaskRequest(slot.slotId, input);
  const hadReceipt = await slotFileExists(
    slot,
    path.posix.join(input.task.taskDir, 'artifacts/harness-provenance.json'),
  );
  await slotMkdir(slot, input.task.taskDir);
  try {
    await slotWriteFiles(slot, path.posix.dirname(requestPath), [
      {
        path: path.posix.basename(requestPath),
        content: Buffer.from(request).toString('base64'),
        mode: 0o600,
      },
    ]);
    const result = await hostedTaskRuntime(slot, 'init', requestPath);
    if (result.exitCode !== 0)
      throw new Error(`Node task initialization refused: ${result.stdout || result.stderr}`);
    const envelope: unknown = JSON.parse(result.stdout);
    if (
      !isRecord(envelope) ||
      envelope.status !== 'ok' ||
      !isRecord(envelope.data) ||
      !isExecutionTemplateReference(envelope.data.executionTemplate)
    )
      throw new Error('Node task initialization returned an invalid result.');
    const reference = envelope.data.executionTemplate;
    if (!hadReceipt && !options?.deferSidecars)
      await syncHostedTaskSidecars(
        slot,
        gatewayTaskDir,
        input.task.taskDir,
        producedTaskFiles,
        run,
      );
    for (const file of producedTaskFiles) {
      const remote = path.posix.join(input.task.taskDir, file);
      if (
        ['CHECKLIST.md', 'inputs/bug-input.json'].includes(file) &&
        !(await slotFileExists(slot, remote))
      )
        continue;
      const bytes = await slotReadFile(slot, remote);
      const local = path.join(gatewayTaskDir, file);
      await mkdir(path.dirname(local), { recursive: true });
      await writeFile(local, bytes, 'utf8');
      if (file === 'mark') await chmod(local, 0o755);
    }
    return reference;
  } finally {
    if (await slotFileExists(slot, requestPath)) await slotDeletePath(slot, requestPath);
  }
}

/** Dispatch verifies the node-owned receipt after copying sidecars, before launch. */
export async function verifyHostedTaskOnSlot(slot: SlotVars, taskDir: string): Promise<void> {
  const result = await hostedTaskRuntime(slot, 'verify', taskDir);
  if (result.exitCode !== 0)
    throw new Error(`Retained task verification refused: ${result.stdout || result.stderr}`);
}

/** Initial control-plane sidecars use the existing task transfer implementation. */
export async function syncHostedTaskSidecars(
  slot: SlotVars,
  gatewayTaskDir: string,
  workerTaskDir: string,
  excludeRelativePaths: readonly string[] = [],
  run?: Run,
): Promise<void> {
  const transfer = {
    excludeRelativePaths,
    slotId: slot.slotId,
    ...(run ? { runId: run.id } : {}),
    taskDir: gatewayTaskDir,
    workerTaskAbs: workerTaskDir,
    host: slot.host,
    machine: slot.machine,
    sshTarget: slot.sshTarget,
  };
  await copyPreparedTaskRootSidecars(transfer);
  await copyTaskDirSubdirectories(transfer);
}
