/**
 * The active-run diff prefetch keeps (base to worktree, with untracked files), read by path when a
 * per-file read has nothing to show offline.
 */
import type { Run } from '@farmslot/protocol';
import {
  activeRunDiffBase,
  activeRunDiffQuery,
  type GatewayResourceCache,
} from '@farmslot/protocol/client-cache';

import { heldFileDiff } from './held-content.js';
import { runProjectDefaultBranch } from './state.js';

/**
 * The held active-run diff's section for `path`, at the base prefetch used. Resolves on the first
 * state with data: the section, or undefined when the diff does not touch the path. An error, no
 * run on a slot, or an abort resolves undefined; with nothing held it waits, as the per-file read
 * does. Observing reads the network while connected, so callers use it only offline.
 */
export function heldRunFileDiff(
  cache: Pick<GatewayResourceCache, 'observe'> | undefined,
  run: Pick<Run, 'id' | 'slotId' | 'stack' | 'project'> | null | undefined,
  path: string,
  { signal }: { signal?: AbortSignal } = {},
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
      if (state.data !== undefined) finish(heldFileDiff(state.data.diff, path));
      else if (state.status === 'error' || state.status === 'unsupported') finish(undefined);
    });
    if (done) stop();
  });
}
