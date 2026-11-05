import type {
  GitShowBatchParams,
  GitShowBatchResult,
  GitShowParams,
  GitShowResult,
} from '../rpc/git.js';
import { Methods } from '../rpc/registry.js';

import { base64Bytes, gitBlobHashInSlices } from './content.js';
import { type ResourceQuery, resourceQuery } from './registry.js';
import type { GatewayResourceCache } from './types.js';

type StoredResourceReader = Pick<GatewayResourceCache, 'retry' | 'readStored'>;

/** Display reads may use held data after a failed refresh, within the same cache owner. */
export async function readStoredResource<T>(
  current: () => StoredResourceReader | undefined,
  query: ResourceQuery<T>,
  onStored?: (data: T) => unknown,
): Promise<T> {
  const cache = current();
  if (!cache) throw new Error('The offline store is not open yet');
  const held = cache.readStored ? await cache.readStored(query) : undefined;
  if (cache !== current()) throw new Error('The offline store owner changed');
  if (onStored && held?.data !== undefined) await onStored(held.data);
  const state = onStored || held?.data === undefined ? await cache.retry(query) : held;
  if (cache !== current()) throw new Error('The offline store owner changed');
  if (state.data === undefined)
    throw Object.assign(new Error(state.error?.message ?? 'Nothing stored yet'), {
      code: state.error?.code,
    });
  return state.data;
}

export function gitSourceAlias(params: GitShowParams): string {
  return `git-source:${JSON.stringify([params.slotId, params.runId, params.ref, params.path])}`;
}

/** Immutable source opens from held blobs, then uses the existing byte batch contract. */
export async function readGitSource(
  current: () => GatewayResourceCache | undefined,
  params: GitShowParams,
  read?: (params: GitShowBatchParams) => Promise<GitShowBatchResult>,
  id?: string,
): Promise<GitShowResult> {
  const cache = current();
  if (!cache) throw new Error('The offline store is not open yet');
  const token = cache.contentWriteToken();
  const immutable = /^[0-9a-f]{40}$/i.test(params.ref);
  const alias = immutable ? gitSourceAlias(params) : undefined;
  let data = id ? await cache.openContent({ kind: 'blob', id }) : undefined;
  data ??= alias ? await cache.openContentByAlias(alias) : undefined;
  if (cache !== current()) throw new Error('The offline store owner changed');
  if (data) {
    const heldId = await gitBlobHashInSlices(data);
    if (id && heldId !== id) throw new Error('Reviewed source content does not match its blob');
    if (cache !== current()) throw new Error('The offline store owner changed');
    return { content: new TextDecoder().decode(data), id: heldId };
  }
  const { path, ...scope } = params;
  const request = {
    ...scope,
    paths: [path],
    maxBytes: 10 * 1024 * 1024,
    maxFileBytes: 10 * 1024 * 1024,
  };
  const page = await (read
    ? read(request)
    : readStoredResource(current, resourceQuery<GitShowBatchResult>(Methods.GIT_SHOW, request)));
  if (cache !== current()) throw new Error('The offline store owner changed');
  const entry = page.entries[0];
  if (!entry?.id) throw new Error(`Reviewed source is unavailable: ${entry?.status ?? 'missing'}`);
  if (entry.status === 'held') data = await cache.openContent({ kind: 'blob', id: entry.id });
  else if (entry.status === 'ok') data = base64Bytes(entry.content ?? '');
  if (!data || (await gitBlobHashInSlices(data)) !== entry.id)
    throw new Error('Reviewed source content does not match its blob');
  if (cache !== current()) throw new Error('The offline store owner changed');
  await cache.storeContent({
    key: { kind: 'blob', id: entry.id },
    data,
    origin: 'opened',
    cohort: 'gate',
    token,
    ...(alias ? { alias } : {}),
  });
  if (cache !== current()) throw new Error('The offline store owner changed');
  return { content: new TextDecoder().decode(data), id: entry.id };
}
