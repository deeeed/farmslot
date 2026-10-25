// Rendering proof from the retained real-worker readback. Setup fixtures are not
// gateway-derivation evidence. UI state changes only through normal navigation/clicks.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { testGatewayProfile } from '../../lib/test-gateway-identity-source.mts';

const input = process.argv[2];
assert(input, 'Pass the retained real-worker readback.json');
assert(process.env.FARMSLOT_CDP_PORT, 'Use an existing owned browser CDP port');
const captured = JSON.parse(await readFile(input, 'utf8'));
const root = await mkdtemp(path.join(os.tmpdir(), 'derived-acceptance-ui-'));
const output = path.dirname(path.resolve(input));
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
  FARMSLOT_HOME: root,
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
const source = path.resolve(new URL('../../../', import.meta.url).pathname);
const load = (file: string) => import(new URL(file, new URL('../../../', import.meta.url)).href);
await load('services/gateway/src/runtime/mock-pty.test-support.ts');
const store = await load('services/gateway/src/runs/store.ts');
const { createGatewayAuthRuntime } = await load('services/gateway/src/security/auth.ts');
const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: root });
const operator = auth.writer.createPrincipal(
  { type: 'service', displayName: 'acceptance-rendering-proof' },
  [{ role: 'admin', scope: { kind: 'global' } }],
);
const credential = auth.writer.issueCredential(operator.id, 'Disposable rendering proof');
const { createWebSocketServer } = await load('services/gateway/src/server.ts');
const server = createServer(),
  wss = createWebSocketServer(server, auth);
