/** Isolated authenticated CC proof. Run from Aqua; never points at the operator gateway. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NativeSessionInfo, NativeSessionReadResult } from '@farmslot/protocol';

import { CdpWebPage } from '../../../packages/recipe-runner/src/runtime/cdp.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.resolve(process.argv[2] ?? '/tmp/native-approval-workspace-proof');
const reusePath = process.env.FARMSLOT_NATIVE_PROOF_REUSE;
const reuse: { root: string; closed: string[] } | undefined = reusePath
  ? JSON.parse(fs.readFileSync(reusePath, 'utf8'))
  : undefined;
const reusedId = reuse?.closed[0];
const root = await mkdtemp(path.join(tmpdir(), 'native-approval-proof-'));
await mkdir(output, { recursive: true });
for (const directory of ['scripts', 'services/gateway', 'pool', 'projects'])
  await mkdir(path.join(root, directory), { recursive: true });
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated native approval proof\n');
await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'status.json'),
  JSON.stringify({
    checkedAt: new Date().toISOString(),
    slots: [],
    summary: {
      total: 0,
      ready: 0,
      busy: 0,
      held: 0,
      manual: 0,
      disabled: 0,
      blocked: 0,
      warmCount: 0,
    },
  }),
);
if (reuse && reusedId) {
  const directory = path.join(root, 'native/sessions');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(path.join(root, 'native'), 0o700);
  for (const id of reuse.closed) {
    assert(/^[0-9a-f-]{36}$/.test(id));
    const journal = fs.readFileSync(path.join(reuse.root, 'native/sessions', id + '.journal'));
    await writeFile(path.join(directory, id + '.journal'), journal, { mode: 0o600 });
  }
}
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: '',
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
const { createGatewayAuthRuntime } = await import('../../../services/gateway/src/security/auth.js');
const { createWebSocketServer, initServerGlobals, resetServerGlobalsForTests } =
  await import('../../../services/gateway/src/server.js');
const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
const { createServer: createVite } = await import('vite');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
const owner = auth.writer.createPrincipal(
  { type: 'service', displayName: 'Proof executor' },
  roles,
  'proof-executor',
);
auth.writer.issueCredential(owner.id, 'Private bootstrap');
auth.writer.createPrincipal(
  { type: 'person', displayName: 'Proof operator' },
  roles,
  'proof-operator',
);
auth.writer.retirePrincipals(['proof-operator']);
const person = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Proof operator' },
  roles,
  'proof-operator',
  { reuseRetiredId: true },
);
const credential = auth.writer.issueCredential(person.id, 'Private browser');
const grant = auth.writer.exchangePersonCredential(credential.secret, {
  deviceName: 'Proof RPC',
  deviceKind: 'cli',
});
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;
// Start only the private host from this Aqua process before arming source observation.
// This keeps observation startup separate from the tool-policy and workspace claims.
const { NativeSessionClient } =
  await import('../../../packages/agent-runtime/src/native/client.js');
await new NativeSessionClient(path.join(root, 'native')).list(owner.id);
const server = createServer();
const wss = createWebSocketServer(server, auth);
initServerGlobals();
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const client = new GatewayClient({
  url: `ws://127.0.0.1:${address.port}/ws`,
  credential: { token: grant.accessToken },
  timeout: 60_000,
});
const connection = await client.connect();
const cdp = `http://127.0.0.1:${Number(process.env.FARMSLOT_CDP_PORT ?? 19223)}`;
let page: CdpWebPage | undefined;
let tabId: string | undefined;
let vite: Awaited<ReturnType<typeof createVite>> | undefined;
const sessions: NativeSessionInfo[] = [];
const results: Record<string, unknown> = { root, productionServicesChanged: false, proofs: [] };
async function until(
  check: () => boolean | Promise<boolean>,
  description: string,
  timeout = 60_000,
) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < end, 'Timed out: ' + description);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
const screenshot = async (name: string) => {
  assert(page);
  const shot = await page.session.call<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
  });
  await writeFile(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
};
const read = (id: string) =>
  connection.call('native.session.read', {
    sessionId: id,
    executionNodeId: 'local',
    limit: 500,
  }) as Promise<NativeSessionReadResult>;
try {
  vite = await createVite({
    configFile: path.join(repo, 'apps/command-center/ui/vite.config.ts'),
    envDir: path.join(root, 'no-env'),
    cacheDir: path.join(root, 'vite-cache'),
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 5189,
      strictPort: true,
      proxy: {
        '/ws': { target: `http://127.0.0.1:${address.port}`, ws: true },
        '/api': { target: `http://127.0.0.1:${address.port}` },
      },
    },
  });
  await vite.listen();
  const url =
    'http://127.0.0.1:5189/#native?' +
    new URLSearchParams({
      ...(reusedId ? { sessionId: reusedId } : {}),
      executionNodeId: 'local',
      cwd: homedir(),
      custom: 'true',
      runner: 'claude',
      model: 'haiku',
    });
  const target: unknown = await (
    await fetch(cdp + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })
  ).json();
  assert(
    target &&
      typeof target === 'object' &&
      'id' in target &&
      typeof target.id === 'string' &&
      'webSocketDebuggerUrl' in target &&
      typeof target.webSocketDebuggerUrl === 'string',
  );
  tabId = target.id;
  page = await CdpWebPage.connectToTarget({
    id: target.id,
    type: 'page',
    webSocketDebuggerUrl: target.webSocketDebuggerUrl,
  });
  await page.session.call('Page.bringToFront');
  await page.session.call('Runtime.enable');
  const browserErrors: unknown[] = [];
  results.browserErrors = browserErrors;
  page.session.on('Runtime.exceptionThrown', (event) => browserErrors.push(event.exceptionDetails));
  await page.waitForSelector('.auth-input', { timeoutMs: 60_000 });
  await page.setInput('.auth-input', credential.secret);
  await page.click('.auth-submit');
  let id: string;
  let snapshot: NativeSessionReadResult;
  if (reusedId) {
    // A completed, closed turn is retained evidence, never re-sent to save provider quota.
    id = reusedId;
    await page.waitForSelector('[data-testid=native-workspace-toggle]', { timeoutMs: 60_000 });
    snapshot = await read(id);
    assert(
      snapshot.events.some(
        (event) => event.type === 'turn.completed' && event.status === 'completed',
      ),
    );
    assert(snapshot.events.some((event) => event.type === 'tool.completed'));
    assert.equal(
      snapshot.events.some((event) => event.type === 'approval.requested'),
      false,
    );
    assert.equal(snapshot.session.approvalMode, 'ask');
    assert.equal(snapshot.session.state, 'closed');
    sessions.push(snapshot.session);
    results.reusedClaude = { result: reusePath, sessionId: id, promptReplayed: false };
  } else {
    await page.waitForSelector('[data-testid=native-prompt]', { timeoutMs: 60_000 });
    if (
      await page.evaluate(
        "[...document.querySelectorAll('whats-new-modal')].some(view => view.open)",
      )
    )
      await page.clickText('Got it');
    await page.waitForExpression(
      "!document.querySelector('native-session-view')?.shadowRoot?.querySelector('[data-testid=native-create]')?.disabled || document.querySelector('native-session-view')?.catalogCurrent",
      { timeoutMs: 60_000 },
    );
    assert.equal(
      await page.evaluate(
        "document.querySelector('native-session-view')?.shadowRoot?.querySelector('[data-testid=native-approval-mode]')?.value",
      ),
      'ask',
    );
    await page.click('[data-testid=native-approval-mode]');
    await page.click('[data-choice-value=bypass]');
    await page.setInput(
      '[data-testid=native-prompt]',
      'Use your shell tool to run exactly tmux list-sessions. Do not change files or sessions. Report the result briefly.',
    );
    await page.waitForExpression(
      "document.querySelector('native-session-view')?.shadowRoot?.querySelector('[data-testid=native-create]')?.disabled === false",
      { timeoutMs: 60_000 },
    );
    await screenshot('claude-bypass-launch');
    await page.click('[data-testid=native-create]');
    await page.waitForExpression(
      "new URLSearchParams(location.hash.split('?')[1]).has('sessionId')",
      { timeoutMs: 60_000 },
    );
    id = await page.evaluate<string>(
      "new URLSearchParams(location.hash.split('?')[1]).get('sessionId')",
    );
    snapshot = await read(id);
    sessions.push(snapshot.session);
    await until(
      async () => {
        snapshot = await read(id);
        return snapshot.events.some((event) => event.type === 'turn.completed');
      },
      'Claude tool completion',
      180_000,
    );
    assert(
      snapshot.events.some(
        (event) => event.type === 'turn.completed' && event.status === 'completed',
      ),
    );
    assert(snapshot.events.some((event) => event.type === 'tool.completed'));
    assert.equal(
      snapshot.events.some((event) => event.type === 'approval.requested'),
      false,
    );
    assert.equal(snapshot.session.approvalMode, 'bypass');
    assert.equal(snapshot.session.ownerPrincipalId, owner.id);
    assert.equal(snapshot.session.requestedByPrincipalId, person.id);
    await until(
      () =>
        page!.evaluate("document.querySelector('native-session-view')?.session?.state === 'idle'"),
      'Claude UI idle',
    );
    await screenshot('claude-bypass-tools');
    await page.click('[data-testid=native-approval-mode]');
    await page.click('[data-choice-value=ask]');
    await until(
      async () => (await read(id)).session.approvalMode === 'ask',
      'native permission mode acknowledgement',
    );
    const changed = await read(id);
    assert.equal(changed.session.nativeSessionId, snapshot.session.nativeSessionId);
    assert.equal(changed.session.generation, snapshot.session.generation);
    await screenshot('claude-ask-restored');
  }
  await page.clickText('Files / Changes');
  await page.waitForSelector('native-workspace');
  const emptyExpression =
    "document.querySelector('native-session-view')?.shadowRoot?.querySelector('native-workspace')?.shadowRoot?.textContent.includes('Not a git repository: no file changes to show.')";
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.waitForExpression(
      emptyExpression +
        " || Boolean(document.querySelector('native-session-view')?.shadowRoot?.querySelector('native-workspace')?.shadowRoot?.querySelector('[data-testid=workspace-retry]'))",
      { timeoutMs: 30_000 },
    );
    if (await page.evaluate(emptyExpression)) break;
    assert.ok(attempt < 3, 'Home workspace read remains unavailable after explicit source retries');
    await page.click('[data-testid=workspace-retry]');
  }
  assert(await page.evaluate(emptyExpression));
  await screenshot('non-git-changes');
  await page.clickText('Files');
  await page.waitForExpression(
    "(document.querySelector('native-session-view')?.shadowRoot?.querySelector('native-workspace')?.shadowRoot?.querySelectorAll('nav button').length ?? 0) > 0",
    { timeoutMs: 30_000 },
  );
  await screenshot('non-git-files');
  await page.click('[data-testid=native-new]');
  await page.waitForSelector('[data-testid=native-prompt]');
  await page.click('[data-testid=native-approval-mode]');
  await page.click('[data-choice-value=bypass]');
  assert.equal(
    await page.evaluate("new URLSearchParams(location.hash.split('?')[1]).get('approvalMode')"),
    'bypass',
  );
  const beforeReload = await page.evaluate<number>('performance.timeOrigin');
  await page.navigate(await page.evaluate<string>('location.href'), 60_000);
  assert.notEqual(await page.evaluate<number>('performance.timeOrigin'), beforeReload);
  await page.waitForExpression(
    "document.querySelector('native-session-view')?.shadowRoot?.querySelector('[data-testid=native-approval-mode]')?.value === 'bypass'",
    { timeoutMs: 60_000 },
  );
  await screenshot('approval-choice-reload');
  results.launchApprovalUrlReload = true;
  const proofs = [
    {
      runner: 'claude',
      model: 'haiku',
      sessionId: id,
      toolCompleted: true,
      approvals: 0,
      changedToAsk: true,
      sameConversation: true,
      nonGitChanges: true,
      filesBrowsable: true,
    },
  ];
  for (const [runner, model] of [
    ['codex', 'gpt-6-luna'],
    ['pi', process.env.FARMSLOT_PI_PROOF_MODEL ?? 'litellm/DeepSeek-V4-Flash'],
  ] as const) {
    const retained =
      reuse &&
      (await Promise.all(reuse.closed.map(read))).find(
        (body) =>
          body.session.runner === runner &&
          body.session.model === model &&
          body.session.state === 'closed',
      );
    if (retained) {
      assert.equal(retained.session.approvalMode, 'bypass');
      assert(
        retained.events.some(
          (event) => event.type === 'turn.completed' && event.status === 'completed',
        ),
      );
      assert(retained.events.some((event) => event.type === 'tool.completed'));
      assert.equal(
        retained.events.some((event) => event.type === 'approval.requested'),
        false,
      );
      sessions.push(retained.session);
      proofs.push({
        runner,
        model,
        sessionId: retained.session.id,
        toolCompleted: true,
        approvals: 0,
        changedToAsk: false,
        sameConversation: true,
        nonGitChanges: false,
        filesBrowsable: false,
      });
      await writeFile(
        path.join(output, runner + '-receipt.json'),
        JSON.stringify(retained, null, 2),
      );
      continue;
    }
    const created = (await connection.call('native.session.create', {
      executionNodeId: 'local',
      runner,
      model,
      cwd: homedir(),
      mode: 'default',
      approvalMode: 'bypass',
    })) as { session: NativeSessionInfo };
    sessions.push(created.session);
    const commandId = crypto.randomUUID();
    await connection.call('native.session.send', {
      executionNodeId: 'local',
      sessionId: created.session.id,
      commandId,
      text: 'Use your shell tool to run exactly pwd. Do not change any files. Report the directory briefly.',
    });
    let body = await read(created.session.id);
    await until(
      async () => {
        body = await read(created.session.id);
        return body.events.some(
          (event) => event.commandId === commandId && event.type === 'turn.completed',
        );
      },
      runner + ' tool completion',
      180_000,
    );
    assert(
      body.events.some((event) => event.type === 'turn.completed' && event.status === 'completed'),
    );
    assert(body.events.some((event) => event.type === 'tool.completed'));
    assert.equal(
      body.events.some((event) => event.type === 'approval.requested'),
      false,
    );
    assert.equal(body.session.approvalMode, 'bypass');
    proofs.push({
      runner,
      model,
      sessionId: created.session.id,
      toolCompleted: true,
      approvals: 0,
      changedToAsk: false,
      sameConversation: true,
      nonGitChanges: false,
      filesBrowsable: false,
    });
    await writeFile(path.join(output, runner + '-receipt.json'), JSON.stringify(body, null, 2));
  }
  results.proofs = proofs;
  results.pass = true;
} catch (error) {
  results.pass = false;
  results.error = String(error);
  if (page) {
    await screenshot('failure');
    results.ui =
      await page.evaluate(`(() => { const view = document.querySelector('native-session-view'); return view && {
      connected: view.connected, catalogCurrent: view.catalogCurrent, launchReady: view.launchReady,
      profileReady: view.profileReady, busy: view.busy, promptLength: view.prompt?.length, cwd: view.cwd,
      error: view.error, catalogError: view.catalogError, pollError: view.pollError,
      runner: view.runner, approvalMode: view.approvalMode, contexts: view.launchChoices,
    }; })()`);
  }
  throw error;
} finally {
  for (const session of sessions)
    await connection.call('native.session.close', {
      executionNodeId: 'local',
      sessionId: session.id,
    });
  results.closed = sessions.map((session) => session.id);
  await writeFile(path.join(output, 'result.json'), JSON.stringify(results, null, 2) + '\n');
  if (tabId) await fetch(cdp + '/json/close/' + tabId);
  page?.close();
  await vite?.close();
  connection.close();
  resetServerGlobalsForTests();
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const lock = path.join(root, 'native/lock/owner.json');
  if (fs.existsSync(lock)) {
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number };
    const argv = execFileSync('ps', ['-p', String(owner.pid), '-o', 'command='], {
      encoding: 'utf8',
    });
    assert(argv.includes(path.join(root, 'native')));
    const host = JSON.parse(fs.readFileSync(path.join(root, 'native/worker.json'), 'utf8')) as {
      pid: number;
    };
    const gone = (pid: number) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw error;
      }
    };
    process.kill(owner.pid, 'SIGTERM');
    await until(
      () => !fs.existsSync(path.join(root, 'native/lock')) && gone(owner.pid) && gone(host.pid),
      'private host cleanup',
    );
  }
  results.hostStopped = !fs.existsSync(lock);
  await writeFile(path.join(output, 'result.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results));
}
