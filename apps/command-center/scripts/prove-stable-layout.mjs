// Presentation proof over an isolated protocol fixture. It never starts a farm or a worker.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { WebSocket, WebSocketServer } from 'ws';

import {
  resourceCollectorReadMethods,
  resourceDependenciesForRead,
} from '../../../packages/protocol/src/client-cache/registry.ts';
import { mockPipelineRuns, mockRuns } from '../ui/src/dev/mock-data.ts';

import { proveRefetchNotices, recordBrowserProof } from './stable-layout-refetch-proof.mjs';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const output = process.env.FARMSLOT_LAYOUT_EVIDENCE;
assert(output, 'Select an evidence directory');
const uiPort = Number(process.env.VITE_PORT);
const port = Number(process.env.GATEWAY_PORT);
assert(uiPort > 1024 && port > 1024 && uiPort !== port, 'Select two private ports');
assert(process.env.FARMSLOT_CDP_PORT, 'Select Agent Chrome CDP');
await mkdir(output, { recursive: true });
const execute = promisify(execFile);
const frames = [];
const heldReplies = [];
let holdingReplies = false;
const releaseReplies = () => {
  holdingReplies = false;
  for (const send of heldReplies.splice(0)) send();
};
const epoch = `layout-fixture-${randomUUID()}`;
let revision = 0;
let mode = 'empty';
const refetchProof = process.env.FARMSLOT_LAYOUT_REFETCH === '1';
const legacyProof = process.env.FARMSLOT_LAYOUT_BEFORE === '1';
const uiRoot = process.env.FARMSLOT_LAYOUT_UI_ROOT ?? path.join(source, 'apps/command-center/ui');
assert(
  !legacyProof || process.env.FARMSLOT_LAYOUT_UI_ROOT,
  'The before proof requires an explicit archived UI',
);
const now = Date.now();
const decision = {
  id: 'layout-decision',
  title: 'Review the saved result',
  description: 'Layout proof fixture',
  slotId: 'layout-slot',
  type: 'engine_human_gate',
  createdAt: new Date(now).toISOString(),
  runMeta: { runId: 'layout-run', flowType: 'dev', ticketOrPr: 'LAYOUT-1' },
  actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
};
const fleet = {
  slots: [],
  machines: [],
  summary: { total: 0, ready: 0, busy: 0, held: 0, manual: 0, disabled: 0, custom: 0 },
  checkedAt: new Date(now).toISOString(),
};
const fixtureRun = {
  ...mockRuns()[0],
  status: 'monitoring',
  id: 'layout-run',
  familyId: undefined,
  slotId: null,
  taskFile: null,
  decisions: [],
};
// A resolved gate from the checked-in sample, served through the ordinary run APIs.
const gateRun = structuredClone(
  mockPipelineRuns().find((run) => run.decisions.some((item) => item.payload?.kind === 'ready')),
);
assert(gateRun, 'The presentation fixture needs a real ready-package shape');
gateRun.id = 'layout-run';
gateRun.familyId = 'layout-run';
gateRun.status = 'done';
gateRun.slotId = null;
gateRun.taskFile = null;
gateRun.decisions = gateRun.decisions.filter((item) => item.payload?.kind === 'ready');
for (const item of gateRun.decisions) {
  item.resolvedAt = new Date(now).toISOString();
  item.resolvedAction = 'approve-publish';
  item.payload.headSha = 'a'.repeat(40);
  item.payload.artifactManifest = [];
  item.payload.prPackage = {
    id: 'layout-package',
    gatePolicy: { owner: 'human', publishAuthority: 'human' },
    publicationTarget: 'draft',
    publicationStatus: 'not_published',
    packageHash: 'b'.repeat(64),
    artifactPath: 'artifacts/pr-package.json',
    branch: 'layout-fixture',
    headSha: 'a'.repeat(40),
    diffStat: { files: 0, additions: 0, deletions: 0 },
    draftTitle: 'Layout proof',
    draftBody: '',
    reviewArtifactIds: [],
    createdAt: new Date(now).toISOString(),
  };
}
function observedRun() {
  if (!refetchProof) return fixtureRun;
  return structuredClone(gateRun);
}
const values = {
  'run.list': () => ({ runs: [refetchProof ? gateRun : fixtureRun] }),
  'run.get': () => ({ run: observedRun() }),
  'run.recipeRunsForRun': () => ({ recipeRuns: [], selectedRecipeRunId: null }),
  'config.templateOptions': () => ({ options: [] }),
  'runner.visibleModels.get': () => ({ runners: [] }),
  'task.progress': () => ({ markdown: '', structured: null }),
  'decision.list': () => ({
    decisions: mode === 'decision' ? [decision, { ...decision, id: 'same-subject' }] : [],
  }),
  'fleet.status': () => ({
    fleet,
    observation: { status: 'ready', observedAt: now },
    canonical: true,
    projectionMatches: true,
  }),
  'pr.list': () => ({ prs: [], observation: { status: 'ready', observedAt: now } }),
  'config.projects': () => ({ projects: [] }),
  'dispatch.queue.list': () => ({ items: [] }),
  'backlog.list': () => ({ items: [] }),
  'workGraph.list': () => ({ graphs: [] }),
  'node.list': () => ({ nodes: [] }),
  'tmux.workers': () => ({ workers: [] }),
  'gateway.status': () => ({
    version: 'fixture',
    capabilities: {},
    releaseNotes: { version: 'fixture', items: [] },
    observation: { status: 'ready', observedAt: now },
    update: {
      canUpdate: false,
      updateAvailable: mode === 'update',
      ...(mode === 'update-complete'
        ? {
            operation: {
              id: `layout-update-${now}-${revision}`,
              phase: 'complete',
              message: 'Checkout updated',
              localSha: 'a'.repeat(40),
              targetSha: 'b'.repeat(40),
              updatedAt: new Date(now).toISOString(),
              gatewayRestartRequired: true,
              desktopRebuildRequired: true,
            },
          }
        : {}),
      branch: 'fixture',
      localSha: (mode === 'update-complete' ? 'b' : 'a').repeat(40),
      remoteSha: 'b'.repeat(40),
      commitsBehind: 1,
      commitsAhead: 0,
      lastChecked: new Date(now).toISOString(),
      updateCommand: 'farmslot update',
      error: null,
    },
  }),
};
const server = createServer((_request, response) => {
  response.writeHead(404).end();
});
const wss = new WebSocketServer({ server });
wss.on('connection', (socket) =>
  socket.on('message', (raw) => {
    const request = JSON.parse(String(raw));
    frames.push({
      at: Date.now(),
      method: request.method,
      ...(request.method === 'run.get'
        ? { params: { runId: request.params?.runId, view: request.params?.view } }
        : {}),
    });
    const reply = { type: 'res', id: request.id, ok: true };
    if (request.method === 'auth.connect')
      reply.payload = {
        ok: true,
        clientKind: 'ui',
        authMode: 'token',
        authenticatedAt: now,
        principal: {
          id: 'layout-fixture',
          generation: 1,
          subjectKind: 'service',
          displayName: 'Layout fixture',
          roles: [{ role: 'admin', scope: { kind: 'global' } }],
        },
        capabilities: {
          httpBearerAuth: false,
          voiceInstructionFormatting: false,
          workspaceAccess: 'farm',
          resourceChanges: {
            version: 1,
            epoch,
            versionLists: false,
            observedReads: 1,
            workspaceReads: 1,
            upstreamObservers: { version: 1, methods: resourceCollectorReadMethods() },
          },
        },
      };
    else if (request.method === 'resource.observers.replace')
      reply.payload = { version: 1, sequence: request.params.sequence, applied: true };
    else if (request.method === 'gateway.ping') reply.payload = { ok: true };
    else if (mode === 'error' && request.method === 'run.list' && !request.params?.active) {
      reply.ok = false;
      reply.error = { code: 'UNAVAILABLE', message: 'Fixture read is unavailable' };
    } else if (
      refetchProof &&
      mode === 'refetch-error' &&
      request.method === 'config.templateOptions'
    ) {
      reply.ok = false;
      reply.error = {
        code: 'UNAVAILABLE',
        message:
          'Project template versions could not be refreshed. Saved choices are still available while the project source reconnects.',
      };
    } else if (values[request.method]) {
      reply.payload = values[request.method](request.params);
      reply.resourceState = {
        epoch,
        dependencies: (
          resourceDependenciesForRead(request.method, request.params, 'layout-fixture') ?? []
        ).map((key) => ({ key, revision })),
      };
    } else {
      reply.ok = false;
      reply.error = {
        code: 'METHOD_NOT_FOUND',
        message: `Fixture does not supply ${request.method}`,
      };
    }
    if (refetchProof && holdingReplies)
      heldReplies.push(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply));
      });
    else socket.send(JSON.stringify(reply));
  }),
);
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
        {
          cwd: source,
          env: { ...process.env, FARMSLOT_UI_URL: `http://127.0.0.1:${uiPort}` },
          timeout: 60000,
          maxBuffer: 1024 * 1024,
        },
      )
    ).stdout,
  );