const exec = promisify(execFile);
let ui: ViteDevServer | undefined;
let browserEnv: NodeJS.ProcessEnv;
let route: string | undefined;
let runId: string | undefined;
const browser = async (...args: string[]) => {
  const result = await exec(
    process.execPath,
    [path.join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
    { env: browserEnv, cwd: source, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
  );
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
};
const checks: unknown[] = [];
try {
  const project = 'acceptance-rendering';
  const repo = path.join(root, 'projects', project);
  await mkdir(path.join(root, 'pool'), { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(
    path.join(repo, 'project.json'),
    JSON.stringify({ name: project, task_dir: 'tasks', hooks: {} }),
  );
  await writeFile(
    path.join(root, 'pool/local.json'),
    JSON.stringify({
      machine: 'local',
      host: 'localhost',
      ssh_user: os.userInfo().username,
      project,
      platform: 'cli',
      slots: [{ id: 'acceptance-rendering', repo, session: 'acceptance-rendering' }],
    }),
  );
  const run = store.createRun({
    project,
    flowType: 'pr-complete',
    mode: 'autonomous',
    ticketOrPr: 'example/repo#1',
    transport: 'tmux',
    slotId: 'acceptance-rendering',
  });
  runId = run.id;
  const taskDir = path.join(repo, 'tasks/pr-complete', run.id);
  await mkdir(path.join(taskDir, 'inputs'), { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# Acceptance rendering fixture\n');
  await writeFile(
    path.join(taskDir, 'CHECKLIST.md'),
    '# Work\n- [x] **1. Derive acceptance**\n- [ ] **2. Wait for operator**\n',
  );
  await writeFile(
    path.join(taskDir, 'inputs/handoff.json'),
    JSON.stringify({
      attemptId: run.id,
      project,
      flow: 'pr-complete',
      task: {
        acceptanceCriteria: captured.registration.original.map(
          ({ text }: { text: string }) => text,
        ),
      },
    }),
  );
  store.updateRun(run.id, {
    status: 'monitoring',
    taskFile: path.join(taskDir, 'TASK.md'),
    acceptanceRegistration: { ...captured.registration, runId: run.id },
    agentContexts: [],
    ticketData: {
      source: 'manual',
      title: 'Acceptance rendering proof',
      description: 'Retained real-worker registration, rendered without a conversation panel',
      acceptanceCriteria: captured.registration.original.map(({ text }: { text: string }) => text),
      affectedArea: '',
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  });
  await writeFile(
    path.join(root, 'status.json'),
    JSON.stringify({
      slots: [
        {
          slot: run.slotId,
          current_run_id: run.id,
          task_file: `tasks/pr-complete/${run.id}/TASK.md`,
          lifecycle: 'busy',
          phase: 'working',
        },
      ],
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const gateway = `ws://127.0.0.1:${address.port}/ws`;
  process.env.GATEWAY_PORT = String(address.port);
  ui = await createViteServer({
    root: path.join(source, 'apps/command-center/ui'),
    configFile: path.join(source, 'apps/command-center/ui/vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
  });
  await ui.listen();
  const uiAddress = ui.httpServer?.address();
  assert(uiAddress && typeof uiAddress !== 'string');
  testGatewayProfile(root, gateway, credential.secret);
  browserEnv = {
    ...process.env,
    FARMSLOT_GATEWAY_PROFILE: 'proof',
    FARMSLOT_GATEWAY: gateway,
    FARMSLOT_UI_URL: `http://127.0.0.1:${uiAddress.port}`,
  };
  route = `run/${run.id}`;
  await browser('goto', route, '--new');
  assert.equal((await browser('login', route)).authenticated, true);
  let observation;
  const deadline = Date.now() + 60_000;
  do {
    observation = await browser(
      'eval',
      route,
      `const walk=r=>[...r.querySelectorAll('*')].flatMap(e=>[e,...(e.shadowRoot?walk(e.shadowRoot):[])]);const nodes=walk(document);const rows=nodes.filter(e=>e.matches('[data-testid="acceptance-row"]'));return {ids:rows.map(e=>e.getAttribute('data-ac-id')),origins:rows.flatMap(e=>[...e.querySelectorAll('[data-testid="acceptance-origin"]')].map(x=>x.textContent.trim())),counts:nodes.find(e=>e.matches('[data-testid="acceptance-counts"]'))?.textContent.trim(),overlay:nodes.some(e=>e.localName==='vite-error-overlay')};`,
    );
    if (observation.ids.length === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.deepEqual(observation.ids, ['AC-1', 'AC-2', 'AC-3']);
  assert.equal(observation.overlay, false);
  assert.match(observation.counts, /0\/3 assessed/);
  assert.equal(observation.origins.length, 3);
  assert.ok(observation.origins.some((origin: string) => /review comment/i.test(origin)));
  assert.ok(observation.origins.some((origin: string) => /operator instruction/i.test(origin)));
  await writeFile(
    path.join(output, 'ui-observation.json'),
    JSON.stringify(observation, null, 2) + '\n',
  );
  // Expanding a native details element is an ordinary click, never a state write.
  await browser(
    'eval',
    route,
    `const walk=r=>[...r.querySelectorAll('*')].flatMap(e=>[e,...(e.shadowRoot?walk(e.shadowRoot):[])]);const nodes=walk(document);const panel=nodes.find(e=>e.matches('.ac-panel'));if(!panel)throw Error('No acceptance panel');panel.scrollIntoView({block:'center'});if(!panel.open)panel.querySelector('summary').click();return {open:panel.open};`,
  );
  await browser('screenshot', route, path.join(output, 'command-center-acceptance.png'));
  checks.push({ surface: 'Command Center acceptance panel', ...observation });
  const appArg = process.argv.find((arg) => arg.startsWith('--companion-app='));
  if (appArg) {
    const { proveCompanionAcceptance } = await import('./derived-acceptance-companion.mjs');
    checks.push(
      await proveCompanionAcceptance({
        source,
        output,
        gateway,
        credential: credential.secret,
        runId: run.id,
        app: appArg.slice('--companion-app='.length),
        criteria: [...captured.registration.original, ...captured.registration.derived].map(
          ({ text }: { text: string }) => text,
        ),
      }),
    );
  }
  await writeFile(
    path.join(output, 'ui-result.json'),
    JSON.stringify(
      {
        pass: true,
        checks,
        scope:
          'Rendering-only setup from retained live worker registration; real authenticated gateway/task.progress and browser acceptance-row selectors. No worker/model or product operation.',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ pass: true, checks }));
} finally {
  const cleanup = await Promise.allSettled([
    route ? browser('close', route) : Promise.resolve(),
    ui ? ui.close() : Promise.resolve(),
  ]);
  for (const connection of wss.clients) connection.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (runId) {
    store.updateRun(runId, { status: 'done' });
    await store.deleteRun(runId);
  }
  await rm(root, { recursive: true, force: true });
  const errors = cleanup.filter((entry) => entry.status === 'rejected');
  if (errors.length)
    throw new AggregateError(
      errors.map((entry) => entry.reason),
      'Rendering proof cleanup failed',
    );
}
process.exit(0);
