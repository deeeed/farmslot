import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { createEvidenceReviewModel, runEvidencePending } from '@farmslot/adapter-sdk/evidence';
import { watchFile } from '@farmslot/capabilities/fs-watch';
import {
  isRecipeFlowUpdate,
  isRecord,
  type NodeFsReadTextResult,
  type RecipeInvocationTree,
  type Run,
  type RunRecipeRunsForRunResult,
} from '@farmslot/protocol';
import { RECIPE_PENDING_FLOW_FILE } from '@farmslot/recipe-runner';

import { GatewayMethodError } from '../core/method-error.js';
import { readSlotRow, SLOT_PHASE_RELEASING } from '../core/state.js';
import { type ConnectedNode, getNode } from '../fleet/machine-registry.js';
import { getSlotLocality, sendNodeRequest } from '../fleet/node-rpc.js';
import {
  assertFileObservationsAdmitted,
  forgetNodeFileObservation,
  watchNodeFile,
} from '../resources/node-file-observations.js';
import { resourceRevisions } from '../resources/revisions.js';
import { workspaceObservations, workspaceSourceId } from '../resources/workspace-observations.js';
import { getRun } from '../runs/store.js';

import { resolveWorkerTaskDir } from './context.js';

// Leave room for the rest of the existing 2 MiB resource response.
const MAX_PENDING_BYTES = 2 * 1024 * 1024 - 4096;

async function readLocal(root: string, file: string): Promise<string> {
  const handle = await open(
    path.join(root, file),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_PENDING_BYTES) return '';
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === info.size ? bytes.subarray(0, bytesRead).toString('utf8') : '';
  } finally {
    await handle.close();
  }
}

