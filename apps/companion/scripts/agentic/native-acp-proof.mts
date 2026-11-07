/** Real-device ACP proof against an isolated Aqua live-conversations gateway. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createAgentDeviceClient } from 'agent-device';

import type {
  NativeSessionInfo,
  NativeSessionReadResult,
  NativeWorkspaceReadResult,
  NativeWorkspaceListResult,
  PersonSessionGrant,
} from '@farmslot/protocol';
import { GatewayClient } from '../../../../packages/cli/src/gateway-client.js';

const url = process.env.NATIVE_COMPANION_GATEWAY;
const tokenFile = process.env.NATIVE_COMPANION_TOKEN_FILE;
const cwd = process.env.NATIVE_COMPANION_PROOF_CWD;
const serial = process.env.ADB_SERIAL;
assert(url && tokenFile && cwd && serial);
assert(cwd.includes('/live-conversations-proof-'));
assert.equal(new URL(url).hostname, '127.0.0.1');
const output = path.resolve(process.argv[2]!);
await mkdir(output, { recursive: true });
const grant = await new GatewayClient({ url, timeout: 60_000 }).call<PersonSessionGrant>(
  'auth.session.exchange',
  {
    credential: (await readFile(tokenFile, 'utf8')).trim(),
    deviceName: 'ACP mobile proof',
    deviceKind: 'cli',
  },
);
assert.equal(grant.session.principalId, 'proof-operator');
const conn = await new GatewayClient({
  url,
  timeout: 60_000,
  credential: { token: grant.accessToken },
}).connect();
const device = createAgentDeviceClient({
  session: 'acp-proof',
  stateDir: '/tmp/cx-acp-device-state',
  lockPolicy: 'reject',
  lockPlatform: 'android',
});
const selection = { platform: 'android' as const, serial, session: 'acp-proof' };
let session: NativeSessionInfo | undefined;
const retained = process.env.NATIVE_COMPANION_PROOF_RETAINED_SESSION;
const result: Record<string, unknown> = { pass: false, productionServicesChanged: false };
const wait = async (check: () => Promise<boolean>, label: string) => {
  const end = Date.now() + 180_000;
  while (!(await check())) {
    assert(Date.now() < end, 'Timed out: ' + label);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const target = () => ({ sessionId: session!.id, executionNodeId: 'local' });
const read = () =>
  conn.call<NativeSessionReadResult>('native.session.read', { ...target(), limit: 500 });
const ensure = async (id: string) => {
  for (let i = 0; i < 7; i++) {
    const snapshot = await device.capture.snapshot(selection);
    if (snapshot.nodes.some((n) => n.identifier === id)) return;
    const jump = snapshot.nodes.find((n) => n.identifier === 'companion-native-jump-latest');
    if (jump)
      await device.interactions.press({
        ...selection,
        selector: 'id="companion-native-jump-latest"',
      });
    else await device.interactions.scroll({ ...selection, direction: 'down', pixels: 600 });
  }
  throw Error('Missing real device control: ' + id);
};
const send = async (text: string) => {
  const after = (await read()).cursor;
  await ensure('companion-native-draft');
  await device.interactions.fill({ ...selection, selector: 'id="companion-native-draft"', text });
  await device.command.keyboard({ ...selection, action: 'dismiss' });
  await device.interactions.press({
    ...selection,
    selector: 'id="companion-native-send"',
    settle: false,
  });
  await wait(
    async () =>
      (await read()).events.some(
        (e) => e.sequence > after && e.type === 'command.submitted' && e.text === text,
      ),
    'mobile command receipt',
  );
  return after;
};
const complete = async (after: number) => {
  await wait(
    async () =>
      (await read()).events.some((e) => e.sequence > after && e.type === 'turn.completed'),
    'mobile turn complete',
  );
  const body = await read();
  assert.equal(body.session.state, 'idle');
  return body;
};
const shot = (name: string) =>
  device.capture.screenshot({ session: selection.session, path: path.join(output, name + '.png') });
try {
  if (retained)
    session = (
      await conn.call<NativeSessionReadResult>('native.session.read', {
        sessionId: retained,
        executionNodeId: 'local',
        limit: 500,
      })
    ).session;
  else {
    session = (
      await conn.call<{ session: NativeSessionInfo }>('native.session.create', {
        runner: 'claude-acp',
        model: 'haiku',
        effort: 'low',
        mode: 'default',
        approvalMode: 'ask',
        cwd,
        executionNodeId: 'local',
      })
    ).session;
  }
  assert.equal(session.ownerPrincipalId, 'proof-executor');
  assert.equal(session.requestedByPrincipalId, 'proof-operator');
  const intent = spawnSync(
    'adb',
    [
      '-s',
      serial,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      '"farmslot-development://native?sessionId=' + session.id + '&executionNodeId=local"',
      'net.siteed.farmslot.development',
    ],
    { stdio: 'ignore' },
  );
  if (intent.error) throw intent.error;
  assert.equal(intent.status, 0);
  await ensure('companion-native-draft');
  if (retained) {
    const body = await read();
    assert(
      body.events.some(
        (event) =>
          event.type === 'tool.completed' &&
          event.tool?.diffs?.some(
            (diff) => diff.newText.includes('hello ACP') && diff.newText.includes('suffix'),
          ),
      ),
    );
    await ensure('companion-native-work-fold');
    const fold = (await device.capture.snapshot(selection)).nodes.find(
      (node) => node.identifier === 'companion-native-work-fold',
    );
    if (!(fold?.label ?? '').includes('▾'))
      await device.interactions.press({
        ...selection,
        selector: 'id="companion-native-work-fold"',
      });
    let detail: { rect?: { x: number; y: number; width: number; height: number } } | undefined;
    await wait(async () => {
      detail = (await device.capture.snapshot(selection)).nodes.find((node) =>
        (node.label ?? '').includes('Details'),
      );
      return Boolean(detail?.rect);
    }, 'retained tool detail');
    assert(detail?.rect);
    await device.interactions.press({
      ...selection,
      x: Math.round(detail.rect.x + detail.rect.width / 2),
      y: Math.round(detail.rect.y + detail.rect.height / 2),
    });
    await wait(async () => {
      const nodes = (await device.capture.snapshot(selection)).nodes;
      return ['prefix', 'hello ACP', 'suffix'].every((text) =>
        nodes.some((node) => (node.label ?? '').includes(text)),
      );
    }, 'retained full-file diff');
    await shot('retained-full-file-diff');
    result.retainedWholeFileDiff = true;
  } else {
    let after = await send(
      'Output the integers from 401 to 650, one per line, with no commentary or tools.',
    );
    let visible = false;
    await wait(async () => {
      const body = await read();
      const done = body.events.some((e) => e.sequence > after && e.type === 'turn.completed');
      const snap = await device.capture.snapshot(selection);
      if (snap.nodes.some((n) => /401\s+402\s+403/.test(n.label ?? '')) && !done) {
        visible = true;
        return true;
      }
      return done;
    }, 'visible streaming text');
    assert(visible, 'Real phone text must appear while the turn is running');
    await shot('streaming');
    await complete(after);
    result.visibleStreaming = true;
    const name = 'mobile-allowed-' + crypto.randomUUID().slice(0, 8) + '.txt';
    after = await send(
      `Use Write once to create ${cwd}/${name} with exactly hello mobile ACP followed by a newline. Use no other tools. Wait for permission and do not retry if denied.`,
    );
    await wait(async () => (await read()).pendingRequests.length > 0, 'mobile Ask permission');
    await ensure('companion-native-approve');
    await shot('ask');
    await device.interactions.press({ ...selection, selector: 'id="companion-native-approve"' });
    let body = await complete(after);
    const file = await conn.call<NativeWorkspaceReadResult>('native.session.workspace.read', {
      ...target(),
      path: name,
    });
    assert.equal(file.content, 'hello mobile ACP\n');
    assert(
      body.events.some(
        (e) =>
          e.sequence > after &&
          e.type === 'tool.completed' &&
          e.tool?.diffs?.some((d) => d.path.endsWith(name)),
      ),
    );
    result.askApproved = true;
    await ensure('companion-native-work-fold');
    const folded = (await device.capture.snapshot(selection)).nodes.find(
      (node) => node.identifier === 'companion-native-work-fold',
    );
    if (!(folded?.label ?? '').includes('▾'))
      await device.interactions.press({
        ...selection,
        selector: 'id="companion-native-work-fold"',
      });
    let detail: { rect?: { x: number; y: number; width: number; height: number } } | undefined;
    await wait(async () => {
      const snapshot = await device.capture.snapshot(selection);
      detail = snapshot.nodes.find((node) => (node.label ?? '').includes('Details'));
      return Boolean(detail?.rect);
    }, 'real tool disclosure');
    assert(detail?.rect);
    await device.interactions.press({
      ...selection,
      x: Math.round(detail.rect.x + detail.rect.width / 2),
      y: Math.round(detail.rect.y + detail.rect.height / 2),
    });
    await wait(
      async () =>
        (await device.capture.snapshot(selection)).nodes.some((n) =>
          (n.label ?? '').includes('hello mobile ACP'),
        ),
      'rendered mobile diff',
    );
    await shot('diff');
    result.diffVisible = true;
    const denied = 'mobile-denied-' + crypto.randomUUID().slice(0, 8) + '.txt';
    after = await send(
      `Use Write once to create ${cwd}/${denied} containing denied. I will deny this request. After denial, stop without retrying or using other tools.`,
    );
    await wait(async () => (await read()).pendingRequests.length > 0, 'mobile denial');
    await ensure('companion-native-deny');
    await device.interactions.press({ ...selection, selector: 'id="companion-native-deny"' });
    body = await complete(after);
    const listing = await conn.call<NativeWorkspaceListResult>('native.session.workspace.list', {
      ...target(),
      path: '.',
    });
    assert(listing.entries.some((entry) => entry.name === name));
    assert(!listing.entries.some((entry) => entry.name === denied));
    assert(
      body.events.some(
        (e) =>
          e.sequence > after && e.type === 'approval.resolved' && e.response?.decision === 'deny',
      ),
    );
    result.denied = true;
    await conn.call('native.session.setApprovalMode', { ...target(), approvalMode: 'bypass' });
    const automatic = 'mobile-automatic-' + crypto.randomUUID().slice(0, 8) + '.txt';
    after = await send(
      `Use Write once to create ${cwd}/${automatic} with exactly automatic mobile ACP followed by a newline. No other tools.`,
    );
    body = await complete(after);
    const events = body.events.filter((e) => e.sequence > after);
    assert(!events.some((e) => e.type === 'approval.requested'));
    assert(
      events.some(
        (e) =>
          e.type === 'approval.resolved' &&
          e.data?.approvalMode === 'bypass' &&
          e.data?.automatic === true,
      ),
    );
    const auto = await conn.call<NativeWorkspaceReadResult>('native.session.workspace.read', {
      ...target(),
      path: automatic,
    });
    assert.equal(auto.content, 'automatic mobile ACP\n');
    await shot('bypass');
    result.bypassAuditedWithoutPrompt = true;
    await conn.call('native.session.setApprovalMode', { ...target(), approvalMode: 'ask' });
    assert.equal((await read()).session.approvalMode, 'ask');
    result.bypassOff = true;
    result.owner = session.ownerPrincipalId;
    result.requester = session.requestedByPrincipalId;
    result.sessionId = session.id;
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify(await read(), null, 2));
  }
  result.pass = true;
} catch (error) {
  result.error = String(error);
  await shot('failure');
  throw error;
} finally {
  if (session && !retained) await conn.call('native.session.close', target());
  conn.close();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
