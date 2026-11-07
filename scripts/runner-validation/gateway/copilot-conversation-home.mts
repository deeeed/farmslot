/** Drive the configured private Co-Pilot through the shipped prompt-first UI. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  CopilotStatusResult,
  NativeSessionReadResult,
  NativeSessionListResult,
} from '@farmslot/protocol';
import { CdpWebPage } from '../../../packages/recipe-runner/src/runtime/cdp.js';
import { GatewayClient } from '../../../packages/cli/src/gateway-client.js';

const fixtureFile = process.argv[2];
assert(fixtureFile, "Pass this lane's private fixture connection.json");
const fixture = JSON.parse(await readFile(fixtureFile, 'utf8')) as {
  root: string;
  gatewayUrl: string;
  credentialFile: string;
};
assert(path.basename(fixture.root).startsWith('live-conversations-proof-'));
assert(fixture.credentialFile === path.join(fixture.root, 'companion.secret'));
const url = new URL(fixture.gatewayUrl);
assert.equal(url.hostname, '127.0.0.1');
assert(Number(url.port) > 10000);
const output = path.resolve(
  process.argv[3] ?? path.join(path.dirname(fixtureFile), 'copilot-home'),
);
await mkdir(output, { recursive: true });
const client = new GatewayClient({
  url: fixture.gatewayUrl,
  credential: { token: await readFile(fixture.credentialFile, 'utf8') },
  timeout: 120000,
});
const connection = await client.connect();
const cdp = `http://127.0.0.1:${Number(process.env.FARMSLOT_CDP_PORT ?? 19224)}`;
const targets = (await (await fetch(cdp + '/json/list')).json()) as Array<{
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}>;
const target = targets.find(
  (target) => target.type === 'page' && target.url.startsWith('http://127.0.0.1:5191/'),
);
assert(target, 'The owned private proof page must already be open');
const page = await CdpWebPage.connectToTarget(target);
const result: Record<string, unknown> = { pass: false, productionServicesChanged: false };
const wait = async (read: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 180000;
  while (!(await read())) {
    assert(Date.now() < deadline, 'Timed out: ' + label);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
async function passive<T>(method: string, params = {}): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await connection.call<T>(method, params);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (
        !['RESOURCE_OBSERVATION_UNAVAILABLE', 'RESOURCE_OBSERVATION_CHANGED'].includes(
          String(code),
        ) ||
        Date.now() >= deadline
      )
        throw error;
      result.transientReadRefusals = Number(result.transientReadRefusals ?? 0) + 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
let sessionId: string | undefined;
const approvals = new Set<string>();
try {
  const reuse = process.env.FARMSLOT_COPILOT_PROOF_REUSE === '1';
  if (!reuse)
    await connection.call('copilot.configure', {
      runner: 'codex',
      model: 'gpt-6-luna',
      effort: 'low',
      autostart: false,
    });
  await page.session.call('Page.bringToFront');
  await page.session.call('Page.navigate', { url: 'http://127.0.0.1:5191/#copilot' });
  await page.waitForSelector('[data-testid=copilot-target]');
  const choose = async (agent: boolean) => {
    const pages = execFileSync('mcporter', ['call', 'agent-chrome.list_pages'], {
      encoding: 'utf8',
    });
    const id = /^([0-9]+):.*http:\/\/127\.0\.0\.1:5191\//m.exec(pages)?.[1];
    assert(id, 'The isolated Agent Chrome must contain the private proof page');
    await page.click('[data-testid=copilot-target]');
    const snapshot = execFileSync(
      'mcporter',
      ['call', 'agent-chrome.take_snapshot', 'pageId=' + id],
      { encoding: 'utf8' },
    );
    const label = agent ? 'New native session' : 'Farm Co-Pilot';
    const option = new RegExp('uid=(\\S+) option "' + label + '"').exec(snapshot)?.[1];
    assert(option, 'The real native select must expose ' + label);
    execFileSync('mcporter', ['call', 'agent-chrome.click', 'pageId=' + id, 'uid=' + option], {
      encoding: 'utf8',
    });
    await page.waitForExpression(
      `document.querySelector('chat-panel')?.targetChoice === '${agent ? 'agent' : 'copilot'}'`,
    );
  };
  await choose(true);
  await page.waitForSelector('[data-testid=native-prompt]');
  const draft = 'Output the integers from 1 to 80, one per line, with no commentary or tool calls.';
  await page.setInput('[data-testid=native-prompt]', draft);
  const before = await connection.call<NativeSessionListResult>('native.session.list', {});
  await choose(false);
  await page.waitForExpression(
    `document.querySelector('chat-panel')?.querySelector('native-session-view')?.shadowRoot?.querySelector('[data-testid=native-prompt], [data-testid=native-message]')?.value === ${JSON.stringify(draft)}`,
  );
  const held = await connection.call<NativeSessionListResult>('native.session.list', {});
  assert.deepEqual(
    held.sessions.map((session) => session.id),
    before.sessions.map((session) => session.id),
    'Target switching starts no runner',
  );
  result.draftOnlyHandoff = true;
  let sendAfterStart = false;
  if (!reuse) {
    const firstSend = await page.evaluate<boolean>(
      "Boolean(document.querySelector('native-session-view')?.shadowRoot?.querySelector('[data-testid=native-create]'))",
    );
    if (firstSend) {
      await page.waitForExpression(
        "document.querySelector('native-session-view')?.shadowRoot?.querySelector('[data-testid=native-create]')?.disabled === false",
      );
      await page.click('[data-testid=native-create]');
    } else {
      await page.click('[data-testid=copilot-restart]');
      sendAfterStart = true;
    }
  }
  await wait(async () => {
    const status = await passive<CopilotStatusResult>('copilot.status');
    sessionId = status.session.nativeSession?.sessionId;
    if (status.session.status === 'failed')
      throw new Error(status.session.terminalReason ?? 'Co-Pilot failed');
    return Boolean(sessionId && status.session.status === 'running');
  }, 'singleton binding');
  assert(sessionId);
  result.reusedCompletedProof = reuse;
  if (sendAfterStart) {
    await wait(async () => {
      const snapshot = await passive<NativeSessionReadResult>('native.session.read', {
        sessionId,
        executionNodeId: 'local',
        limit: 500,
      });
      const approval = snapshot.pendingRequests.find(
        (event) => event.type === 'approval.requested',
      );
      if (approval?.request && !approvals.has(approval.request.id)) {
        assert.equal(
          approval.request?.tool?.command,
          'cat ' + path.join(fixture.root, 'home/copilot-runtime/bootstrap.md'),
        );
        await page.waitForSelector('[data-testid=native-approve]');
        await page.click('[data-testid=native-approve]');
        approvals.add(approval.request.id);
        result.bootstrapReadApproved = true;
      }
      return snapshot.session.state === 'idle';
    }, 'bootstrap idle');
    await page.waitForExpression(
      "document.querySelector('native-session-view')?.canSubmitPrompt === true",
    );
    await page.setInput('[data-testid=native-message]', draft);
    await page.click('[data-testid=native-send]');
  }
  let body: NativeSessionReadResult;
  await wait(async () => {
    body = await passive<NativeSessionReadResult>('native.session.read', {
      sessionId,
      executionNodeId: 'local',
      limit: 500,
    });
    const approval = body.pendingRequests.find((event) => event.type === 'approval.requested');
    if (approval?.request && !approvals.has(approval.request.id)) {
      assert.equal(
        approval.request?.tool?.command,
        'cat ' + path.join(fixture.root, 'home/copilot-runtime/bootstrap.md'),
        'Only the owned bootstrap read is authorized by this proof',
      );
      await page.waitForSelector('[data-testid=native-approve]');
      await page.click('[data-testid=native-approve]');
      approvals.add(approval.request.id);
      result.bootstrapReadApproved = true;
    }
    const submitted = body.events.find(
      (event) => event.type === 'command.submitted' && event.text === draft,
    );
    return Boolean(
      submitted &&
      body.commands.some(
        (receipt) => receipt.commandId === submitted.commandId && receipt.state === 'completed',
      ),
    );
  }, 'first explicit message receipt');
  body = await passive<NativeSessionReadResult>('native.session.read', {
    sessionId,
    executionNodeId: 'local',
    limit: 500,
  });
  assert.equal(
    body.events.filter((event) => event.type === 'command.submitted' && event.text === draft)
      .length,
    1,
  );
  assert.equal(body.session.ownerPrincipalId, 'proof-executor');
  assert.equal(body.session.requestedByPrincipalId, 'proof-operator');
  result.sessionId = sessionId;
  result.owner = body.session.ownerPrincipalId;
  result.requester = body.session.requestedByPrincipalId;
  result.firstMessageExactlyOnce = true;
  const timeOrigin = await page.evaluate<number>('performance.timeOrigin');
  let loaded = false;
  const stopLoad = page.session.on('Page.loadEventFired', () => {
    loaded = true;
  });
  await page.session.call('Page.reload');
  await wait(
    async () => loaded && (await page.evaluate<number>('performance.timeOrigin')) !== timeOrigin,
    'new document after reload',
  );
  stopLoad();
  await page.waitForSelector('[data-testid=copilot-stop]');
  const restored = await passive<CopilotStatusResult>('copilot.status');
  assert.equal(restored.session.nativeSession?.sessionId, sessionId);
  result.reusedAfterReload = true;
  const screenshot = await page.session.call<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
  });
  await writeFile(path.join(output, 'copilot-home.png'), Buffer.from(screenshot.data, 'base64'));
  await page.click('[data-testid=copilot-stop]');
  await wait(
    async () => (await passive<CopilotStatusResult>('copilot.status')).session.status === 'stopped',
    'explicit singleton stop',
  );
  result.explicitStopPassed = true;
  result.pass = true;
} catch (error) {
  result.error = String(error);
  throw error;
} finally {
  if (sessionId && !result.explicitStopPassed) {
    const [closed] = await Promise.allSettled([
      connection.call('copilot.stop', { reason: 'private-proof-cleanup' }),
    ]);
    if (closed.status === 'rejected') {
      result.pass = false;
      result.cleanupError = String(closed.reason);
    }
  }
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  page.close();
  connection.close();
  console.log(JSON.stringify(result));
}

assert.equal(result.pass, true, String(result.cleanupError ?? result.error));