async function armRemoteFile(
  node: ConnectedNode,
  file: string,
  changed: () => void,
  failed: (error: Error) => void,
): Promise<() => void> {
  if (node.observationCapabilities?.fileAppends !== 1)
    throw new GatewayMethodError(
      'RESOURCE_OBSERVATION_UNSUPPORTED',
      'Node lacks notification-only watches.',
    );
  let requestId: string | undefined;
  let armed = false;
  const stop = () => {
    if (!requestId) return;
    forgetNodeFileObservation(requestId);
    if (getNode(node.machine) === node && node.ws.readyState === 1)
      void sendNodeRequest(
        node,
        'fs.watch.stop',
        { requestId },
        { requireSameConnection: true },
      ).catch((error: unknown) =>
        failed(new Error('Pending flow watch could not stop', { cause: error })),
      );
  };
  try {
    await watchNodeFile(
      node,
      file,
      (id) => {
        requestId = id;
      },
      () => {
        if (!armed || !requestId) return;
        try {
          assertFileObservationsAdmitted([requestId]);
          changed();
        } catch (error) {
          failed(new Error('Pending flow observation was revoked', { cause: error }));
        }
      },
      true,
    );
    if (!requestId) throw new Error('Pending flow watch has no request ID');
    assertFileObservationsAdmitted([requestId]);
    armed = true;
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}

/** Read only the selected live attempt. Run-scoped reads never discover a source by walking history. */
export async function readPendingRecipeFlow(
  run: Run,
): Promise<RunRecipeRunsForRunResult['pendingFlow']> {
  const { id, slotId, taskFile, liveRecipeContext } = run;
  const attemptId = liveRecipeContext?.recipeRunId;
  if (
    !taskFile ||
    liveRecipeContext?.source !== 'recipe-run-live' ||
    liveRecipeContext.isStale ||
    !attemptId ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(attemptId)
  )
    return undefined;

  try {
    const taskDir = slotId ? await resolveWorkerTaskDir(run) : path.dirname(taskFile);
    if (!taskDir) return undefined;
    const relative = path.join('artifacts', 'recipe-runs', attemptId);
    if (liveRecipeContext.artifactRoot !== path.join(taskDir, relative)) return undefined;
    const owner = slotId ? await readSlotRow(slotId) : null;
    if (slotId && (owner?.current_run_id !== id || owner.phase === SLOT_PHASE_RELEASING))
      return undefined;
    const locality = slotId ? await getSlotLocality(slotId) : null;
    const node = locality && !locality.isLocal ? getNode(locality.machine) : undefined;
    if (locality && !locality.isLocal && !node) return undefined;
    const bindingCurrent = () => {
      const latest = getRun(id);
      return (
        !!latest &&
        runEvidencePending(latest) &&
        latest.taskFile === taskFile &&
        latest.slotId === slotId &&
        latest.liveRecipeContext === liveRecipeContext &&
        (!node || (getNode(node.machine) === node && node.observationAuthority?.() !== false))
      );
    };
    const current = async () => {
      const slot = slotId ? await readSlotRow(slotId) : null;
      return (
        bindingCurrent() &&
        (!slotId ||
          (slot?.current_run_id === id &&
            slot.slot_epoch === owner?.slot_epoch &&
            slot.phase !== SLOT_PHASE_RELEASING))
      );
    };
    const resolvePath = async (relPath: string) =>
      node
        ? (
            (await sendNodeRequest(
              node,
              'fs.realpath',
              { root: taskDir, relPath },
              { requireSameConnection: true },
            )) as { path: string }
          ).path
        : realpath(path.join(taskDir, relPath));
    const root = path.join(await resolvePath('.'), relative);
    if ((await resolvePath(relative)) !== root) return undefined;

    const sourceId = workspaceSourceId(node?.machine ?? 'local', root);
    const filename = path.join(root, RECIPE_PENDING_FLOW_FILE);
    const fresh = await workspaceObservations.capture({
      root,
      sourceId,
      current,
      keys: [{ family: 'artifacts', runId: id }],
      async arm(changed, failed) {
        const stop = node
          ? await armRemoteFile(node, filename, changed, failed)
          : watchFile(filename, changed, {
              notificationsOnly: true,
              onUnavailable: (result) => {
                if (result.kind === 'error') failed(new Error(result.error.message));
                else changed();
              },
            }).stop;
        const unsubscribe = resourceRevisions.subscribe(({ changes }) => {
          if (
            changes.some(
              ({ key }) =>
                (key.family === 'run' && key.runId === id && !bindingCurrent()) ||
                (key.family === 'slot' && key.slotId === slotId),
            )
          )
            workspaceObservations.release(sourceId);
        });
        return () => {
          unsubscribe();
          stop();
        };
      },
    });
    const read = async (file: string): Promise<unknown> => {
      const text = node
        ? (
            (await sendNodeRequest(
              node,
              'fs.readText',
              { root: taskDir, relPath: path.join(relative, file) },
              { requireSameConnection: true },
            )) as NodeFsReadTextResult
          ).content
        : await readLocal(root, file);
      return text && Buffer.byteLength(text) <= MAX_PENDING_BYTES ? JSON.parse(text) : undefined;
    };
    const update = await read(RECIPE_PENDING_FLOW_FILE);
    if (!isRecipeFlowUpdate(update)) return undefined;
    const [invocation, resolution] = await Promise.all([
      read('recipe-invocation.json'),
      read('recipe-resolution.json'),
    ]);
    if (
      !isRecord(invocation) ||
      invocation.version !== 1 ||
      invocation.recipeRunId !== update.recipeRunId ||
      typeof invocation.recipeDigest !== 'string' ||
      !isRecord(resolution) ||
      resolution.schema_version !== 1 ||
      !isRecord(resolution.root) ||
      resolution.root.digest !== invocation.recipeDigest
    )
      return undefined;
    // The shared projection validates the untrusted tree, including cycles and the active node.
    const pendingFlow = { tree: resolution.flow as RecipeInvocationTree, update };
    if (
      !createEvidenceReviewModel({ evidencePending: true, pendingFlow }).flow ||
      Buffer.byteLength(JSON.stringify(pendingFlow)) > MAX_PENDING_BYTES
    )
      return undefined;
    await fresh();
    return pendingFlow;
  } catch (error) {
    // Absent, replaced or malformed transient evidence cannot change retained authority.
    if (
      !(error instanceof SyntaxError) &&
      !['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '') &&
      !(error instanceof GatewayMethodError && error.code.startsWith('RESOURCE_OBSERVATION_'))
    ) {
      console.warn('[pending-recipe-flow] Read unavailable for run', id, error);
    }
    return undefined;
  }
}
