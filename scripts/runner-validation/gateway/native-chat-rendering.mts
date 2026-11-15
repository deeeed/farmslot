/**
 * Native chat rendering proof. A synthetic Claude peer answers through the real native host and
 * an in-process gateway with a markdown reply (fenced TypeScript, a list, file links, inline code
 * paths) and changes one workspace file. Command Center, served by Vite from this checkout and
 * driven through CDP with real clicks, must show:
 *   code      the fenced block highlighted in its frame (language label, wrap, copy);
 *   copy      the copy button copies the block (the button says "Copied");
 *   wrap      the wrap toggle turns wrapping off;
 *   file-link a file chip opens the workspace file at its line, the line selected and in view;
 *   markdown  an inline-code `.md` path opens rendered, with a raw toggle;
 *   turn-diff the turn's changed file opens as a highlighted diff;
 *   message   the message has its own copy button.
 * Isolated: temp FARMSLOT_HOME/root, own ports, never the operator gateway.
 *
 *   TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --import tsx \
 *     scripts/runner-validation/gateway/native-chat-rendering.mts --out <dir> [--only <node,...>]
 * Needs Agent Chrome with CDP (FARMSLOT_CDP_PORT, default 9323; start it with
 * apps/command-center/scripts/debug-chrome.sh). Exits non-zero when any node fails.
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import type { NativeSessionInfo } from '@farmslot/protocol';

const NODES = ['code', 'copy', 'wrap', 'file-link', 'markdown', 'turn-diff', 'message'] as const;
type ProofNode = (typeof NODES)[number];

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: path.join(tmpdir(), 'native-chat-rendering') },
    only: { type: 'string' },
  },
});
const only = new Set(values.only ? values.only.split(',') : NODES);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.resolve(values.out);
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'native-chat-rendering-'));
for (const directory of [
  'scripts',
  'services/gateway',
  'pool',
  'projects',
  'bin',
  'claude',
  'home',
])
  await mkdir(path.join(root, directory), { recursive: true });
await mkdir(path.join(root, 'packages/agent-runtime'), { recursive: true });
fs.symlinkSync(
  path.join(repo, 'packages/agent-runtime/scripts'),
  path.join(root, 'packages/agent-runtime/scripts'),
  'dir',
);
await writeFile(path.join(root, 'CLAUDE.md'), '# Isolated native chat rendering proof\n');
await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
await writeFile(
  path.join(root, 'pool/local.json'),
  JSON.stringify({ machine: 'local', project: 'proof', host: 'localhost', slots: [] }),
);
await writeFile(path.join(root, 'status.json'), JSON.stringify({ slots: [], summary: {} }));
const executable = path.join(root, 'bin/claude');
await copyFile(
  path.join(repo, 'scripts/runner-validation/fixtures/native-chat-rendering-claude.cjs'),
  executable,
);
fs.chmodSync(executable, 0o700);

// The conversation's workspace: a git repository whose src/app.ts has 40 lines, so the line the
// answer links (42) is the first line the turn adds.
const workspace = path.join(root, 'workspace');
await mkdir(path.join(workspace, 'src'), { recursive: true });
await mkdir(path.join(workspace, 'docs'), { recursive: true });
await writeFile(
  path.join(workspace, 'src/app.ts'),
  Array.from({ length: 40 }, (_, index) => `export const value${index + 1} = ${index + 1};`).join(
    '\n',
  ) + '\n',
);
await writeFile(
  path.join(workspace, 'docs/GUIDE.md'),
  '# Greeting guide\n\nCall `greet` with a **name**.\n\n| arg | type |\n| --- | --- |\n| name | string |\n',
);
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Proof', '-c', 'user.email=proof@invalid', ...args], {
    cwd: workspace,
    stdio: 'pipe',
  });
git('init', '-q');
git('add', '.');
git('commit', '-qm', 'base');

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      assert(address && typeof address !== 'string');
      probe.close(() => resolve(address.port));
    });
  });

Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
  CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_DISABLE_ORCHESTRATION: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
delete process.env.CODEX_LB_API_KEY;

const { createGatewayAuthRuntime } = await import('../../../services/gateway/src/security/auth.js');
const { createWebSocketServer, initServerGlobals, resetServerGlobalsForTests } =
  await import('../../../services/gateway/src/server.js');
const { GatewayClient } = await import('../../../packages/cli/src/gateway-client.js');
const { NativeSessionClient } =
  await import('../../../packages/agent-runtime/src/native/client.js');

const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: process.env.FARMSLOT_HOME });
const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
const owner = auth.writer.createPrincipal(
  { type: 'service', displayName: 'Rendering proof' },
  roles,
  'rendering-proof',
);
const person = auth.writer.createPrincipal(
  { type: 'person', displayName: 'Rendering operator' },
  roles,
  'rendering-operator',
);
const credential = auth.writer.issueCredential(person.id, 'Rendering browser');
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = owner.id;

const results: Record<string, { pass: boolean; detail: unknown }> = {};
const children: ChildProcess[] = [];
let server: ReturnType<typeof createServer> | undefined;
let wss: ReturnType<typeof createWebSocketServer> | undefined;
let connection: Awaited<ReturnType<InstanceType<typeof GatewayClient>['connect']>> | undefined;
let session: NativeSessionInfo | undefined;
let runError: unknown;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const walk =
  "const walk=r=>[...r.querySelectorAll('*')].flatMap(e=>e.shadowRoot?[e,...walk(e.shadowRoot)]:[e]);const all=walk(document);";

const run = async () => {
  const native = new NativeSessionClient(path.join(root, 'native'));
  try {
    await native.warm();
  } catch (error) {
    // Under heavy host load the private host can take longer than the client's 10 s start
    // ceiling, then become ready. Wait for it once, then warm again; a second failure is real.
    const ready = path.join(root, 'native/ready.json');
    const deadline = Date.now() + 60_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await delay(250);
    if (!fs.existsSync(ready)) throw error;
    await native.warm();
  }
  server = createServer();
  wss = createWebSocketServer(server, auth);
  initServerGlobals();
  const gatewayPort = await freePort();
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(gatewayPort, '127.0.0.1', resolve));
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}/ws`;
  const grant = await auth.writer.exchangePersonCredential(credential.secret, {
    deviceName: 'Rendering RPC',
    deviceKind: 'cli',
  });
  connection = await new GatewayClient({
    url: gatewayUrl,
    credential: { token: grant.accessToken },
    timeout: 60_000,
  }).connect();
  let completed = false;
  const stopEvents = connection.onEvent((frame: { event: string; payload: unknown }) => {
    if (frame.event !== 'native.session.delta') return;
    const payload = frame.payload as { page?: { events: { type: string }[] } };
    if (payload.page?.events.some((event) => event.type === 'turn.completed')) completed = true;
  });
  session = (
    (await connection.call('native.session.create', {
      runner: 'claude',
      model: 'haiku',
      cwd: workspace,
      executionNodeId: 'local',
      mode: 'default',
      approvalMode: 'ask',
    })) as { session: NativeSessionInfo }
  ).session;
  const selection = { sessionId: session.id, executionNodeId: 'local' };
  await connection.call('native.session.subscribe', selection);
  await connection.call('native.session.send', {
    ...selection,
    commandId: crypto.randomUUID(),
    text: 'Add a greeting helper.',
  });
  const turnDeadline = Date.now() + 60_000;
  while (!completed) {
    assert.ok(Date.now() < turnDeadline, 'Timed out: turn completion');
    await delay(100);
  }
  stopEvents();

  // The browser signs in with the person credential, as a person does: the page exchanges it
  // for an expiring device session.
  await writeFile(
    path.join(root, 'home/gateways.json'),
    JSON.stringify({
      gateways: { proof: { url: gatewayUrl, authMode: 'token', secret: credential.secret } },
    }),
  );
  const uiPort = await freePort();
  const env = {
    ...process.env,
    FARMSLOT_GATEWAY: gatewayUrl,
    FARMSLOT_GATEWAY_PROFILE: 'proof',
    FARMSLOT_UI_URL: `http://127.0.0.1:${uiPort}`,
    FARMSLOT_CDP_PORT: process.env.FARMSLOT_CDP_PORT ?? '9323',
  };
  const log = fs.openSync(path.join(output, 'vite.log'), 'w');
  const ui = spawn(
    process.execPath,
    [
      path.join(repo, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(uiPort),
      '--strictPort',
    ],
    {
      cwd: path.join(repo, 'apps/command-center/ui'),
      env: { ...env, VITE_FARMSLOT_GATEWAY_URL: gatewayUrl },
      stdio: ['ignore', log, log],
    },
  );
  children.push(ui);
  const uiDeadline = Date.now() + 120_000;
  for (;;) {
    try {
      if ((await fetch(env.FARMSLOT_UI_URL)).ok) break;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    assert.equal(ui.exitCode, null, 'isolated UI exited');
    assert.ok(Date.now() < uiDeadline, 'isolated UI must start');
    await delay(300);
  }

  const cdpScript = path.join(repo, 'apps/command-center/scripts/cdp.mjs');
  // Asynchronous: the gateway runs in this process, and a synchronous child would stall it.
  const runFile = promisify(execFile);
  const cdp = async (...args: string[]): Promise<unknown> => {
    const text = (
      await runFile(process.execPath, [cdpScript, ...args], {
        cwd: repo,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      })
    ).stdout.trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      // The helper prints evaluated strings as plain text.
      if (!(error instanceof SyntaxError)) throw error;
      return text;
    }
  };
  const route = `native?sessionId=${encodeURIComponent(session.id)}&executionNodeId=local`;
  const probe = (body: string) => cdp('eval', route, `${walk}${body}`);
  const shot = (name: string) => cdp('screenshot', route, path.join(output, `${name}.png`));
  const waitFor = async <T,>(
    body: string,
    ok: (value: T) => boolean,
    label: string,
  ): Promise<T> => {
    const deadline = Date.now() + 30_000;
    let last: T | undefined;
    while (Date.now() < deadline) {
      last = (await probe(body)) as T;
      if (ok(last)) return last;
      await delay(300);
    }
    await shot(`timeout-${label.replace(/\W+/g, '-')}`);
    throw new Error(`${label}: ${JSON.stringify(last)}`);
  };
  // The What's-new card can open over the page at any point after sign-in; a person closes it.
  const dismissNews = async () => {
    if (
      await probe(
        "return all.some(e=>e.matches('whats-new-modal')&&e.shadowRoot?.querySelector('button.primary'));",
      )
    )
      await cdp('click', route, 'whats-new-modal >>> button.primary');
  };
  const click = async (selector: string) => {
    await dismissNews();
    await cdp('click', route, selector);
  };
  const check = async (node: ProofNode, prove: () => Promise<unknown>) => {
    if (!only.has(node)) return;
    try {
      results[node] = { pass: true, detail: await prove() };
      await shot(node);
    } catch (error) {
      results[node] = {
        pass: false,
        detail: error instanceof Error ? error.message : String(error),
      };
      await shot(`${node}-failed`);
    }
  };

  await cdp('goto', route, '--new');
  await waitFor<boolean>(
    "return !!document.querySelector('.auth-card,#connection-form,.onboarding-connect,farm-app');",
    Boolean,
    'app shell',
  );
  console.log('login', JSON.stringify(await cdp('login', route)));
  await cdp('goto', route);
  await cdp('focus', route);
  await waitFor<boolean>(
    "return all.some(e=>e.matches('chat-message .cm-code'));",
    Boolean,
    'the answer with its code block',
  );

  await check('code', () =>
    waitFor<{ lang: string; colored: number; text: string }>(
      `const block=all.find(e=>e.matches('chat-message .cm-code'));
       return {lang:block.querySelector('.cm-code-lang')?.textContent,
         colored:block.querySelectorAll('pre span[style*="color"]').length,
         text:block.querySelector('pre')?.textContent,
         actions:[...block.querySelectorAll('[data-code-action]')].map(b=>b.dataset.codeAction)};`,
      (value) => value.lang === 'ts' && value.colored >= 5 && value.text.includes('hello ${name}'),
      'highlighted ts block',
    ),
  );
  await check('copy', async () => {
    // "Copied" shows for 1.2 s, so it is read in the click's own CDP session, right after it.
    await dismissNews();
    const observer = path.join(output, 'copy-observe.js');
    await writeFile(
      observer,
      `${walk}const button=all.find(e=>e.matches('chat-message .cm-code [data-code-action=copy]'));
       const deadline=Date.now()+1000;
       while(button.textContent!=='Copied'&&Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
       return button.textContent;`,
    );
    const result = (await cdp(
      'click',
      route,
      'chat-message .cm-code [data-code-action=copy]',
      '--observe-file',
      observer,
    )) as { observation: string };
    assert.equal(result.observation, 'Copied');
    return result.observation;
  });
  await check('wrap', async () => {
    await click('chat-message .cm-code [data-code-action=wrap]');
    return waitFor<{ wrap: string; whiteSpace: string }>(
      `const block=all.find(e=>e.matches('chat-message .cm-code'));
       return {wrap:block.dataset.wrap, whiteSpace:getComputedStyle(block.querySelector('pre')).whiteSpace};`,
      (value) => value.wrap === 'false' && value.whiteSpace === 'pre',
      'wrap off',
    );
  });
  await check('file-link', async () => {
    await click('chat-message a.cm-file[data-file-path="src/app.ts"]');
    return waitFor<{
      path: string;
      line: number;
      row: string;
      selected: boolean;
      visible: boolean;
    }>(
      `const view=all.find(e=>e.matches('pierre-file-view'));
       if(!view) return null;
       const container=view.shadowRoot.querySelector('diffs-container');
       const row=container?.shadowRoot?.querySelector('[data-line="42"]');
       const box=row?.getBoundingClientRect(); const frame=view.getBoundingClientRect();
       const top=Math.max(frame.top,0), bottom=Math.min(frame.bottom,innerHeight);
       return {path:view.path,line:view.line,row:row?.textContent,
         selected:row?.hasAttribute('data-selected-line')||row?.closest('[data-selected-line]')!==null,
         visible:!!box&&box.top>=top&&box.bottom<=bottom};`,
      (value) =>
        value?.path === 'src/app.ts' &&
        value.line === 42 &&
        String(value.row).includes('export function greet') &&
        value.selected &&
        value.visible,
      'src/app.ts open at line 42',
    );
  });
  await check('markdown', async () => {
    await click('chat-message a.cm-file[data-file-path="docs/GUIDE.md"]');
    const rendered = await waitFor<{ heading: string; cells: number }>(
      `const md=all.find(e=>e.matches('[data-testid=workspace-markdown]'));
       return md?{heading:md.querySelector('h1')?.textContent,cells:md.querySelectorAll('td').length}:null;`,
      (value) => value?.heading === 'Greeting guide' && value.cells === 2,
      'GUIDE.md rendered',
    );
    await click(
      'native-session-view >>> native-workspace >>> [data-testid=workspace-markdown-raw]',
    );
    const raw = await waitFor<boolean>(
      "return all.some(e=>e.matches('pierre-file-view')&&e.path==='docs/GUIDE.md');",
      Boolean,
      'GUIDE.md raw',
    );
    return { rendered, raw };
  });
  await check('turn-diff', async () => {
    await click('native-session-view >>> details:has(ul.turn-files) > summary');
    await click('native-session-view >>> [data-testid=native-turn-file]');
    return waitFor<{ added: number; text: string }>(
      `const view=all.find(e=>e.matches('pierre-diff-view'));
       const container=view?.shadowRoot.querySelector('diffs-container');
       const rows=[...(container?.shadowRoot?.querySelectorAll('[data-line-type="change-addition"],[data-line-type="addition"]')??[])];
       return view?{added:rows.length,text:rows.map(r=>r.textContent).join('\\n')}:null;`,
      (value) => (value?.added ?? 0) >= 3 && value.text.includes('greet'),
      'turn diff rows',
    );
  });
  await check('message', () =>
    waitFor<string>(
      "return all.find(e=>e.matches('[data-testid=chat-copy-message]'))?.textContent?.trim();",
      (value) => value === 'Copy',
      'message copy button',
    ),
  );
};

try {
  await run();
} catch (error) {
  runError = error;
} finally {
  // Every step runs even when an earlier one fails; failures are rethrown together below.
  const teardownErrors: unknown[] = [];
  const step = async (action: () => unknown) => {
    try {
      await action();
    } catch (error) {
      teardownErrors.push(error);
    }
  };
  for (const child of children) await step(() => child.kill('SIGTERM'));
  await step(async () => {
    if (session && connection)
      await connection.call('native.session.close', {
        sessionId: session.id,
        executionNodeId: 'local',
      });
  });
  await step(() => connection?.close());
  await step(() => resetServerGlobalsForTests());
  await step(async () => {
    const sockets = wss;
    if (!sockets) return;
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  });
  await step(async () => {
    const listening = server;
    if (listening?.listening)
      await new Promise<void>((resolve) => listening.close(() => resolve()));
  });
  // The private native host outlives the gateway: stop the supervisor this root started.
  await step(async () => {
    const lock = path.join(root, 'native/lock/owner.json');
    if (!fs.existsSync(lock)) return;
    const supervisor = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid: number };
    const argv = execFileSync('ps', ['-p', String(supervisor.pid), '-o', 'command='], {
      encoding: 'utf8',
    });
    assert(argv.includes(path.join(root, 'native')));
    process.kill(supervisor.pid, 'SIGTERM');
    const deadline = Date.now() + 30_000;
    while (fs.existsSync(path.join(root, 'native/lock'))) {
      assert.ok(Date.now() < deadline, 'Timed out: private host cleanup');
      await delay(100);
    }
  });
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ results, error: runError ? String(runError) : undefined }, null, 2),
  );
  const failed = Object.entries(results).filter(([, result]) => !result.pass);
  console.log(JSON.stringify({ results, output }, null, 2));
  // Keep the private root (credentials, native journals) only when a failure needs inspecting.
  if (runError !== undefined || failed.length || teardownErrors.length) {
    process.exitCode = 1;
    console.error(`kept ${root} for inspection`);
  } else await rm(root, { recursive: true, force: true });
  if (teardownErrors.length)
    throw new AggregateError(
      runError === undefined ? teardownErrors : [runError, ...teardownErrors],
      'Proof teardown failed',
    );
  if (runError !== undefined) throw runError;
  assert.equal(failed.length, 0, `Failed nodes: ${failed.map(([node]) => node).join(', ')}`);
  assert.equal(Object.keys(results).length, only.size, 'every selected node ran');
}
