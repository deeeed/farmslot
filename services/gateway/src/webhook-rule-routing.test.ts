import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { mock } from 'node:test';

import { getQueueSnapshot } from './backlog/dispatch-queue.js';
import * as fleet from './fleet/state.js';

mock.module('./fleet/state.js', {
  namedExports: {
    ...fleet,
    loadProjectConfigs: async () => [
      {
        name: 'webhook-rule-test',
        ci: { repo: 'owner/repo' },
        webhooks: { github_secret: 'isolated-test-secret', auto_dispatch: false },
      },
    ],
  },
});
const { handleGitHubWebhook, setGitHubRuleEventRouter } = await import('./webhook.js');

test('signed rule-enabled webhook events skip legacy dispatch, while unmatched legacy settings remain authoritative', async (t) => {
  t.after(() => setGitHubRuleEventRouter(undefined));
  let routed = 0;
  let enabled = true;
  let uncertain = false;
  setGitHubRuleEventRouter(async (pr) => {
    assert.equal(pr.repo, 'owner/repo');
    routed += 1;
    return uncertain ? 'unknown' : enabled ? 'rules' : 'legacy';
  });
  const server = createServer((req, res) => {
    void handleGitHubWebhook(req, res, () => null).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert(address && typeof address === 'object');
  const body = JSON.stringify({
    repository: { full_name: 'owner/repo' },
    action: 'opened',
    pull_request: { number: 42 },
  });
  const signature = `sha256=${createHmac('sha256', 'isolated-test-secret').update(body).digest('hex')}`;
  const send = (sig = signature) =>
    fetch(`http://127.0.0.1:${address.port}/webhook/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
      body,
    });
  const queuedBefore = getQueueSnapshot().length;
  assert.equal((await send('sha256=invalid')).status, 401);
  assert.equal(routed, 0, 'Unverified events cannot accelerate scans');
  assert.deepEqual(await (await send()).json(), { routed: 'rules', repository: 'owner/repo' });
  assert.deepEqual(await (await send()).json(), { routed: 'rules', repository: 'owner/repo' });
  assert.equal(
    getQueueSnapshot().length,
    queuedBefore,
    'Webhook retries cannot create a second legacy queue entry',
  );
  enabled = false;
  assert.deepEqual(await (await send()).json(), {
    ignored: true,
    reason: 'auto_dispatch disabled',
  });
  uncertain = true;
  const retry = await send();
  assert.equal(retry.status, 503);
  assert.equal(retry.headers.get('Retry-After'), '60');
  assert.equal(getQueueSnapshot().length, queuedBefore);
});
