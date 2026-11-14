import type { ExecResult, SlotWorkspace } from '@farmslot/protocol';
import { currentProjectSources } from '@farmslot/slot-config';

import { currentSlotCommandExecutor } from '../../core/exec-scope.js';
import { withFarmGitConfig } from '../../core/farm-git.js';
import { slotFilesReadInProcess, type SlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { type ConnectedNode, getNode } from '../../fleet/machine-registry.js';
import { readSlotCommand } from '../../host-services/read-command.js';

import type { WorkspaceMetadataVersion } from './workspace-metadata-policy.js';

interface DefaultAncestryQuery {
  vars: SlotVars;
  headSha: string;
  baseSha: string;
  originKey: string;
  ownership: Pick<
    SlotWorkspace,
    'epoch' | 'currentRunId' | 'cleanupRunId' | 'handoffRunId' | 'recoveryId'
  >;
  metadata?: WorkspaceMetadataVersion;
  passive: boolean;
  timeoutMs: number;
}
interface PositiveAncestry {
  key: string;
  connection: ConnectedNode['ws'] | undefined;
  until: number;
  result?: ExecResult;
}
const positives = new Map<string, PositiveAncestry>();
const POSITIVE_TTL_MS = 10 * 60_000;
const MAX_SLOTS = 512;
const commitSha = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

export function invalidatePassiveDefaultAncestry(slotId: string): void {
  positives.delete(slotId);
}

/** Only a verified passive positive may skip an unchanged default-branch query. */
export async function readDefaultWorkspaceAncestry(
  query: DefaultAncestryQuery,
): Promise<ExecResult> {
  const { vars, metadata, ownership, timeoutMs } = query;
  const connection = getNode(vars.machine)?.ws;
  const reusable =
    query.passive &&
    timeoutMs <= 5000 &&
    metadata?.ancestryCacheable === true &&
    commitSha(query.headSha) &&
    commitSha(query.baseSha) &&
    !currentSlotCommandExecutor() &&
    !currentProjectSources() &&
    (slotFilesReadInProcess(vars) || connection !== undefined);
  const key = reusable
    ? JSON.stringify([
        vars.machine,
        vars.host,
        vars.remoteRepo,
        query.headSha,
        query.baseSha,
        query.originKey,
        metadata.version,
        ownership.epoch,
        ownership.currentRunId,
        ownership.cleanupRunId,
        ownership.handoffRunId,
        ownership.recoveryId,
      ])
    : '';
  const cached = positives.get(vars.slotId);
  if (
    reusable &&
    cached?.key === key &&
    cached.connection === connection &&
    cached.until > Date.now() &&
    cached.result !== undefined
  )
    return cached.result;
  // Do not let a missing/unsupported metadata observation revive an earlier positive later.
  if (query.passive) positives.delete(vars.slotId);
  const head = reusable ? shellQuote(query.headSha) : 'HEAD';
  const flight: PositiveAncestry | undefined = reusable ? { key, connection, until: 0 } : undefined;
  if (flight) {
    if (positives.size >= MAX_SLOTS) {
      const oldest = positives.keys().next().value;
      if (oldest !== undefined) positives.delete(oldest);
    }
    positives.set(vars.slotId, flight);
  }
  try {
    const result = await readSlotCommand(
      vars,
      withFarmGitConfig(
        `git -C ${shellQuote(vars.remoteRepo)} merge-base --is-ancestor ${head} ${shellQuote(query.baseSha)}`,
      ),
      { timeout: timeoutMs, cwd: '/' },
    );
    // This object is also the flight's invalidation token. Deletion or replacement wins.
    if (
      flight &&
      result.exitCode === 0 &&
      getNode(vars.machine)?.ws === connection &&
      positives.get(vars.slotId) === flight
    ) {
      flight.result = result;
      flight.until = Date.now() + POSITIVE_TTL_MS;
    }
    return result;
  } finally {
    if (flight && !flight.result && positives.get(vars.slotId) === flight)
      positives.delete(vars.slotId);
  }
}
