/** Use the isolated Aqua live-conversations gateway, never the operator gateway. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  NativeSessionInfo,
  NativeSessionReadResult,
  PersonSessionGrant,
} from '@farmslot/protocol';
import { GatewayClient } from '../../../packages/cli/src/gateway-client.js';
import { CdpWebPage, type CdpTargetInfo } from '../../../packages/recipe-runner/src/runtime/cdp.js';

const setup = JSON.parse(
  await readFile(path.join(process.argv[2]!, 'connection.json'), 'utf8'),
) as {
  root: string;
  gatewayUrl: string;
  operatorCredentialFile: string;
};
assert(path.basename(setup.root).startsWith('live-conversations-proof-'));
const output = path.resolve(process.argv[3]!);
await mkdir(output, { recursive: true });
const grant = await new GatewayClient({
  url: setup.gatewayUrl,
  timeout: 60_000,
}).call<PersonSessionGrant>('auth.session.exchange', {
  credential: await readFile(setup.operatorCredentialFile, 'utf8'),
  deviceName: 'ACP controls proof',
  deviceKind: 'cli',
});
const connection = await new GatewayClient({
  url: setup.gatewayUrl,
  credential: { token: grant.accessToken },
  timeout: 60_000,
}).connect();
const targets = (await (await fetch('http://127.0.0.1:19223/json/list')).json()) as CdpTargetInfo[];
const target = targets.find(
  (row) => row.type === 'page' && row.url?.startsWith('http://127.0.0.1:5191/'),
);
assert(target);
const page = await CdpWebPage.connectToTarget(target);
const cwd = await mkdtemp(path.join(setup.root, 'acp-control-'));
const sessions: NativeSessionInfo[] = [];
const result: Record<string, unknown> = { pass: false, productionServicesChanged: false };
const wait = async (check: () => Promise<boolean>, description: string) => {
  const end = Date.now() + 180_000;
  while (!(await check())) {
    assert(Date.now() < end, 'Timed out: ' + description);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};
const read = (session: NativeSessionInfo) =>
  connection.call<NativeSessionReadResult>('native.session.read', {
    sessionId: session.id,
    executionNodeId: 'local',
    limit: 500,
  });
const show = async (session: NativeSessionInfo) => {
  await page.session.call('Page.navigate', {
    url:
      'http://127.0.0.1:5191/#native?' +
      new URLSearchParams({ sessionId: session.id, executionNodeId: 'local' }),
  });
  await page.waitForSelector('[data-testid=native-message]', { timeoutMs: 60_000 });
};
const screenshot = async (name: string) => {
  const image = await page.session.call<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
  });
  await writeFile(path.join(output, name + '.png'), Buffer.from(image.data, 'base64'));
};
const send = async (session: NativeSessionInfo, text: string) => {
  const before = (await read(session)).cursor;
  await page.setInput('[data-testid=native-message]', text);
  await page.click('[data-testid=native-send]');
  await wait(
    async () =>
      (await read(session)).events.some(
        (event) =>
          event.sequence > before && event.type === 'command.submitted' && event.text === text,
      ),
    'UI command receipt',
  );
  return before;
};
const complete = async (session: NativeSessionInfo, after: number) => {
  await wait(
    async () =>
      (await read(session)).events.some(
        (event) => event.sequence > after && event.type === 'turn.completed',
      ),
    'turn completion',
  );
  const receipt = await read(session);
  assert.equal(receipt.session.state, 'idle');
  return receipt;
};
try {
  const created = await connection.call<{ session: NativeSessionInfo }>('native.session.create', {
    runner: 'claude-acp',
    model: 'haiku',
    effort: 'low',
    mode: 'default',
    approvalMode: 'ask',
    cwd,
    executionNodeId: 'local',
  });
  const session = created.session;
  sessions.push(session);
  assert.equal(session.ownerPrincipalId, 'proof-executor');
  assert.equal(session.requestedByPrincipalId, 'proof-operator');
  assert.equal(session.model, 'haiku');
  assert.equal(session.effort, 'low');
  assert.equal(session.cwd, cwd);
  await show(session);
  let after = await send(
    session,
    `Use the Write tool to create ${cwd}/allowed.txt with exactly hello ACP followed by a newline. Do not use any other tools. Wait for my permission and do not retry if denied.`,
  );
  await wait(async () => (await read(session)).pendingRequests.length > 0, 'Ask permission');
  await page.waitForSelector('[data-testid=native-approve]');
  await screenshot('ask');
  await page.click('[data-testid=native-approve]');
  let receipt = await complete(session, after);
  assert.equal(await readFile(path.join(cwd, 'allowed.txt'), 'utf8'), 'hello ACP\n');
  assert(
    receipt.events.some(
      (event) =>
        event.type === 'tool.completed' &&
        event.tool?.diffs?.some((diff) => diff.path.endsWith('allowed.txt')),
    ),
  );
  await writeFile(path.join(output, 'ask-receipt.json'), JSON.stringify(receipt, null, 2));
  result.askApproved = true;

  after = await send(
    session,
    `Use Write once to create ${cwd}/denied.txt containing denied. I will deny this request. After the denial, reply DENIED and stop. Do not retry or use other tools.`,
  );
  await wait(async () => (await read(session)).pendingRequests.length > 0, 'Deny permission');
  await page.waitForSelector('[data-testid=native-deny]');
  await page.click('[data-testid=native-deny]');
  receipt = await complete(session, after);
  await assert.rejects(readFile(path.join(cwd, 'denied.txt')), { code: 'ENOENT' });
  assert(
    receipt.events.some(
      (event) =>
        event.sequence > after &&
        event.type === 'approval.resolved' &&
        event.response?.decision === 'deny',
    ),
  );
  result.denyPreventedWrite = true;

  await connection.call('native.session.setApprovalMode', {
    sessionId: session.id,
    executionNodeId: 'local',
    approvalMode: 'bypass',
  });
  after = await send(
    session,
    `Use Write once to create ${cwd}/bypass.txt with exactly automatic ACP followed by a newline. Do not use other tools.`,
  );
  receipt = await complete(session, after);
  assert.equal(await readFile(path.join(cwd, 'bypass.txt'), 'utf8'), 'automatic ACP\n');
  const turn = receipt.events.filter((event) => event.sequence > after);
  assert(!turn.some((event) => event.type === 'approval.requested'));
  assert(
    turn.some(
      (event) =>
        event.type === 'approval.resolved' &&
        event.data?.approvalMode === 'bypass' &&
        event.data?.automatic === true,
    ),
  );
  await writeFile(path.join(output, 'bypass-receipt.json'), JSON.stringify(receipt, null, 2));
  result.bypassAuditedWithoutPrompt = true;
  await connection.call('native.session.setApprovalMode', {
    sessionId: session.id,
    executionNodeId: 'local',
    approvalMode: 'ask',
  });
  after = await send(
    session,
    `Use Write once to create ${cwd}/ask-restored.txt containing restored. Wait for permission. If denied, stop without retrying.`,
  );
  await wait(
    async () => (await read(session)).pendingRequests.length > 0,
    'Ask restored on same conversation',
  );
  await page.waitForSelector('[data-testid=native-deny]');
  await screenshot('ask-restored');
  await page.click('[data-testid=native-deny]');
  receipt = await complete(session, after);
  result.askRestoredSameConversation = receipt.session.nativeSessionId === session.nativeSessionId;
  assert(result.askRestoredSameConversation);
  await writeFile(path.join(output, 'final-receipt.json'), JSON.stringify(receipt, null, 2));
  result.session = receipt.session;
  result.pass = true;
} catch (error) {
  result.error = String(error);
  await screenshot('failure');
  throw error;
} finally {
  for (const session of sessions)
    await connection.call('native.session.close', {
      sessionId: session.id,
      executionNodeId: 'local',
    });
  page.close();
  connection.close();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ pass: result.pass, error: result.error }));
}
