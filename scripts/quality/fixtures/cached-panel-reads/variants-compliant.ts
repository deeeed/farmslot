import { Methods } from '@farmslot/protocol';

import { commandRequest, createSourceLikeClient } from './constructor-helper.js';
import { cache, gateway } from './transport.js';

export function explicitSearch(search: string) {
  if (!search) return;
  return gateway.request(Methods.ROADMAP_LIST, { search });
}

export const frozenRunSource = () =>
  gateway.request(Methods.GIT_SHOW, {
    slotId: '',
    runId: 'retained-run',
    ref: 'frozen-head',
    path: 'src/file.ts',
  });
export const frozenRunDiff = () =>
  gateway.request(Methods.GIT_DIFF, {
    slotId: '',
    runId: 'retained-run',
    base: 'frozen-base',
    head: 'frozen-head',
  });
export const absoluteArtifact = () =>
  gateway.request(Methods.FS_READ, {
    slotId: 'slot',
    path: '/private/recorded/task/review.md',
  });
export function absoluteArtifactBranch(path: string) {
  if (path.startsWith('/')) return gateway.request(Methods.FS_READ, { slotId: 'slot', path });
}

const source = createSourceLikeClient(gateway.request.bind(gateway), () => cache);
export const constructorOwned = () => source.status();
export function commandUnion(remove: boolean) {
  const { method, params } = commandRequest(remove);
  return gateway.request(method, params);
}

const fixture = {
  request(_method: string, _params: unknown) {
    return Promise.resolve({ local: true });
  },
};
export const localFixtureTransport = () => fixture.request(Methods.PR_LIST, {});

declare const worker: {
  request(operation: { operation: 'getMetadata' | 'getQuery' }): Promise<unknown>;
};
export const workerOperation = () => worker.request({ operation: 'getMetadata' });
