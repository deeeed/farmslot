/** Continue a closed isolated ACP proof through the shipped CC Resume and Stop controls. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { NativeSessionReadResult, PersonSessionGrant } from '@farmslot/protocol';
import { GatewayClient } from '../../../packages/cli/src/gateway-client.js';
import { CdpWebPage, type CdpTargetInfo } from '../../../packages/recipe-runner/src/runtime/cdp.js';

const setup = JSON.parse(
  await readFile(path.join(process.argv[2]!, 'connection.json'), 'utf8'),
) as { root: string; gatewayUrl: string; operatorCredentialFile: string };
assert(path.basename(setup.root).startsWith('live-conversations-proof-'));
const prior = JSON.parse(await readFile(process.argv[3]!, 'utf8')) as NativeSessionReadResult;
assert.equal(prior.session.runner, 'claude-acp');
assert(prior.session.cwd.startsWith(setup.root + path.sep));
const output = path.resolve(process.argv[4]!);
await mkdir(output, { recursive: true });
const grant = await new GatewayClient({
  url: setup.gatewayUrl,
  timeout: 60_000,
}).call<PersonSessionGrant>('auth.session.exchange', {
  credential: await readFile(setup.operatorCredentialFile, 'utf8'),
  deviceName: 'ACP resume proof',
  deviceKind: 'cli',
});
const conn = await new GatewayClient({
  url: setup.gatewayUrl,
  timeout: 60_000,
  credential: { token: grant.accessToken },
}).connect();
const targets = (await (await fetch('http://127.0.0.1:19223/json/list')).json()) as CdpTargetInfo[];
const target = targets.find((row) => row.url?.startsWith('http://127.0.0.1:5191/'));
assert(target);
const page = await CdpWebPage.connectToTarget(target);
const selection = { sessionId: prior.session.id, executionNodeId: 'local' };
const read = () =>
  conn.call<NativeSessionReadResult>('native.session.read', { ...selection, limit: 500 });
const wait = async (check: () => Promise<boolean>, label: string) => {
  const end = Date.now() + 180_000;
  while (!(await check())) {
    assert(Date.now() < end, 'Timed out: ' + label);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const result: Record<string, unknown> = { pass: false };
try {
  await page.session.call('Page.navigate', {
    url: 'http://127.0.0.1:5191/#native?' + new URLSearchParams(selection),
  });
  await page.waitForSelector('[data-testid=native-resume]');
  await page.click('[data-testid=native-resume]');
  await wait(async () => {
    const b = await read();
    return b.session.state === 'idle' && b.session.generation !== prior.session.generation;
  }, 'resumed generation');
  let body = await read();
  assert.equal(body.session.nativeSessionId, prior.session.nativeSessionId);
  assert.equal(body.session.effort, 'low');
  assert.equal(body.session.model, 'haiku');
  assert.equal(body.session.cwd, prior.session.cwd);
  result.sameConversation = true;
  result.configurationPreserved = true;
  let after = body.cursor;
  await page.setInput(
    '[data-testid=native-message]',
    'What filename did I last ask you to write? Reply with the basename only, without tools.',
  );
  await page.click('[data-testid=native-send]');
  await wait(
    async () =>
      (await read()).events.some((e) => e.sequence > after && e.type === 'turn.completed'),
    'resumed turn',
  );
  body = await read();
  assert(
    body.events
      .filter((e) => e.sequence > after && e.type === 'text.delta')
      .map((e) => e.text)
      .join('')
      .includes('ask-restored.txt'),
  );
  result.retainedContext = true;
  after = body.cursor;
  await page.setInput(
    '[data-testid=native-message]',
    'Output the integers from 1 to 10000, one per line, with no commentary or tools.',
  );
  await page.click('[data-testid=native-send]');
  await wait(
    async () => (await read()).events.some((e) => e.sequence > after && e.type === 'text.delta'),
    'active turn',
  );
  await page.click('[data-testid=native-stop]');
  await wait(
    async () =>
      (await read()).events.some((e) => e.sequence > after && e.type === 'turn.completed'),
    'stopped turn',
  );
  body = await read();
  assert(
    body.events.some(
      (e) => e.sequence > after && e.type === 'turn.completed' && e.status === 'interrupted',
    ),
  );
  result.stopConfirmed = true;
  result.pass = true;
  await writeFile(path.join(output, 'receipt.json'), JSON.stringify(body, null, 2));
  const shot = await page.session.call<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
  });
  await writeFile(path.join(output, 'stopped.png'), Buffer.from(shot.data, 'base64'));
} catch (error) {
  result.error = String(error);
  throw error;
} finally {
  await conn.call('native.session.close', selection);
  const closed = await read();
  result.processStopped = closed.session.processStopped;
  assert.equal(closed.session.processStopped, true);
  page.close();
  conn.close();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
