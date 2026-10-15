import { nativeRunnerDefinitions } from '@farmslot/agent-runtime/native/registry';
import type { Run } from '@farmslot/protocol';

import { execNativeNodeArgv } from '../runners/native/node.js';
import { inspectNativeWorkerProfile } from '../runners/native/worker-profile.js';
import { assertNativeRunOwner } from '../security/native-worker-owner.js';

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
  assertCurrent();
  const argv = [
    'node',
    '-e',
    preflight.script,
    run.reviewWorkspace.taskPath,
    profile?.directory ?? '',
  ];
  const result = await execNativeNodeArgv(
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
