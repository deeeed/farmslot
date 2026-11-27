import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { hasHealthyAppPage } from '../src/web-dapp/launch.mjs';

const origin = 'http://localhost:13001';
const marketPage = { targetId: 'market', type: 'page', url: `${origin}/order/BTC` };

test('a browser with no page at the exact app origin needs recovery', async () => {
  const client = {
    async send(method) {
      assert.equal(method, 'Target.getTargets');
      return {
        targetInfos: [
          { targetId: 'other', type: 'page', url: 'http://localhost:130010/' },
          { targetId: 'wallet', type: 'page', url: 'chrome-extension://wallet/home.html' },
        ],
      };
    },
  };
  assert.equal(await hasHealthyAppPage(client, origin), false);
});

for (const [label, document, healthy] of [
  ['a healthy market page', { documentURI: marketPage.url, documentElement: { id: '' } }, true],
  [
    'the framework error page',
    { documentURI: marketPage.url, documentElement: { id: '__next_error__' } },
    false,
  ],
  [
    'the Chrome error page',
    { documentURI: 'chrome-error://chromewebdata/', documentElement: { id: '' } },
    false,
  ],
]) {
  test(`checks ${label} before reusing the browser`, async () => {
    const client = {
      async send(method, params, sessionId) {
        if (method === 'Target.getTargets') return { targetInfos: [marketPage] };
        if (method === 'Target.attachToTarget') {
          assert.deepEqual(params, { targetId: 'market', flatten: true });
          return { sessionId: 'page' };
        }
        assert.equal(method, 'Runtime.evaluate');
        assert.equal(sessionId, 'page');
        return { result: { value: runInNewContext(params.expression, { document }) } };
      },
    };
    assert.equal(await hasHealthyAppPage(client, origin), healthy);
  });
}
