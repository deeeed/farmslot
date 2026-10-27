#!/usr/bin/env node
// Manual browser/RPC proof with an isolated real gateway and held transport replies.
// TSX_TSCONFIG_PATH=services/gateway/tsconfig.json node --experimental-test-module-mocks --import tsx apps/command-center/scripts/prove-gate-progressive.mjs <new-output-directory> [--withhold-snapshot]
import assert from 'node:assert/strict';
import { ChildProcess, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { createServer as createViteServer } from 'vite';
import WebSocket, { WebSocketServer } from 'ws';

const exec = promisify(execFile);
const source =
  process.env.FARMSLOT_GATE_PROOF_SOURCE ?? fileURLToPath(new URL('../../../', import.meta.url));
const sourceModule = (file) => import(pathToFileURL(path.join(source, file)).href);
const output = path.resolve(process.argv[2]);
const control = process.argv.includes('--withhold-snapshot');
const costProof = process.argv.includes('--fleet-cost');
const baseline = process.argv.includes('--baseline');
const codeProof = process.argv.includes('--code-review');
const expectMissing = process.argv.includes('--expect-missing-confirmation');
let codeFixture;
let holdCodeEvidence = codeProof,
  holdCodeApproval = codeProof;
const heldCodeEvidence = [];
const boundedLocal = process.argv.includes('--bounded-local');
const fleetProof = process.argv.includes('--fleet') || costProof || boundedLocal;
const ancestryInputFile = process.env.FARMSLOT_GATE_PROOF_ANCESTRY;
await mkdir(output, { recursive: false, mode: 0o700 });
const root = await mkdtemp(path.join(os.tmpdir(), 'gate-progressive-'));
const home = path.join(root, 'home');
const cdpPort = process.env.FARMSLOT_CDP_PORT ?? '19223';
for (const key of Object.keys(process.env))
  if (key.startsWith('FARMSLOT_') || key === 'TMUX') delete process.env[key];
for (const [key, value] of Object.entries({
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: home,
  FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
  FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
}))
  process.env[key] = value;
const save = (name, data) =>
  writeFile(path.join(output, name), JSON.stringify(data, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
const listen = async (server) => {
  await new Promise((yes, no) => {
    server.once('error', no);
    server.listen(0, '127.0.0.1', yes);
  });
  return server.address().port;
};
const closeServer = (server) => {
  server.closeAllConnections();
  return server.listening
    ? new Promise((yes, no) => server.close((error) => (error ? no(error) : yes())))
    : Promise.resolve();
};
const events = [],
  sockets = new Set(),
  held = [],
  heldSource = [];
let holdSource = false;
let ui, gatewayServer, gatewaySockets, proxyServer, proxySockets, route, run, store;
let release = false,
  started = Date.now(),
  primaryError;
let coldNavigationFailures = 0;
let holdFleet = false;
let gatePaintMs;
let costResult;
let ancestryInput, ancestryRepo;
let countLaunches = false;
const launches = { workspace: 0, compare: 0 };
let localActive = 0,
  localPeak = 0,
  localLaunches = 0;
let localBatchStart, localBatchEnd;
const cleanupFailures = [];
const env = {
  ...process.env,
  FARMSLOT_CDP_PORT: cdpPort,
  FARMSLOT_GATEWAY_PROFILE: 'gate-proof',
};
const cdp = async (...args) => {
  try {
    const result = await exec(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
      cwd: source,
      env,
      timeout: args[0] === 'screenshot' ? 15000 : 90000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    // Document setup is separate from the measured two-second gate paint.
    // Retain the helper's five-second cold-load failure, then require the
    // exact owned URL and complete readiness before proceeding.
    if (
      args[0] !== 'goto' ||
      args[2] !== '--new' ||
      !error.stderr?.startsWith('CDP navigation reached ')
    )
      throw error;
    await save(`cold-navigation-${++coldNavigationFailures}.json`, {
      message: error.message,
      stderr: error.stderr,
    });
    const expected = new URL(args[1]);
    await cdp(
      'eval',
      expected.hash.slice(1),
      `const expected=${JSON.stringify(args[1])};const end=Date.now()+60000;while(document.readyState!=='complete'){if(location.href!==expected||Date.now()>end)throw Error('Owned cold navigation did not become ready');await new Promise(r=>setTimeout(r,50))}if(location.href!==expected)throw Error('Foreign navigation');return {url:location.href,ready:true};`,
    );
    return JSON.stringify({ url: args[1], coldReadinessRecovered: true });
  }
};
try {
  for (const name of [
    'scripts',
    'packages',
    'services',
    'node_modules',
    'schemas',
    'package.json',
    'CLAUDE.md',
  ])
    await symlink(path.join(source, name), path.join(root, name));
  await mkdir(path.join(root, 'projects/gate-proof'), { recursive: true });
  await mkdir(path.join(root, 'pool'), { recursive: true });
  await writeFile(
    path.join(root, 'projects/gate-proof/project.json'),
    JSON.stringify({ name: 'gate-proof', default_branch: 'main' }),
  );
  const fixtureRepo = path.join(root, 'checkout');
  let baseSha, headSha;
  {
    await mkdir(fixtureRepo);
    const git = (...args) =>
      exec('git', args, {
        cwd: fixtureRepo,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      });
    await git('init', '-q', '-b', 'main');
    await writeFile(path.join(fixtureRepo, 'fixture.txt'), 'Read-only recovery fixture\n');
    await git('add', 'fixture.txt');
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'test: seed read-only workspace',
    );
    await git('remote', 'add', 'origin', fixtureRepo);
    await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    baseSha = (await git('rev-parse', 'HEAD')).stdout.trim();
    if (!fleetProof) {
      await git('checkout', '-qb', 'proof');
      for (let i = 0; i < (codeProof ? 5 : 51); i++)
        await writeFile(
          path.join(fixtureRepo, `source-${String(i).padStart(2, '0')}.ts`),
          `export const observed${i} = ${i};\n`,
        );
      await git('add', '.');
      await git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'test: seed committed source changes',
      );
    }
    headSha = (await git('rev-parse', 'HEAD')).stdout.trim();
    await writeFile(
      path.join(root, 'status.json'),
      JSON.stringify({
        checked_at: new Date().toISOString(),
        slots: [
          {
            slot: 'recovery-proof-slot',
            machine: 'localhost',
            project: 'gate-proof',
            platform: 'cli',
            ssh: 'LOCAL',
            branch: fleetProof ? 'main' : 'proof',
            head_sha: headSha,
            agent: 'idle',
            enabled: true,
            dispatchable: true,
            lifecycle: 'ready',
            phase: null,
            slot_epoch: 1,
            current_run_id: null,
            cleanup_run_id: null,
            handoff_run_id: null,
          },
        ],
      }),
    );
  }
  await writeFile(
    path.join(root, 'pool/local.json'),
    JSON.stringify({
      machine: 'localhost',
      host: 'localhost',
      platform: 'cli',
      project: 'gate-proof',
      slots: [{ id: 'recovery-proof-slot', repo: fixtureRepo, session: 'unused-proof' }],
    }),
  );
  if (boundedLocal) {
    const raw = JSON.parse(await readFile(path.join(root, 'status.json'), 'utf8'));
    const pool = JSON.parse(await readFile(path.join(root, 'pool/local.json'), 'utf8'));
    const template = raw.slots[0];
    raw.slots = [];
    pool.slots = [];
    for (let index = 0; index < 31; index++) {
      const id = `local-proof-${index}`;
      const repo = path.join(root, id);
      await exec('git', ['clone', '--shared', '--quiet', fixtureRepo, repo]);
      raw.slots.push({
        ...template,
        slot: id,
        repo,
        enabled: index < 30,
        lifecycle: index < 30 ? 'ready' : 'disabled',
      });
      pool.slots.push({ id, repo, session: id, enabled: index < 30 });
    }
    await writeFile(path.join(root, 'status.json'), JSON.stringify(raw));
    await writeFile(path.join(root, 'pool/local.json'), JSON.stringify(pool));
  }
  // The unrelated PTY module changes shared tmux options on import. The
  // existing test fence forbids every PTY/tmux operation in this read-only proof.
  await sourceModule('services/gateway/src/runtime/mock-pty.test-support.ts');
  if (costProof || boundedLocal) {
    const original = ChildProcess.prototype.spawn;
    mock.method(ChildProcess.prototype, 'spawn', function (options) {
      const fingerprint =
        boundedLocal && options.args.some((arg) => arg.includes('FARMSLOT_WORKSPACE_PROBE'));
      // Reproduce contention above four real fingerprint processes. Every
      // child still runs the actual Git reader under its owning cancellation.
      const launch =
        fingerprint && localActive >= 4
          ? {
              ...options,
              args: options.args.map((arg) =>
                arg.includes('FARMSLOT_WORKSPACE_PROBE') ? `sleep 6\n${arg}` : arg,
              ),
            }
          : options;
      const result = Reflect.apply(original, this, [launch]);
      if (fingerprint && this.pid) {
        localBatchStart ??= Date.now();
        localLaunches++;
        localActive++;
        localPeak = Math.max(localPeak, localActive);
        this.once('close', () => {
          localActive--;
          localBatchEnd = Date.now();
        });
      }
      if (countLaunches && this.pid) {
        if (options.args.some((arg) => arg.includes('FARMSLOT_WORKSPACE_PROBE')))
          launches.workspace++;
        if (
          path.basename(options.file) === 'gh' &&
          options.args.some((arg) => arg.includes('/compare/'))
        )
          launches.compare++;
      }
      return result;
    });
  }
  store = await sourceModule('services/gateway/src/runs/store.ts');
  run = store.createRun({
    flowType: 'dev',
    project: 'gate-proof',
    ticketOrPr: 'GATE-PROGRESSIVE',
    mode: 'interactive',
    initialContext: 'Display a captured gate while the live read is slow',
  });
  store.updateRun(run.id, {
    status: 'human-gating',
    slotId: fleetProof ? 'unreachable-proof-slot' : 'recovery-proof-slot',
    branch: fleetProof ? 'main' : 'proof',
    decisions: [
      {
        id: 'proof-gate',
        type: 'engine_human_gate',
        title: 'Review 51 changed files',
        description: 'Captured worker result',
        createdAt: run.createdAt,
        actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
        payload: {
          kind: 'ready',
          branch: 'proof',
          repo: null,
          prNumber: null,
          diffStat: { files: 51, additions: 100, deletions: 20 },
          workerReport: 'Captured report. '.repeat(1000),
          acceptanceCriteria: ['The original acceptance criterion remains visible'],
          prPackage: {
            id: 'proof-package',
            packageHash: 'a'.repeat(64),
            artifactPath: 'artifacts/package.json',
            branch: 'proof',
            reviewSnapshot: {
              baseSha,
              headSha,
              source: 'local-git',
              capturedAt: new Date().toISOString(),
            },
            draftTitle: 'Saved publication',
            draftBody: 'Saved description. '.repeat(200),
            diffStat: { files: 51, additions: 100, deletions: 20 },
            reviewArtifactIds: [],
            gatePolicy: { owner: 'human', publishAuthority: 'human', reason: 'Read-only fixture' },
            publicationTarget: 'draft',
            publicationStatus: 'not_published',
            createdAt: run.createdAt,
          },
        },
      },
    ],
  });
  if (codeProof) {
    const { prepareCodeReviewGate } = await import('./gate-code-review-proof.mjs');
    codeFixture = await prepareCodeReviewGate({
      sourceModule,
      source,
      store,
      run,
      root,
      mock,
      headSha,
    });
    release = true;
  }
  if (costProof) {
    assert(ancestryInputFile, 'Provide the real published ancestry input');
    ancestryInput = JSON.parse(await readFile(ancestryInputFile, 'utf8'));
    const input = ancestryInput;
    assert(/^[\w.-]+\/[\w.-]+$/.test(input.repository));
    for (const key of ['headSha', 'defaultSha']) assert(/^[a-f0-9]{40}$/.test(input[key]));
    assert(path.isAbsolute(input.objectSource));
    ancestryRepo = path.join(root, 'published-ancestry');
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const ancestryGit = (...args) => exec('git', ['-C', ancestryRepo, ...args], { env: gitEnv });
    await exec('git', ['init', '-q', ancestryRepo], { env: gitEnv });
    await ancestryGit(
      'fetch',
      '--depth=1',
      '--no-tags',
      pathToFileURL(input.objectSource).href,
      input.headSha,
    );
    await ancestryGit('update-ref', 'HEAD', input.headSha);
    assert.equal((await ancestryGit('rev-parse', 'HEAD')).stdout.trim(), input.headSha);
  }
  const { createGatewayAuthRuntime, authorizeHttpRequest } = await sourceModule(
    'services/gateway/src/security/auth.ts',
  );
  const { createWebSocketServer, broadcastEvent } = await sourceModule(
    'services/gateway/src/server.ts',
  );
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  const person = auth.writer.createPrincipal({ type: 'person', displayName: 'Gate proof' }, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  const credential = auth.writer.issueCredential(person.id, 'Disposable browser proof');
  const { applyGatewayCors } = await sourceModule('services/gateway/src/security/origin.ts');
  const { serveFile, serveRunArtifact } = await sourceModule(
    'services/gateway/src/methods/filesystem.ts',
  );
  gatewayServer = createServer((req, res) => {
    if (!applyGatewayCors(req, res)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const resource = req.url?.startsWith('/api/run-artifact?')
      ? 'run-artifact'
      : req.url?.startsWith('/api/file?')
        ? 'file'
        : null;
    if (resource) {
      if (!authorizeHttpRequest({ runtime: auth, req, res, resource })) return;
      if (resource === 'run-artifact') serveRunArtifact(req, res);
      else serveFile(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  gatewaySockets = createWebSocketServer(gatewayServer, auth);
  const gatewayPort = await listen(gatewayServer);
  proxyServer = createServer((req, res) => {
    const upstream = httpRequest(
      {
        hostname: '127.0.0.1',
        port: gatewayPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      primaryError ??= error;
      res.destroy(error);
    });
    req.pipe(upstream);
  });
  proxySockets = new WebSocketServer({ server: proxyServer });
  proxySockets.on('connection', (client) => {
    sockets.add(client);
    const upstream = new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws`);
    sockets.add(upstream);
    const waiting = [],
      requests = new Map();
    upstream.on('open', () => {
      for (const [bytes, binary] of waiting) upstream.send(bytes, { binary });
    });
    client.on('message', (bytes, binary) => {
      const frame = JSON.parse(bytes.toString());
      if (frame.type === 'req') {
        requests.set(frame.id, frame);
        events.push({
          method: frame.method,
          view: frame.params?.view,
          ...(frame.method === 'git.diff' ? { path: frame.params?.path } : {}),
          sentMs: Date.now() - started,
          bytes: bytes.length,
        });
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary });
      else waiting.push([bytes, binary]);
    });
    upstream.on('message', (bytes, binary) => {
      const frame = JSON.parse(bytes.toString());
      const req = requests.get(frame.id);
      const sourceHeld = holdSource && ['git.branchDiff', 'git.diff'].includes(req?.method);
      const codeEvidenceHeld =
        codeProof && holdCodeEvidence && req?.method === 'run.recipeRunsForRun';
      const codeApprovalHeld =
        codeProof &&
        holdCodeApproval &&
        ((req?.method === 'run.resolveDecision' && frame.ok !== false) ||
          (frame.type === 'event' && frame.event?.startsWith('run.')));
      const hold =
        codeEvidenceHeld ||
        codeApprovalHeld ||
        sourceHeld ||
        (!release &&
          ((req?.method === 'run.get' && (!req.params?.view || control)) ||
            (req?.method === 'fleet.status' && holdFleet) ||
            (frame.type === 'event' && frame.event?.startsWith('run.'))));
      if (req)
        events.push({
          responseTo: req.method,
          view: req.params?.view,
          receivedMs: Date.now() - started,
          bytes: bytes.length,
          ok: frame.ok,
          ...(codeProof &&
          frame.ok === false &&
          ['run.resolveDecision', 'run.overrideClaim'].includes(req.method)
            ? { error: { code: frame.error?.code, message: frame.error?.message } }
            : {}),
          held: hold,
          ...(req.method === 'fleet.status' && frame.ok
            ? {
                workspace: {
                  publication: frame.payload?.fleet?.slots[0]?.workspace?.publication ?? null,
                  observedAt: frame.payload?.fleet?.slots[0]?.workspace?.observedAt ?? null,
                  error:
                    frame.payload?.fleet?.slots[0]?.workspaceError ??
                    frame.payload?.fleet?.slots[0]?.workspace?.error ??
                    null,
                },
              }
            : {}),
        });
      if (hold)
        (codeEvidenceHeld ? heldCodeEvidence : sourceHeld ? heldSource : held).push(() => {
          if (client.readyState === WebSocket.OPEN) client.send(bytes, { binary });
        });
      else if (client.readyState === WebSocket.OPEN) client.send(bytes, { binary });
    });
    client.on('close', () => upstream.close());
    upstream.on('close', () => client.close());
    upstream.on('error', (error) => {
      primaryError ??= error;
      client.close();
    });
    client.on('error', (error) => {
      primaryError ??= error;
      upstream.close();
    });
  });
  const proxyPort = await listen(proxyServer);
  const { loadProfiles, saveProfiles } = await sourceModule('packages/cli/src/gateway-profiles.ts');
  const profiles = loadProfiles();
  profiles.gateways['gate-proof'] = {
    url: `ws://127.0.0.1:${proxyPort}/ws`,
    authMode: 'token',
    secret: credential.secret,
  };
  saveProfiles(profiles);
  process.env.VITE_FARMSLOT_GATEWAY_URL = `ws://127.0.0.1:${proxyPort}/ws`;
  const reservation = createServer();
  const uiPort = await listen(reservation);
  await closeServer(reservation);
  ui = await createViteServer({
    cacheDir: path.join(root, 'vite-cache'),
    configFile: path.join(source, 'apps/command-center/ui/vite.config.ts'),
    server: {
      host: '127.0.0.1',
      port: uiPort,
      strictPort: true,
      proxy: {
        '/ws': { target: `http://127.0.0.1:${proxyPort}`, ws: true },
        '/api': { target: `http://127.0.0.1:${gatewayPort}` },
      },
    },
  });
  await ui.listen();
  const origin = `http://127.0.0.1:${ui.httpServer.address().port}`;
  env.FARMSLOT_UI_URL = origin;
  env.FARMSLOT_GATEWAY = `ws://127.0.0.1:${proxyPort}/ws`;
  route = `fleet?proof=${run.id}`;
  await cdp('goto', origin + '/#' + route, '--new');
  await cdp(
    'eval',
    route,
    `await customElements.whenDefined('farm-app');const end=Date.now()+30000;while(!document.querySelector('.auth-card')){if(Date.now()>end)throw Error('Expected configured-gateway sign-in');await new Promise(r=>setTimeout(r,50))}return {signInReady:true};`,
  );
  await save('login.json', JSON.parse(await cdp('login', route)));
  await cdp(
    'eval',
    route,
    `const {getState,isHydrating}=await import('/src/state.ts');const end=Date.now()+60000;while(getState().connection!=='connected'||isHydrating(getState(),'runs')){if(Date.now()>end)throw Error('Bootstrap refused: '+(document.querySelector('.auth-error')?.textContent??getState().connection));await new Promise(r=>setTimeout(r,50))}return {connected:getState().connection};`,
  );
  const releaseNotes = JSON.parse(
    await cdp(
      'eval',
      route,
      "const modal=document.querySelector('whats-new-modal');return {open:!!modal?.shadowRoot?.querySelector('button.primary')};",
    ),
  );
  if (releaseNotes.open) await cdp('click', route, 'whats-new-modal >>> button.primary');
  if (codeProof) {
    route = `runs?run=${run.id}`;
    const { proveCodeReviewGate } = await import('./gate-code-review-proof.mjs');
    await proveCodeReviewGate({
      cdp,
      origin,
      run,
      output,
      save,
      events,
      store,
      expectMissing,
      fixture: codeFixture,
      releaseEvidence: () => {
        holdCodeEvidence = false;
        for (const send of heldCodeEvidence.splice(0)) send();
      },
      releaseReplies: () => {
        holdCodeApproval = false;
        for (const send of held.splice(0)) send();
      },
    });
  } else if (costProof) {
    const input = ancestryInput;
    assert(input && ancestryRepo, 'Published ancestry must be prepared before service startup');
    const { refIncludedInMergedPullRequest, readMergedPreparePullRequests } = await sourceModule(
      'services/gateway/src/methods/slot/unmerged-work.ts',
    );
    const { execOnSlot, loadSlotVars } = await sourceModule('services/gateway/src/core/index.ts');
    const vars = { ...(await loadSlotVars('recovery-proof-slot')), remoteRepo: ancestryRepo };
    await cdp(
      'eval',
      route,
      `const {getState,isHydrating}=await import('/src/state.ts');const end=Date.now()+30000;while(isHydrating(getState(),'fleet')||getState().fleet?.slots.length!==1){if(Date.now()>end)throw Error('Fleet did not become ready');await new Promise(r=>setTimeout(r,50))}return {mounted:!!document.querySelector('fleet-canvas'),slots:getState().fleet.slots.length};`,
    );
    await cdp('click', route, 'fleet-canvas >>> .fleet-refresh-trigger');
    const readInspection = async () =>
      JSON.parse(
        await cdp(
          'eval',
          route,
          `await new Promise(requestAnimationFrame);const end=Date.now()+125000;let root;for(;;){root=document.querySelector('fleet-canvas')?.shadowRoot?.querySelector('fleet-refresh-modal')?.shadowRoot;if(root?.querySelector('article[data-slot]')&&!root.querySelector('[role=status]')?.textContent?.includes('Checking current'))break;if(Date.now()>end)throw Error('Actual inspection did not settle');await new Promise(r=>setTimeout(r,50))}return {text:root.textContent.replace(/\\s+/g,' '),rows:root.querySelectorAll('article[data-slot]').length};`,
        ),
      );
    let admission = await readInspection();
    await save('warm-admission-first.json', {
      admission,
      replies: events.filter((e) => e.responseTo === 'fleet.status'),
    });
    if (!admission.text.includes('main · baseline')) {
      // One existing UI Retry after the failed inspection cache expires.
      const last = events.filter((e) => e.responseTo === 'fleet.status').at(-1);
      assert(last, 'Require the actual completed inspection reply');
      const retryAt = started + last.receivedMs + 15_050;
      while (Date.now() < retryAt)
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, retryAt - Date.now())));
      await cdp(
        'click',
        route,
        'fleet-canvas >>> fleet-refresh-modal >>> footer button:last-of-type',
      );
      admission = await readInspection();
    }
    await save('warm-admission.json', {
      admission,
      replies: events.filter((e) => e.responseTo === 'fleet.status'),
    });
    assert(
      admission.rows === 1 && admission.text.includes('main · baseline'),
      'Require real healthy workspace facts in the mounted dialog before the warm minute',
    );
    const windowStart = Date.now();
    const rpcMs = [];
    const observations = [];
    let read = 0;
    countLaunches = true;
    while (Date.now() - windowStart < 60_000) {
      const observed = JSON.parse(
        await cdp(
          'eval',
          route,
          `const {gateway}=await import('/src/gateway-client.ts');const start=performance.now();const result=await gateway.request('fleet.status',{},120000);const slot=result.fleet.slots[0];return {elapsedMs:performance.now()-start,slots:result.fleet.slots.length,mounted:!!document.querySelector('fleet-canvas'),publication:slot?.workspace?.publication??null,observedAt:slot?.workspace?.observedAt??null,error:slot?.workspaceError??slot?.workspace?.error??null};`,
        ),
      );
      assert(observed.mounted && observed.slots === 1);
      rpcMs.push(observed.elapsedMs);
      observations.push(observed);
      if (read % 4 === 0)
        assert(
          await refIncludedInMergedPullRequest(
            vars,
            'HEAD',
            'main',
            input.repository,
            execOnSlot,
            readMergedPreparePullRequests,
            { allowFetch: false, defaultSha: input.defaultSha, timeoutMs: 10_000 },
          ),
        );
      read++;
      await save(`read-window-${read}.json`, {
        observations: [...observations],
        launches: { ...launches },
        elapsedMs: Date.now() - windowStart,
      });
      const next = windowStart + read * 5000;
      while (Date.now() < Math.min(next, windowStart + 60_000))
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, next - Date.now())));
    }
    countLaunches = false;
    const elapsedMs = Date.now() - windowStart;
    const sourceHashes = {};
    for (const name of [
      'workspace.ts',
      'workspace-version.ts',
      'workspace-probe.ts',
      'unmerged-work.ts',
    ]) {
      try {
        sourceHashes[name] = createHash('sha256')
          .update(await readFile(path.join(source, 'services/gateway/src/methods/slot', name)))
          .digest('hex');
      } catch (error) {
        // The unchanged baseline predates the metadata reader.
        if (!baseline || name !== 'workspace-version.ts' || error.code !== 'ENOENT') throw error;
        sourceHashes[name] = null;
      }
    }
    costResult = {
      baseline,
      elapsedMs,
      calls: rpcMs.length,
      rpcMs,
      observations,
      launches: { ...launches },
      perMinute: Object.fromEntries(
        Object.entries(launches).map(([key, value]) => [key, (value * 60_000) / elapsedMs]),
      ),
      sourceHashes,
      ancestry: {
        repository: input.repository,
        headSha: input.headSha,
        defaultSha: input.defaultSha,
      },
      scope:
        'Isolated singleton fleet in actual Command Center plus real published GitHub ancestry. This is not a full production-fleet latency measurement.',
    };
    await save('read-cost.json', costResult);
    assert(rpcMs.length >= 8, 'Require repeated actual client reads over the minute');
    if (baseline) {
      assert(launches.workspace >= 3, 'The prior cache must reproduce repeated full probes');
      assert(launches.compare >= 3, 'The prior ancestry reader must reproduce repeated compares');
    } else {
      assert(
        observations.every((value) => value.publication === 'baseline' && !value.error),
        'Require actual healthy facts throughout the warm minute',
      );
      assert(Number.isFinite(Date.parse(observations[0].observedAt)));
      assert.equal(
        new Set(observations.map((value) => value.observedAt)).size,
        1,
        'Passive reuse must preserve the original observation time',
      );
      assert.equal(
        launches.workspace,
        0,
        'Unchanged metadata must avoid full probes during the warm minute',
      );
      assert.equal(launches.compare, 1, 'The actual immutable SHA pair must be compared once');
      assert(Math.max(...rpcMs) < 10_000, 'Each fleet.status must finish under ten seconds');
    }
    await cdp('screenshot', route, path.join(output, 'fleet-cost.png'));
  } else if (fleetProof) {
    if (boundedLocal) {
      const firstReply = JSON.parse(
        await cdp(
          'eval',
          route,
          `const {gateway}=await import('/src/gateway-client.ts');const start=performance.now();const {fleet}=await gateway.request('fleet.status',{},120000);return {ms:performance.now()-start,slots:fleet.slots.map(slot=>({slot:slot.slot,enabled:slot.enabled,workspace:slot.workspace??null,error:slot.workspaceError??null}))};`,
        ),
      );
      await save('local-first-reply.json', firstReply);
      const wallMs = localBatchEnd - localBatchStart;
      await save('local-admission.json', {
        launches: localLaunches,
        peak: localPeak,
        active: localActive,
        wallMs,
      });
      assert(wallMs < 15000, 'The cold local batch must fit the normal client deadline');
      assert.equal(firstReply.slots.length, 31);
      assert(
        firstReply.slots
          .filter((slot) => slot.enabled)
          .every((slot) => slot.workspace && !slot.workspace.error),
        'One fleet.status must inspect every enabled local checkout',
      );
      const needsRetry = JSON.parse(
        await cdp(
          'eval',
          route,
          `const {getState}=await import('/src/state.ts');return {retry:!getState().fleet};`,
        ),
      );
      assert.equal(needsRetry.retry, false, 'Normal Fleet bootstrap must succeed without Retry');
    }
    const firstFleet = JSON.parse(
      await cdp(
        'eval',
        route,
        `const {getState,isHydrating}=await import('/src/state.ts');const end=Date.now()+60000;while(isHydrating(getState(),'fleet')){if(Date.now()>end)throw Error('Fleet bootstrap did not settle');await new Promise(r=>setTimeout(r,50))}const fleet=getState().fleet;return {slots:fleet?.slots.map(slot=>({slot:slot.slot,enabled:slot.enabled,workspace:slot.workspace??null,error:slot.workspaceError??null}))??[]};`,
      ),
    );
    await save('fleet-first.json', firstFleet);
    if (boundedLocal) {
      assert.equal(firstFleet.slots.length, 31);
      assert(
        firstFleet.slots
          .filter((slot) => slot.enabled)
          .every((slot) => slot.workspace && !slot.workspace.error),
        'Every enabled local slot must carry its actual workspace',
      );
      assert(firstFleet.slots.filter((slot) => !slot.enabled).every((slot) => !slot.workspace));
      assert.equal(localLaunches, 30);
      assert(localPeak <= 4, 'Local fingerprints must have bounded admission');
    }
    holdFleet = true;
    started = Date.now();
    await cdp('click', route, 'fleet-canvas >>> .fleet-refresh-trigger');
    const observation = JSON.parse(
      await cdp(
        'eval',
        route,
        `const all=[];const walk=r=>{for(const e of r.querySelectorAll('*')){all.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};walk(document);const modal=all.find(e=>e.localName==='fleet-refresh-modal'&&e.open);const root=modal?.shadowRoot;return {text:root?.textContent?.replace(/\\s+/g,' '),rows:root?.querySelectorAll('article[data-slot]').length,releaseDisabled:Array.from(root?.querySelectorAll('article button')??[]).every(e=>e.disabled),busy:!!root?.querySelector('[role=status]')};`,
      ),
    );
    assert.equal(
      observation.rows,
      boundedLocal ? 31 : 1,
      'Cached rows must render before current inspection settles',
    );
    assert(observation.text.includes(`Release idle slots (${boundedLocal ? 30 : 1})`));
    assert.equal(observation.releaseDisabled, true);
    assert(held.length > 0, 'Require an actual held fleet reply');
    await save('fleet-held.json', observation);
    await cdp('screenshot', route, path.join(output, 'fleet-held.png'));
    await cdp(
      'screenshot',
      route,
      path.join(output, 'fleet-held-touch.png'),
      '--width',
      '390',
      '--height',
      '844',
    );
    release = true;
    for (const send of held.splice(0)) send();
    await save(
      'fleet-after.json',
      JSON.parse(
        await cdp(
          'eval',
          route,
          `const all=[];const walk=r=>{for(const e of r.querySelectorAll('*')){all.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};walk(document);const modal=all.find(e=>e.localName==='fleet-refresh-modal'&&e.open);const end=Date.now()+10000;while(modal?.shadowRoot?.querySelector('[role=status]')?.textContent?.includes('Checking current')){if(Date.now()>end)throw Error('Inspection did not settle');await new Promise(r=>setTimeout(r,50))}return {text:modal?.shadowRoot?.textContent?.replace(/\\s+/g,' '),rows:modal?.shadowRoot?.querySelectorAll('article[data-slot]').length};`,
        ),
      ),
    );
    await cdp('click', route, 'fleet-canvas >>> fleet-refresh-modal >>> button[aria-label=Close]');
    if (boundedLocal) {
      const warm = JSON.parse(
        await cdp(
          'eval',
          route,
          `const {gateway}=await import('/src/gateway-client.ts');const reads=[];for(let index=0;index<3;index++){const start=performance.now();const {fleet}=await gateway.request('fleet.status',{},120000);reads.push({ms:performance.now()-start,slots:fleet.slots.map(slot=>({slot:slot.slot,workspace:slot.workspace??null}))})}return reads;`,
        ),
      );
      await save('local-warm.json', warm);
      for (const read of warm) {
        assert(read.ms < 2000, 'Warm fleet.status must complete under two seconds');
        assert.equal(
          read.slots.filter((slot) => slot.workspace).length,
          30,
          'Every warm reply retains all enabled workspace observations',
        );
        for (const slot of read.slots)
          assert.equal(
            slot.workspace?.observedAt,
            firstFleet.slots.find((first) => first.slot === slot.slot).workspace?.observedAt,
          );
      }
    }
  } else {
    await cdp(
      'eval',
      route,
      `window.__gateProofMeasurement={}; let begin;window.addEventListener('hashchange',()=>{begin=performance.now()},{once:true,capture:true});const end=performance.now()+30000;const sample=()=>{const all=[];const walk=r=>{for(const e of r.querySelectorAll('*')){if(e.localName==='ready-workspace')all.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};walk(document);const gate=all.find(e=>e.runId===${JSON.stringify(run.id)});if(begin&&gate?.querySelector('[data-testid=acceptance-counts]')&&gate.querySelectorAll('.gate-actions button').length){window.__gateProofMeasurement={paintMs:performance.now()-begin};return}if(performance.now()<end)requestAnimationFrame(sample)};requestAnimationFrame(sample);return {observationInstalled:true};`,
    );
    route = `runs?run=${run.id}&tab=evidence`;
    started = Date.now();
    await cdp('goto', origin + '/#' + route);
    // Tab clicks update the same run's URL. Keep the owned run identity as the
    // CDP match, rather than the tab parameter it had when first opened.
    route = `runs?run=${run.id}`;
    const observe = `const all=[];const walk=r=>{for(const e of r.querySelectorAll('*')){all.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};walk(document);const gate=all.find(e=>e.localName==='ready-workspace');return {gate:!!gate,text:gate?.innerText??'',buttonCount:gate?.querySelectorAll('.gate-actions button').length??0,measurement:window.__gateProofMeasurement,disabled:gate?Array.from(gate.querySelectorAll('.gate-actions button')).every(e=>e.disabled):null,recoveryStatus:!!gate?.querySelector('.rdy-recovery-status')};`;
    const read = async () => JSON.parse(await cdp('eval', route, observe));
    let observed;
    const deadline = Date.now() + 10000;
    do {
      observed = await read();
      if ((observed.gate && observed.measurement?.paintMs !== undefined) || control) break;
      assert(Date.now() < deadline, 'No gate rendered');
    } while (Date.now() < deadline);
    const paintMs = observed.measurement?.paintMs ?? null;
    gatePaintMs = paintMs;
    await save('held.json', { control, paintMs, observed });
    // The causal control must release its optional snapshot within the normal
    // client timeout. Its RPC/text observations are sufficient state evidence;
    // desktop and touch captures belong to the positive path.
    if (!control) {
      await cdp('screenshot', route, path.join(output, 'held.png'));
      await cdp(
        'screenshot',
        route,
        path.join(output, 'held-touch.png'),
        '--width',
        '390',
        '--height',
        '844',
      );
    }
    assert(
      events.some((e) => e.method === 'run.get' && e.view === 'snapshot'),
      'Require the actual display RPC',
    );
    assert(
      events.some((e) => e.responseTo === 'run.get' && e.held),
      'Require an actually held current reply',
    );
    if (control) {
      assert(events.some((e) => e.responseTo === 'run.get' && e.view === 'snapshot' && e.held));
      assert(observed.gate, 'The trimmed inventory gate still mounts');
      await cdp('click', route, 'ready-workspace .rdy-tab');
      assert(
        !(await read()).text.includes('Saved publication'),
        'A withheld package must not appear from inventory data',
      );
    } else {
      assert(observed.gate);
      assert(observed.buttonCount > 0, 'Require actual rendered action controls');
      assert.equal(typeof paintMs, 'number');
      assert(paintMs < 2000, `Gate paint took ${paintMs}ms, expected under 2000ms`);
      assert(/acceptance criteria/i.test(observed.text));
      await cdp('click', route, 'ready-workspace [data-testid=acceptance-panel] > summary');
      assert((await read()).text.includes('The original acceptance criterion remains visible'));
      await cdp('click', route, 'ready-workspace [data-gate-tab=pr-preview]');
      const packageView = await read();
      assert(
        packageView.text.includes('Saved publication'),
        'Require the actual stored package title',
      );
      await save('stored-package.json', packageView);
      assert.equal(observed.disabled, true, 'Stored display data is not action authority');
      assert.equal(observed.recoveryStatus, false, 'Evidence must not show source recovery status');
      assert(
        !events.some((e) => e.method === 'git.branchDiff'),
        'Evidence must not prefetch the live diff',
      );
      await cdp('click', route, 'ready-workspace [data-gate-tab=diff]');
      const sourceView = await cdp(
        'eval',
        route,
        `const all=[];const walk=r=>{for(const e of r.querySelectorAll('*')){all.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};walk(document);const gate=all.find(e=>e.localName==='ready-workspace');const end=Date.now()+30000;while(gate?.querySelectorAll('.rdy-ft').length!==51||!gate?.querySelector('diff-review')){if(Date.now()>end)throw Error('Actual source diff did not load: '+gate?.innerText);await new Promise(r=>setTimeout(r,50))}return {files:gate.querySelectorAll('.rdy-ft').length,selected:gate.querySelector('.rdy-ft.selected')?.title};`,
      );
      await save('source-first.json', JSON.parse(sourceView));
      assert.equal(
        events.filter((e) => e.method === 'git.diff').length,
        1,
        'Only the opened file body is requested',
      );
      await cdp('click', route, 'ready-workspace .rdy-ft[title="source-01.ts"]');
      await cdp(
        'eval',
        route,
        `const all=[];const walk=r=>{for(const e of r.querySelectorAll('*')){all.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};walk(document);const gate=all.find(e=>e.localName==='ready-workspace');const end=Date.now()+30000;while(gate?.querySelector('.rdy-ft.selected')?.title!=='source-01.ts'||!gate?.querySelector('diff-review')){if(Date.now()>end)throw Error('Second source selection did not load');await new Promise(r=>setTimeout(r,50))}return {selected:gate.querySelector('.rdy-ft.selected').title};`,
      );
      assert.deepEqual(
        events.filter((e) => e.method === 'git.diff').map((e) => e.path),
        ['source-00.ts', 'source-01.ts'],
      );
      await cdp('screenshot', route, path.join(output, 'source-selection.png'));
      release = true;
      for (const send of held.splice(0)) send();
      const settleSource = async () =>
        JSON.parse(
          await cdp(
            'eval',
            route,
            `const all=[];const walk=r=>{for(const e of r.querySelectorAll('*')){all.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};walk(document);const gate=all.find(e=>e.localName==='ready-workspace');const end=Date.now()+30000;while(gate?.querySelectorAll('.rdy-ft').length!==51||!gate?.querySelector('diff-review')||gate?.querySelector('.rdy-recovery-status')){if(Date.now()>end)throw Error('Revised package source stayed loading');await new Promise(r=>setTimeout(r,25))}return {files:gate.querySelectorAll('.rdy-ft').length,selected:gate.querySelector('.rdy-ft.selected')?.title};`,
          ),
        );
      for (const [index, method] of ['git.branchDiff', 'git.diff'].entries()) {
        holdSource = true;
        if (index === 0) {
          await cdp('click', route, 'ready-workspace [data-gate-tab=pr-preview]');
          await cdp('click', route, 'ready-workspace [data-gate-tab=diff]');
        } else await cdp('click', route, 'ready-workspace .rdy-ft[title="source-02.ts"]');
        const end = Date.now() + 30000;
        while (!heldSource.length) {
          assert(Date.now() < end, 'Expected an actual held source response');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const prior = store.getRun(run.id);
        const decisions = prior.decisions.map((decision) =>
          decision.id === 'proof-gate'
            ? {
                ...decision,
                payload: {
                  ...decision.payload,
                  prPackage: {
                    ...decision.payload.prPackage,
                    packageHash: String(index + 2).repeat(64),
                    draftTitle: `Revised publication ${index}`,
                  },
                },
              }
            : decision,
        );
        store.updateRun(run.id, { decisions });
        holdSource = false;
        const requestsBefore = events.filter((event) => event.method === 'git.branchDiff').length;
        broadcastEvent('run.updated', { run: store.getRun(run.id) });
        const replacementEnd = Date.now() + 30000;
        while (
          events.filter((event) => event.method === 'git.branchDiff').length <= requestsBefore
        ) {
          assert(Date.now() < replacementEnd, 'The package revision did not request its source');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const current = await settleSource();
        assert(
          events.filter((event) => event.method === 'git.branchDiff').length > requestsBefore,
          'The package revision must start a replacement source read',
        );
        for (const send of heldSource.splice(0)) send();
        const afterStale = await settleSource();
        assert.equal(afterStale.files, 51);
        await save(`source-revision-${index}.json`, { method, current, afterStale });
      }
      await cdp('screenshot', route, path.join(output, 'source-revised.png'));
    }
    release = true;
    for (const send of held.splice(0)) send();
    await save('rpc.json', events);
    let after = await read();
    if (control) {
      const deadline = Date.now() + 5000;
      while (!after.text.includes('Saved publication') && Date.now() < deadline)
        after = await read();
    }
    await save('after-release.json', after);
    if (!control) {
      assert(after.gate, 'A failed current read retains stored facts');
      assert(!after.text.includes('Run unavailable'), 'Slow/failed reads must stay local');
    } else
      assert(
        after.text.includes('Saved publication'),
        'Releasing the same replies restores the package',
      );
  }
  await save('rpc-final.json', events);
  if (!codeProof)
    assert(
      !events.some((e) =>
        /^(slot\.refresh$|fleet\.refreshSlots$|run\.(resolveDecision|replay|cancel|overrideClaim|reviewVisualClaim)|dispatch\.(?!queue\.list$))/.test(
          e.method ?? '',
        ),
      ),
      'The proof must not issue a command',
    );
  if (primaryError) throw primaryError;
  await save('result.json', {
    status: 'PASS',
    mode: codeProof
      ? expectMissing
        ? 'code-review-control'
        : 'code-review'
      : costProof
        ? 'fleet-cost'
        : fleetProof
          ? 'fleet'
          : control
            ? 'causal-negative'
            : 'progressive',
    ...(costResult ? { cost: costResult } : {}),
    paintMs: gatePaintMs,
    targetMs: 2000,
    targetMet: fleetProof ? undefined : !control,
    sourceType: 'isolated fixture through real authenticated gateway',
    historicalRunReproductionClaimed: false,
  });
} catch (error) {
  primaryError = error;
  await save('failure.json', { message: error.message, stack: error.stack, events });
  if (route) {
    try {
      await cdp('screenshot', route, path.join(output, 'failure.png'));
    } catch (captureError) {
      await save('failure-capture.json', { message: captureError.message });
    }
  }
} finally {
  const failures = cleanupFailures;
  const attempt = async (fn) => {
    try {
      await fn();
    } catch (error) {
      failures.push(error.message);
    }
  };
  if (route) await attempt(() => cdp('close', route));
  if (ui)
    await attempt(() => {
      ui.httpServer?.closeAllConnections();
      return ui.close();
    });
  for (const socket of sockets) socket.terminate();
  if (proxySockets) await attempt(() => new Promise((yes) => proxySockets.close(yes)));
  if (proxyServer) await attempt(() => closeServer(proxyServer));
  if (gatewaySockets) {
    for (const socket of gatewaySockets.clients) socket.terminate();
    await attempt(() => new Promise((yes) => gatewaySockets.close(yes)));
  }
  if (gatewayServer) await attempt(() => closeServer(gatewayServer));
  await attempt(() => rm(root, { recursive: true, force: true }));
  await save('cleanup.json', {
    status: failures.length ? 'FAIL' : 'PASS',
    failures,
    ownedRootRemoved: root,
  });
}
if (cleanupFailures.length)
  throw new AggregateError(
    [...(primaryError ? [primaryError] : []), ...cleanupFailures],
    'Owned proof cleanup failed',
  );
if (primaryError) throw primaryError;
console.log(
  JSON.stringify({
    status: 'PASS',
    output,
    mode: codeProof
      ? expectMissing
        ? 'code-review-control'
        : 'code-review'
      : costProof
        ? 'fleet-cost'
        : fleetProof
          ? 'fleet'
          : control
            ? 'causal-negative'
            : 'progressive',
  }),
);
