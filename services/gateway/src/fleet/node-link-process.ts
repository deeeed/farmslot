import { type ExecResult, NodeLinkFailure } from '@farmslot/protocol';

import { assertCleanupCurrent, cleanupSignal, trackCleanupCommand } from '../core/cleanup-scope.js';
import type { SlotVars } from '../core/config.js';
import type { ExecOnSlotOptions } from '../core/exec.js';
import { readSlotRow } from '../core/state.js';
import { currentSessionOriginator } from '../security/work-originator.js';

import { getNode } from './machine-registry.js';
import { createNodeLinkCommandId, invokeNodeLink } from './node-link.js';

const fence = (row: Readonly<Record<string, unknown>> | null) =>
  JSON.stringify([
    row?.slot_epoch,
    row?.current_run_id ?? null,
    row?.handoff_run_id ?? null,
    row?.cleanup_run_id ?? null,
  ]);

/** Existing framework/pack policy approves exact argv; models never submit a gateway shell field. */
export async function execThroughNodeLink(
  vars: SlotVars,
  argv: string[],
  options: ExecOnSlotOptions,
  environment: 'service' | 'login',
): Promise<ExecResult> {
  assertCleanupCurrent();
  const node = getNode(vars.machine);
  if (!node?.nodePrincipal)
    throw new NodeLinkFailure('UNSUPPORTED_OPERATION', 'Node has no issued execution identity.');
  const row = await readSlotRow(vars.slotId);
  const expected = fence(row);
  const epoch = row?.slot_epoch;
  const runId =
    typeof row?.current_run_id === 'string'
      ? row.current_run_id
      : typeof row?.handoff_run_id === 'string'
        ? row.handoff_run_id
        : undefined;
  const principal = currentSessionOriginator();
  const timeoutMs = options.timeout ?? 10 * 60_000;
  const commandId = createNodeLinkCommandId(timeoutMs);
  const signal = cleanupSignal(options.signal);
  const receipt = await trackCleanupCommand(
    invokeNodeLink(
      {
        operation: 'process.run',
        input: {
          argv,
          cwd: options.cwd ?? vars.remoteRepo,
          timeoutMs,
          ...(options.closeoutTimeoutMs ? { closeoutTimeoutMs: options.closeoutTimeoutMs } : {}),
          maxOutputBytes: options.maxBuffer ?? 8 * 1024 * 1024,
          environment,
        },
      },
      {
        commandId,
        target: { nodeId: vars.machine, resourceId: vars.slotId },
        authority: {
          requester:
            principal.kind === 'principal'
              ? {
                  principalId: principal.principalId,
                  generation: principal.principalGeneration ?? 0,
                }
              : { kind: 'system' },
          executor: node.nodePrincipal,
          grantId: `process:${commandId}`,
          approvalId: `framework:${commandId}`,
          approval: 'framework',
          ...(runId && typeof epoch === 'number'
            ? {
                lease: {
                  runId,
                  contextId: 'workspace',
                  leaseId: `workspace:${vars.slotId}:${epoch}`,
                  generation: String(epoch),
                },
              }
            : {}),
        },
        timeoutMs,
        signal,
        assertCurrent: async () => {
          assertCleanupCurrent();
          signal?.throwIfAborted();
          if (getNode(vars.machine) !== node || fence(await readSlotRow(vars.slotId)) !== expected)
            throw new NodeLinkFailure(
              'STALE_AUTHORITY',
              'Workspace or enrolled node changed before execution.',
            );
        },
        onOutput: (stream, text) => options.onOutput?.(stream, text),
        onReset: (snapshot) => {
          options.onOutput?.(
            'stderr',
            '\n[output window expired; resynchronized snapshot follows]\n',
          );
          if (
            snapshot &&
            typeof snapshot === 'object' &&
            'text' in snapshot &&
            typeof snapshot.text === 'string'
          )
            options.onOutput?.('stdout', snapshot.text);
        },
      },
    ),
  );
  if (receipt.state !== 'completed')
    throw new NodeLinkFailure(
      receipt.error?.code ?? 'EXECUTION_FAILED',
      receipt.error?.message ?? 'Node execution did not complete.',
    );
  const result = receipt.result;
  if (
    !result ||
    typeof result !== 'object' ||
    !('exitCode' in result) ||
    typeof result.exitCode !== 'number' ||
    !('stdout' in result) ||
    typeof result.stdout !== 'string' ||
    !('stderr' in result) ||
    typeof result.stderr !== 'string'
  )
    throw new NodeLinkFailure('INVALID_RECEIPT', 'Node returned an invalid process outcome.');
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}
