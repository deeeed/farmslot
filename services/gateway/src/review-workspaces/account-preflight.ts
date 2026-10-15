import { nativeRunnerDefinitions } from '@farmslot/agent-runtime/native/registry';
import type { Run } from '@farmslot/protocol';

import { loadMachinePool } from '../core/config.js';
import { execFileArgv } from '../core/exec.js';
import { interactiveRunnerExecutable } from '../runners/launch-command.js';
import { execNativeNodeArgv } from '../runners/native/node.js';
import { inspectNativeWorkerProfile } from '../runners/native/worker-profile.js';
import {
  assertNativeRunOwner,
  requireNativeProfileOwner,
} from '../security/native-worker-owner.js';

/** Account policy belongs to the runner; the workflow only selects its owner-bound node. */
export async function preflightReviewWorkspaceAccount(
  run: Run,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  assertNativeRunOwner(run);
  const definition = run.metrics.runner ? nativeRunnerDefinitions[run.metrics.runner] : undefined;
  const preflight = definition?.reviewAccountPreflight;
  if (!preflight) return;
  if (!run.reviewWorkspace)
    throw new Error('Review account preflight requires an allocated workspace');
  const profile = run.nativeProfile
    ? await inspectNativeWorkerProfile(run.nativeOwnerPrincipalId!, run.nativeProfile)
    : undefined;
  const executable =
    run.transport === 'tmux'
      ? interactiveRunnerExecutable({
          runner: run.metrics.runner!,
          machine: await loadMachinePool(run.reviewWorkspace.machine),
        })
      : definition!.binary;
  assertCurrent();
  const local = run.reviewWorkspace.executionNodeId === 'local';
  if (local) requireNativeProfileOwner(run.nativeOwnerPrincipalId);
  const argv = [
    local ? process.execPath : 'node',
    '-e',
    preflight.script,
    run.reviewWorkspace.taskPath,
    profile?.directory ?? '',
    executable,
  ];
  const result = local
    ? await execFileArgv(argv, { timeout: preflight.timeoutMs })
    : await execNativeNodeArgv(
        run.nativeOwnerPrincipalId!,
        run.reviewWorkspace.machine,
        argv,
        preflight.timeoutMs,
      );
  assertCurrent();
  if (result.exitCode !== 0)
    throw new Error(
      result.stderr.trim() || 'Review account preflight failed before task preparation',
    );
}
