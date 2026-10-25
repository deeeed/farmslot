import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { register } from 'tsx/esm/api';

import { forbiddenPlanningMethods } from './native-planning-fixture.mjs';

const loader = register({
  namespace: 'native-planning-method-contract',
  tsconfig: fileURLToPath(new URL('../../../../packages/protocol/tsconfig.json', import.meta.url)),
});
let Methods;
try {
  ({ Methods } = await loader.import(
    '../../../../packages/protocol/src/rpc/registry.ts',
    import.meta.url,
  ));
} finally {
  await loader.unregister();
}

test('native planning command counters name registered RPC methods', () => {
  const registered = new Set(Object.values(Methods));
  for (const method of forbiddenPlanningMethods)
    assert(registered.has(method), `A nonexistent method cannot guard app commands: ${method}`);
});

test('native planning guards actual review submission and stale-action mutations', () => {
  for (const method of [
    Methods.PR_REVIEW_REQUEST,
    Methods.PR_WATCH_REFRESH,
    Methods.BACKLOG_MARK_READY,
    Methods.BACKLOG_ENQUEUE,
    Methods.WORK_GRAPH_PAUSE,
    Methods.NATIVE_SESSION_SEND,
  ])
    assert(forbiddenPlanningMethods.includes(method), `Missing actual command counter: ${method}`);
});
