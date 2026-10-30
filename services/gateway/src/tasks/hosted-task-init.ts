import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SelectedExecutionTemplate, TaskInitSpec } from '@farmslot/agent-runtime';
import {
  type ExecutionTemplateReference,
  isExecutionTemplateReference,
  isRecord,
} from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { expandTemplate } from '../core/hooks.js';
import { withMachineEnv } from '../core/project-env.js';
import { isShellHomePath } from '../core/remote-paths.js';
import {
  slotDeletePath,
  slotFileExists,
  slotMkdir,
  slotReadFile,
  slotWriteFiles,
} from '../core/slot-io.js';
import { shellQuote } from '../core/tmux.js';

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

// Three loaded-node samples reached 265s retaining installed CLI/provider inputs.
// Round twice that sample p95 up to ten minutes; partial initialization is never retried.
const HOSTED_TASK_INIT_TIMEOUT_MS = 10 * 60_000;

export interface HostedTaskInput {
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
    'farm="$1"; support="$2"; shift 2; unset FARMSLOT_ROOT; export FARMSLOT_POOL_DIR="${FARMSLOT_POOL_DIR:-$farm/pool}" FARMSLOT_PROJECTS_DIR="${FARMSLOT_PROJECTS_DIR:-$support/projects}" FARMSLOT_CLI="${FARMSLOT_CLI:-$HOME/.local/bin/farmslot}"; source "$support/scripts/lib/resolve-farmslot-cli.sh" && exec "$FARMSLOT_CLI" --json "$@"';
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
    const command = await hostedTaskCommand(slot, ['internal', 'task-init', requestPath]);
    const result = await execOnSlot(slot, command, {
      timeout: HOSTED_TASK_INIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      noRetry: true,
    });
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
    if (!hadReceipt)
      await syncHostedTaskSidecars(slot, gatewayTaskDir, input.task.taskDir, producedTaskFiles);
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
  const command = await hostedTaskCommand(slot, ['task', 'verify', taskDir]);
  const result = await execOnSlot(slot, command, {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    noRetry: true,
  });
  if (result.exitCode !== 0)
    throw new Error(`Retained task verification refused: ${result.stdout || result.stderr}`);
}

/** Initial control-plane sidecars use the existing task transfer implementation. */
export async function syncHostedTaskSidecars(
  slot: SlotVars,
  gatewayTaskDir: string,
  workerTaskDir: string,
  excludeRelativePaths: readonly string[] = [],
): Promise<void> {
  const transfer = {
    excludeRelativePaths,
    taskDir: gatewayTaskDir,
    workerTaskAbs: workerTaskDir,
    host: slot.host,
    machine: slot.machine,
    sshTarget: slot.sshTarget,
  };
  await copyPreparedTaskRootSidecars(transfer);
  await copyTaskDirSubdirectories(transfer);
}