const save = (name, data) =>
  writeFile(path.join(output, name + '.json'), JSON.stringify(data, null, 2) + '\n');
const probe = path.join(source, 'apps/command-center/scripts/probes/stable-layout.js');
let target;
let emulation;
let emulationId = 0;
const pendingEmulation = new Map();
async function viewport(width) {
  if (!emulation) {
    const tabs = await (
      await fetch(`http://127.0.0.1:${process.env.FARMSLOT_CDP_PORT}/json`)
    ).json();
    emulation = new WebSocket(tabs.find((tab) => tab.id === target.slice(1)).webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      emulation.once('open', resolve);
      emulation.once('error', reject);
    });
    emulation.on('message', (raw) => {
      const result = JSON.parse(String(raw));
      const settle = pendingEmulation.get(result.id);
      if (settle) {
        pendingEmulation.delete(result.id);
        result.error
          ? settle.reject(new Error(result.error.message))
          : settle.resolve(result.result);
      }
    });
  }
  // Keep this owned headless target active without stealing the operator's window focus.
  await browserCall('Emulation.setFocusEmulationEnabled', { enabled: true });
  await browserCall('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
}
function browserCall(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++emulationId;
    pendingEmulation.set(id, { resolve, reject });
    emulation.send(JSON.stringify({ id, method, params }));
  });
}
const presses = [];
async function press(selector) {
  const result = await cdp('click', target, selector, '--observe-file', probe);
  presses.push({ selector, clickedAt: result.clickedAt, observation: result.observation });
}
const escape = () => cdp('key', target, 'Escape');
const inspect = async () => cdp('eval', target, '--file', probe);
async function capture(file) {
  const before = await inspect();
  // Keep screenshot capture on the connection that owns this proof's emulated viewport.
  const result = await browserCall('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
  });
  await writeFile(file, Buffer.from(result.data, 'base64'));
  assert.equal((await inspect()).width, before.width, 'Capture must preserve the viewport');
}
async function until(accept, label) {
  // Collection rereads may legitimately wait for their 30-second floor.
  const deadline = Date.now() + 45000;
  let actual;
  do {
    actual = await inspect();
    if (accept(actual)) return actual;
    await delay(100);
  } while (Date.now() < deadline);
  await save('timeout-' + label, actual);
  assert.fail(label + ': ' + JSON.stringify(actual));
}
function transition(next) {
  mode = next;
  holdingReplies = next === 'refetch-gap';
  revision++;
  const changes = [
    { family: 'decisions', scope: 'farm' },
    { family: 'runs', scope: 'farm' },
    { family: 'gateway-update', scope: 'gateway' },
    ...(refetchProof
      ? [
          { family: 'run', runId: 'layout-run' },
          { family: 'configuration', scope: 'farm' },
        ]
      : []),
  ].map((key) => ({ key, revision, kind: 'updated' }));
  for (const socket of wss.clients)
    if (socket.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          type: 'event',
          event: 'resource.changed',
          payload: { version: 1, epoch, changes },
        }),
      );
  return revision;
}
let vite;
let viteLog = '';
let failure;
let cleanupFailures = [];
try {
  const ffmpeg = await execute('ffmpeg', ['-version'], { timeout: 10000 });
  await save('recording-preflight', { ffmpeg: ffmpeg.stdout.split('\n')[0] });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  vite = spawn(
    process.execPath,
    [
      path.join(source, 'node_modules/vite/bin/vite.js'),
      '--config',
      'vite.config.ts',
      '--host',
      '127.0.0.1',
    ],
    {
      cwd: uiRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  vite.stdout.on('data', (data) => {
    viteLog += data;
  });
  vite.stderr.on('data', (data) => {
    viteLog += data;
  });
  const end = Date.now() + 30000;
  let ready = false;
  while (Date.now() < end) {
    try {
      ready = (await fetch(`http://127.0.0.1:${uiPort}`)).ok;
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw error;
    }
    if (ready) break;
    assert(vite.exitCode === null, viteLog);
    await delay(100);
  }
  assert(ready, viteLog);
  const opened = await cdp('goto', `http://127.0.0.1:${uiPort}/#runs`, '--new');
  target = '@' + opened.id;
  const record = (name, run) =>
    recordBrowserProof({ name, run, browserCall, emulation, output, save });
  await viewport(1280);
  await until((value) => value.connected, 'connected');
  const modals = await cdp(
    'eval',
    target,
    "return { open: Boolean(document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('button')) };",
  );
  if (modals.open) await press('whats-new-modal >>> button.primary');
  if (legacyProof) {
    const samples = [];
    await until((value) => value.rowTop !== undefined, 'legacy-row');
    await record('tray-before-1280', async () => {
      for (const next of ['empty', 'error', 'empty', 'update', 'empty', 'update-complete']) {
        transition(next);
        const current = await until(
          (value) =>
            next === 'error'
              ? value.legacyReadStatus.includes('Fixture read is unavailable')
              : next.startsWith('update')
                ? value.updateVisible
                : !value.updateVisible &&
                  !value.legacyReadStatus.includes('Fixture read is unavailable'),
          next,
        );
        samples.push({ phase: next, ...current });
      }
    });
    const tops = samples.map((value) => value.rowTop);
    const shift = Math.max(...tops) - Math.min(...tops);
    assert(shift > 0, 'The original in-flow notices must reproduce a jump');
    await save('legacy-result', {
      result: 'PASS',
      expected: 'original layout jump',
      shift,
      samples,
    });
  } else if (refetchProof) {
    await proveRefetchNotices({
      cdp,
      target,
      browserCall,
      emulation,
      transition,
      output,
      save,
      frames,
      viewport,
      releaseReplies,
    });
  } else {
    const baseline = await until(
      (value) => value.connected && value.stripHeight === 44 && value.rowTop !== undefined,
      'initial',
    );
    for (const { width, expanded } of [
      { width: 1280, expanded: false },
      { width: 414, expanded: false },
      { width: 414, expanded: true },
    ]) {
      const name = `${width}${expanded ? '-expanded' : ''}`;
      await viewport(width);
      if ((await inspect()).sidebarExpanded !== expanded) await press('.fa-nav-toggle');
      await until(
        (value) => value.sidebarExpanded === expanded && !value.sidebarAnimating,
        'sidebar-settled',
      );
      await record(`tray-after-${name}`, async () => {
        const before = await inspect();
        await save(`${name}-baseline`, before);
        assert.equal(before.width, width, 'The browser must use the requested CSS viewport');
        const authBefore = frames.filter((frame) => frame.method === 'auth.connect').length;
        for (const socket of wss.clients)
          socket.close(1012, 'Owned presentation fixture reconnect');
        await until(
          (value) =>
            value.connected &&
            frames.filter((frame) => frame.method === 'auth.connect').length > authBefore,
          'reconnect',
        );
        assert.equal(
          (await inspect()).contentTop,
          before.contentTop,
          'Reconnect cannot move the content',
        );
        for (const phase of [
          'decision',
          'decision',
          'empty',
          'error',
          'empty',
          'update',
          'empty',
        ]) {
          transition(phase);
          const current = await until(
            (value) =>
              phase === 'decision'
                ? value.top === decision.title
                : phase === 'error'
                  ? value.items.some((item) => item.includes('Could not refresh runs'))
                  : phase === 'update'
                    ? value.items.includes('Farmslot update available')
                    : !value.top &&
                      !value.items.includes('Could not refresh runs') &&
                      !value.items.includes('Farmslot update available'),
            phase,
          );
          assert.equal(current.width, width, 'The viewport must stay at the requested width');
          assert.equal(current.contentTop, before.contentTop, 'A notice cannot move the content');
          assert.equal(current.stripHeight, 44);
          assert.equal(
            current.rowTop,
            before.rowTop,
            'A read notice cannot move a retained run row',
          );
          await save(`${name}-${phase}-${revision}`, current);
        }
        transition('decision');
        await until((value) => value.top === decision.title, 'recurrence');
        await press('farm-notification-tray >>> .bell');
        const open = await until((value) => value.panel !== null, 'opened-tray');
        await save(`${name}-open`, open);
        await capture(path.join(output, `${name}-tray.png`));
        assert.equal(open.contentTop, before.contentTop);
        assert(
          open.panel && open.panel.left >= 0 && open.panel.right <= width,
          JSON.stringify(open),
        );
        assert.equal(open.items.filter((title) => title === decision.title).length, 1);

        await escape();
        assert.equal((await inspect()).panel, null);
        transition('empty');
        await until((value) => !value.top, 'cleared');
        transition('update-complete');
        await until(
          (value) => value.items.includes('Farmslot update complete'),
          'completion-guidance',
        );
        await press('farm-notification-tray >>> .bell');
        await press('farm-notification-tray >>> [data-notice-id="gateway-update"] a');
        const guidance = await until(
          (value) =>
            value.updateVisible &&
            value.updateText.includes('packaged gateway needs a restart') &&
            value.updateText.includes('Rebuild and replace'),
          'visible-follow-up',
        );
        assert.equal(guidance.width, width, 'The viewport must stay at the requested width');
        assert.equal(guidance.rowTop, before.rowTop);
        await capture(path.join(output, `${name}-update-guidance.png`));
        await press('update-banner >>> .dismiss');
        await until((value) => !value.items.includes('Farmslot update complete'), 'acknowledged');
        await escape();
        await until((value) => value.panel === null, 'closed-after-dismissal');
        transition('empty');
      });
    }
    const reads = frames.filter((frame) => frame.method === 'run.list').length;
    assert(reads >= 8, 'Repeated observed reads reached the real client adapter');
    await save('result', {
      result: 'PASS',
      baseline,
      browserEnvironment:
        'Owned target with viewport and focus emulation; no application-state injection',
      requests: frames,
      presses,
      limit:
        'Protocol fixture presentation only. No production gateway, native or worker acceptance.',
    });
  }
} catch (error) {
  failure = error;
} finally {
  await writeFile(path.join(output, 'vite.log'), viteLog);
  await save('requests', frames);
  emulation?.close();
  const cleanup = await Promise.allSettled([
    target ? cdp('close', target) : Promise.resolve(),
    (async () => {
      if (vite && vite.exitCode === null) {
        vite.kill('SIGTERM');
        await new Promise((resolve) => vite.once('exit', resolve));
      }
    })(),
    (async () => {
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    })(),
  ]);
  const failed = cleanup.filter((result) => result.status === 'rejected');
  cleanupFailures = failed.map((result) => result.reason);
}

if (failure || cleanupFailures.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanupFailures],
    'Layout proof failed',
  );

console.log(
  JSON.stringify({
    result: 'PASS',
    widths: refetchProof && process.env.FARMSLOT_LAYOUT_EXPECT_SHIFT === '1' ? [1280] : [1280, 414],
    observationRequests: frames.length,
    scope: 'isolated protocol fixture presentation',
  }),
);
