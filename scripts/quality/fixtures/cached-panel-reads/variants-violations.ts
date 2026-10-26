import { Methods } from '@farmslot/protocol';

import { createSourceLikeClient } from './constructor-helper.js';
import { gateway } from './transport.js';

declare const search: string;
declare const slotId: string;
declare const path: string;
declare const extra: Record<string, unknown>;
declare const dynamicMethod: string;

export const uncertainSearch = () => gateway.request(Methods.ROADMAP_LIST, { search });
export const emptySearch = () => gateway.request(Methods.ROADMAP_LIST, { search: '' });
export const runSearch = () => gateway.request(Methods.RUN_LIST, { search: 'still-cacheable' });
export const slotFrozenSource = () =>
  gateway.request(Methods.GIT_SHOW, {
    slotId: 'slot',
    runId: 'run',
    ref: 'head',
    path: 'src/file.ts',
  });
export const mixedFrozenSource = () =>
  gateway.request(Methods.GIT_SHOW, {
    slotId,
    runId: 'run',
    ref: 'head',
    path: 'src/file.ts',
  });
export const unpinnedRunSource = () =>
  gateway.request(Methods.GIT_SHOW, {
    slotId: '',
    runId: 'run',
    ref: undefined,
    path: 'src/file.ts',
  });
export const absoluteOverridden = () =>
  gateway.request(Methods.FS_READ, {
    slotId: 'slot',
    path: '/private/task.md',
    ...extra,
  });
export const relativeSource = () =>
  gateway.request(Methods.FS_READ, { slotId: 'slot', path: 'src/file.ts' });
export const uncertainPath = () => gateway.request(Methods.FS_READ, { slotId: 'slot', path });
export const unresolvedMethod = () => gateway.request(dynamicMethod, {});
const direct = createSourceLikeClient(gateway.request.bind(gateway));
export const withoutCacheProvider = () => direct.status();

class AlternateReceiver {
  constructor(
    private readonly api: typeof gateway,
    private readonly fixture: boolean,
  ) {}
  read() {
    if (!this.fixture) return;
    return this.api.request(Methods.PR_LIST, {});
  }
}
const liveFixtureFlag = new AlternateReceiver(gateway, true);
export const fixtureFlagIsNotFakeReceiver = () => liveFixtureFlag.read();
