/**
 * The active-run diff prefetch keeps (base to worktree, with untracked files), read by path when a
 * per-file read has nothing to show offline.
 */
import type { Run } from '@farmslot/protocol';
import {
  activeRunDiffBase,
  activeRunDiffQuery,
  applyUnifiedDiff,
  type GatewayResourceCache,
  gitBlobHash,
  parseUnifiedDiff,
} from '@farmslot/protocol/client-cache';

import { heldFileDiff } from './held-content.js';
import { runProjectDefaultBranch } from './state.js';

type HeldRun = Pick<Run, 'id' | 'slotId' | 'stack' | 'project'> | null | undefined;

const FULL_BLOB_ID = /^[0-9a-f]{40}$/;
const encoder = new TextEncoder();
// Rebuilt bytes must hash like the original, so a leading byte order mark stays text.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * The held active-run diff, at the base prefetch used. Resolves on the first state with data. An
 * error, no run on a slot, or an abort resolves undefined; with nothing held it waits, as the
 * per-file read does. Observing reads the network while connected, so callers use it only offline.
 */
function heldRunDiff(
  cache: Pick<GatewayResourceCache, 'observe'> | undefined,
  run: HeldRun,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (!cache || !run?.slotId || signal?.aborted) return Promise.resolve(undefined);
  const query = activeRunDiffQuery({
    slotId: run.slotId,
    runId: run.id,
    base: activeRunDiffBase(run, runProjectDefaultBranch),
  });
  return new Promise((resolve) => {
    let stop: (() => void) | undefined;
    let done = false;
    const finish = (diff: string | undefined) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', aborted);
      stop?.();
      resolve(diff);
    };
    const aborted = () => finish(undefined);
    signal?.addEventListener('abort', aborted, { once: true });
    stop = cache.observe(query, (state) => {
      if (state.data !== undefined) finish(state.data.diff);
      else if (state.status === 'error' || state.status === 'unsupported') finish(undefined);
    });
    if (done) stop();
  });
}

/** The held active-run diff's section for `path`, or undefined when the diff does not touch it. */
export async function heldRunFileDiff(
  cache: Pick<GatewayResourceCache, 'observe'> | undefined,
  run: HeldRun,
  path: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<string | undefined> {
  const diff = await heldRunDiff(cache, run, signal);
  return diff === undefined ? undefined : heldFileDiff(diff, path);
}

/**
 * The new side of a file the held active-run diff touches, such as an added or untracked file:
 * the held blob by its full new id (the gateway diffs with `--full-index`), opened. Otherwise the
 * section applied to its held base, empty for a new file, kept only when it hashes to that id.
 * Undefined for a deleted or untouched file, or when nothing verifies.
 */
export async function heldRunFileContent(
  cache: Pick<GatewayResourceCache, 'observe' | 'openContent' | 'readContent'> | undefined,
  run: HeldRun,
  path: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<string | undefined> {
  const diff = await heldRunDiff(cache, run, signal);
  const file =
    diff === undefined ? undefined : parseUnifiedDiff(diff).find((entry) => entry.newPath === path);
  const id = file?.newId;
  if (!cache || !file || !id || !FULL_BLOB_ID.test(id) || signal?.aborted) return undefined;
  const held = await cache.openContent({ kind: 'blob', id }).catch(() => undefined);
  if (held) return decoder.decode(held);
  const base = !file.oldPath
    ? new Uint8Array()
    : file.oldId && FULL_BLOB_ID.test(file.oldId)
      ? await cache.readContent({ kind: 'blob', id: file.oldId }).catch(() => undefined)
      : undefined;
  if (!base || signal?.aborted) return undefined;
  const text =
    file.hunks.length || file.malformed
      ? applyUnifiedDiff(decoder.decode(base), file)
      : decoder.decode(base);
  return text !== undefined && gitBlobHash(encoder.encode(text)) === id ? text : undefined;
}
