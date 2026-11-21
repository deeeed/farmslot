import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { createEvidenceReviewModel, runEvidencePending } from '@farmslot/adapter-sdk/evidence';
import { watchFile } from '@farmslot/capabilities/fs-watch';
import {
  isRecipeFlowUpdate,
  isRecord,
  type LiveRecipeContext,
  type NodeFsReadTextResult,
  type RecipeInvocationTree,
  type Run,
  type RunRecipeRunsForRunResult,
} from '@farmslot/protocol';
import { RECIPE_PENDING_FLOW_FILE } from '@farmslot/recipe-runner';

import { GatewayMethodError } from '../core/method-error.js';
import { readSlotRow, SLOT_PHASE_RELEASING } from '../core/state.js';
import { type ConnectedNode, getNode } from '../fleet/machine-registry.js';
import { NodeRpcTimeoutError, sendNodeRequest } from '../fleet/node-rpc.js';
import {
  assertFileObservationsAdmitted,
  forgetNodeFileObservation,
  watchNodeFile,
} from '../resources/node-file-observations.js';
import { resourceRevisions } from '../resources/revisions.js';
import { workspaceObservations, workspaceSourceId } from '../resources/workspace-observations.js';
import { getRun } from '../runs/store.js';

// Leave room for the rest of the existing 2 MiB resource response.
const MAX_PENDING_BYTES = 2 * 1024 * 1024 - 4096;

interface PendingRecipeLaunch {
  taskDir: string;
  slot?: { id: string; epoch: number };
  node?: ConnectedNode;
}

interface PendingRecipeBinding extends PendingRecipeLaunch {
  runId: string;
  taskFile: Run['taskFile'];
  runSlotId: Run['slotId'];
  sourceId?: string;
}

const launchBindings = new WeakMap<LiveRecipeContext, PendingRecipeBinding>();

/** Only the launch owner can bind an attempt. Persisted context alone carries no live authority. */
export function bindPendingRecipeAttempt(
  run: Pick<Run, 'id' | 'taskFile' | 'slotId'>,
  context: LiveRecipeContext,
  launch: PendingRecipeLaunch,
): () => void {
  const binding: PendingRecipeBinding = {
    ...launch,
    runId: run.id,
    taskFile: run.taskFile,
    runSlotId: run.slotId,
  };
  launchBindings.set(context, binding);
  return () => {
    if (launchBindings.get(context) !== binding) return;
    launchBindings.delete(context);
    if (binding.sourceId) workspaceObservations.release(binding.sourceId);
  };
}

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
  current: () => Promise<boolean>,
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
    const id = requestId;
    requestId = undefined;
    armed = false;
    forgetNodeFileObservation(id);
    if (getNode(node.machine) === node && node.ws.readyState === 1)
      void sendNodeRequest(
        node,
        'fs.watch.stop',
        { requestId: id },
        { requireSameConnection: true },
      ).catch((error: unknown) =>
        failed(new Error('Pending flow watch could not stop', { cause: error })),
      );
  };
  const connect = async () => {
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
        { notificationsOnly: true, timeoutMs: 5_000 },
      );
      if (!requestId) throw new Error('Pending flow watch has no request ID');
      assertFileObservationsAdmitted([requestId]);
      armed = true;
      return stop;
    } catch (error) {
      stop();
      throw error;
    }
  };
  try {
    return await connect();
  } catch (error) {
    // The attempt keeps its producer. One lost initial ACK must not strand the viewer.
    if (!(error instanceof NodeRpcTimeoutError) || !(await current())) throw error;
    return connect();
  }
}

/** Read only the selected live attempt. Run-scoped reads never discover a source by walking history. */
export async function readPendingRecipeFlow(
  run: Run,
): Promise<RunRecipeRunsForRunResult['pendingFlow']> {
  const { id, liveRecipeContext } = run;
  const attemptId = liveRecipeContext?.recipeRunId;
  if (
    liveRecipeContext?.source !== 'recipe-run-live' ||
    liveRecipeContext.isStale ||
    !attemptId ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(attemptId)
  )
    return undefined;
  const binding = launchBindings.get(liveRecipeContext);
  if (!binding || binding.runId !== id) return undefined;
  const { taskDir, slot: launchSlot, node } = binding;

  try {
    const relative = path.join('artifacts', 'recipe-runs', attemptId);
    if (liveRecipeContext.artifactRoot !== path.join(taskDir, relative)) return undefined;
    const bindingCurrent = () => {
      const latest = getRun(id);
      return (
        !!latest &&
        runEvidencePending(latest) &&
        latest.taskFile === binding.taskFile &&
        latest.slotId === binding.runSlotId &&
        latest.liveRecipeContext === liveRecipeContext &&
        launchBindings.get(liveRecipeContext) === binding &&
        (!node ||
          (getNode(node.machine) === node &&
            node.ws.readyState === 1 &&
            node.observationAuthority?.() !== false))
      );
    };
    const current = async () => {
      const slot = launchSlot ? await readSlotRow(launchSlot.id) : null;
      return (
        bindingCurrent() &&
        (!launchSlot ||
          (slot?.current_run_id === id &&
            slot.slot_epoch === launchSlot.epoch &&
            slot.phase !== SLOT_PHASE_RELEASING))
      );
    };
    if (!(await current())) return undefined;
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

    const sourceId = workspaceSourceId(`pending-recipe:${id}:${attemptId}`, root);
    binding.sourceId = sourceId;
    const filename = path.join(root, RECIPE_PENDING_FLOW_FILE);
    const fresh = await workspaceObservations.capture({
      root,
      sourceId,
      current,
      keys: [{ family: 'artifacts', runId: id }],
      async arm(changed, failed) {
        const stop = node
          ? await armRemoteFile(node, filename, changed, failed, current)
          : watchFile(filename, changed, {
              notificationsOnly: true,
              onUnavailable: (result) => {
                if (result.kind === 'error') failed(new Error(result.error.message));
                else changed();
              },
            }).stop;
        try {
          if (!(await current()))
            throw new GatewayMethodError(
              'RESOURCE_OBSERVATION_UNAVAILABLE',
              'Pending recipe launch ownership changed while arming.',
            );
        } catch (error) {
          stop();
          throw error;
        }
        const unsubscribe = resourceRevisions.subscribe(({ changes }) => {
          if (
            changes.some(({ key }) => key.family === 'run' && key.runId === id && !bindingCurrent())
          ) {
            workspaceObservations.release(sourceId);
            return;
          }
          if (changes.some(({ key }) => key.family === 'slot' && key.slotId === launchSlot?.id))
            void current().then(
              (valid) => {
                if (!valid) workspaceObservations.release(sourceId);
              },
              (error: unknown) =>
                failed(new Error('Pending flow ownership is unavailable', { cause: error })),
            );
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
