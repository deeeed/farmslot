import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

import { withOwnedGatewayOffline } from './owned-gateway-outage.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const phase = process.argv[2];
assert(
  [
    'file-decision',
    'mirror-arrival',
    'missing-run',
    'inbox-expiry',
    'quiet-gate',
    'feedback-consumption',
    'query-stamps',
    'inbox-web',
    'list-web',
    'bulk-archive-web',
    'detail-web',
    'detail-deletion-web',
    'compare-web',
    'family-web',
    'load-modal-web',
    'history-web',
    'store-navigation-web',
    'slot-run-web',
    'dispatch-runs-web',
    'ready-workspace-web',
    'review-workspace-web',
    'recipe-owner-web',
    'slot-facts-web',
  ].includes(phase),
  'Select a run proof phase',
);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1', 'Select the isolated proof stack');
if (phase.endsWith('-web'))
  assert(/^\d+$/.test(process.env.FARMSLOT_CDP_PORT ?? ''), 'Select the private browser');
assert(process.env.FARMSLOT_HOME && process.env.FARMSLOT_GATEWAY_PROFILE);
assert(/^\d+$/.test(process.env.GATEWAY_PORT ?? ''));
assert.equal(await realpath(process.cwd()), await realpath(root), 'Run from the reviewed checkout');
const profile = await automationGatewayTarget();
assert(profile, 'Select an authenticated test profile');
const gateway = new URL(profile.url);
assert(['localhost', '127.0.0.1', '[::1]'].includes(gateway.hostname));
assert.equal(Number(gateway.port), Number(process.env.GATEWAY_PORT));
const { stdout: listeners } = await execute('lsof', [
  '-nP',
  '-t',
  `-iTCP:${gateway.port}`,
  '-sTCP:LISTEN',
]);
const pid = Number(listeners.trim());
assert(Number.isSafeInteger(pid) && pid > 0, 'Expected one owned gateway');
const { stdout: cwd } = await execute('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
assert(cwd.split('\n').includes(`n${root}/services/gateway`), 'Use the gateway for this checkout');
const home = await realpath(process.env.FARMSLOT_HOME);
const projects = await realpath(process.env.FARMSLOT_PROJECTS_DIR ?? path.join(home, 'projects'));
const withinHome = path.relative(home, projects);
assert(
  withinHome && !withinHome.startsWith('..') && !path.isAbsolute(withinHome),
  'Proof projects must stay inside the isolated home',
);

async function rpc(method, params = {}) {
  const { stdout } = await execute(
    process.execPath,
    [
      path.join(root, 'apps/command-center/scripts/cdp.mjs'),
      'gateway',
      method,
      JSON.stringify(params),
    ],
    {
      env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: '120000' },
      timeout: 150000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
}

if (phase === 'store-navigation-web') {
  const cdp = async (...args) => {
    const { stdout } = await execute(
      process.execPath,
      [path.join(root, 'apps/command-center/scripts/cdp.mjs'), ...args],
      { timeout: 20000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout);
  };
  const probe = path.join(
    root,
    'apps/command-center/scripts/probes/offline-resource-navigation.js',
  );
  const base = new URL(process.env.FARMSLOT_UI_URL ?? `http://localhost:${process.env.VITE_PORT}`);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
  base.hash = 'runs';
  await cdp('goto', base.href);
  const current = async () => {
    const deadline = Date.now() + 45000;
    let value;
    do {
      if (
        (await cdp('tabs')).some(
          (tab) =>
            tab.type === 'page' && tab.url.startsWith(base.origin) && tab.url.includes('#runs'),
        )
      ) {
        value = await cdp('eval', 'runs', '--file', probe);
        if (value.status === 'ready' && value.diagnostics?.storage === 'opfs-sahpool') return value;
      }
      await delay(50);
    } while (Date.now() < deadline);
    assert.fail(
      `Navigation must restore the current SQLite-backed run view: ${JSON.stringify(value)}`,
    );
  };
  let before = await current();
  const cycles = [];
  for (let index = 0; index < 10; index++) {
    const away = new URL(
      `/@fs${root}/apps/command-center/scripts/fixtures/opfs-write-teardown.html`,
      base,
    );
    away.search = new URLSearchParams({
      id: `resource-navigation-${index}`,
      landed: '1',
    }).toString();
    away.hash = 'opfs-diagnostic';
    await cdp('goto', away.href);
    await cdp('eval', 'opfs-diagnostic', 'setTimeout(() => history.back(), 0); return true;');
    const after = await current();
    assert.equal(after.diagnostics.integrity, 'ok');
    assert.equal(after.rows, before.rows, 'Ordinary navigation cannot delete saved runs');
    const restoredDocument = after.documentStartedAt === before.documentStartedAt;
    if (restoredDocument) {
      assert(
        after.workerStarts > before.workerStarts,
        'A restored document must reopen its retired worker',
      );
      assert(
        after.connectionId > before.connectionId,
        'A restored document must reauthenticate on a new connection',
      );
    }
    cycles.push({ index, restoredDocument, before, after });
    before = after;
  }
  assert(
    cycles.some((cycle) => cycle.restoredDocument),
    'Prove a real back/forward-cache restoration',
  );
  const artifacts =
    process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR ?? path.join(home, 'navigation-proof', randomUUID());
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'navigation-cycles.json'), JSON.stringify(cycles, null, 2));
  await cdp('screenshot', 'runs', path.join(artifacts, 'navigation-restored.png'));
  console.log(
    JSON.stringify({
      result: 'PASS',
      action: phase,
      navigationCycles: cycles.length,
      backForwardRestorations: cycles.filter((cycle) => cycle.restoredDocument).length,
      navigationStoreLifecycle: true,
      sqliteIntegrity: 'ok',
      screenshots: artifacts,
    }),
  );
  process.exit(0);
}

if (phase === 'inbox-web') {
  const cdpPath = path.join(root, 'apps/command-center/scripts/cdp.mjs');
  const probePath = path.join(root, 'apps/command-center/scripts/probes/offline-runs.js');
  const route = 'decisions';
  const base = new URL(process.env.FARMSLOT_UI_URL ?? `http://localhost:${process.env.VITE_PORT}`);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
  base.hash = route;
  const id = randomUUID();
  const project = path.join(projects, `offline-inbox-proof-${id}`);
  const task = path.join(project, 'tasks', 'decision');
  const file = path.join(task, '.pending_decision.json');
  const artifacts =
    process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR ?? path.join(home, 'inbox-proof-evidence', id);
  await mkdir(task, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const cdp = async (...args) => {
    const { stdout } = await execute(process.execPath, [cdpPath, ...args], {
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  };
  const snapshot = () => cdp('eval', route, '--file', probePath);
  const row = (value) => value.rows?.find((entry) => entry.id === id);
  const until = async (ready, label, timeout = 45000) => {
    const deadline = Date.now() + timeout;
    let value;
    do {
      value = await snapshot();
      if (ready(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  };
  const button = `decision-inbox >>> [data-decision-id="${id}"]`;
  try {
    base.searchParams.set('inbox-proof', id);
    await cdp('goto', base.href);
    await cdp('focus', route);
    const initial = await until(
      (value) => value.freshness === 'ready' && value.runFreshness === 'ready',
      'The actual collections must finish their current reads',
    );
    assert.equal(initial.storage, 'opfs-sahpool', 'Cold proof requires the owner browser database');
    await writeFile(
      file,
      JSON.stringify({
        id,
        type: 'blocked_alert',
        title: `Private inbox ${id}`,
        actions: [{ id: 'acknowledge', label: 'Acknowledge' }],
        created_at: new Date().toISOString(),
      }),
      { flag: 'wx' },
    );
    const arrived = await until(
      (value) =>
        value.freshness === 'ready' && row(value)?.rendered && row(value)?.disabled === false,
      'A worker-created decision must appear without a client refresh',
    );
    await cdp('screenshot', route, path.join(artifacts, 'arrived.png'));
    await chmod(task, 0o555);
    await cdp('click', route, button);
    const refused = await until(
      (value) => /EACCES|EPERM|permission denied/i.test(row(value)?.error ?? ''),
      'The physical refusal must be visible',
    );
    await cdp('screenshot', route, path.join(artifacts, 'refused.png'));
    await chmod(task, 0o755);
    const beforeOffline = await until(
      (value) => value.freshness === 'ready' && row(value)?.rendered,
      'The saved inbox must be current before going offline',
    );
    let cold;
    let repaint;
    let offlineObservedAt;
    await withOwnedGatewayOffline(async () => {
      const stale = await until(
        (value) => value.freshness === 'stale' && row(value)?.disabled,
        'A stored decision must disable its actions after disconnect',
      );
      assert(stale.observedAt >= beforeOffline.observedAt);
      offlineObservedAt = stale.observedAt;
      await cdp(
        'click',
        route,
        `decision-inbox >>> .decision:has([data-decision-id="${id}"]) .decision-title`,
      );
      await cdp('key', route, '1');
      await until(
        (value) => /Wait for current decisions/.test(row(value)?.error ?? ''),
        'The real keyboard shortcut must refuse stale facts',
      );
      repaint = await until(
        (value) => value.stale && value.stale !== stale.stale,
        'The displayed saved age must repaint without a read',
      );
      base.searchParams.set('offline-cold', randomUUID());
      await cdp('goto', base.href);
      await cdp('focus', route);
      cold = await until(
        (value) => value.freshness === 'stale' && row(value)?.rendered && row(value)?.disabled,
        'A fresh offline document must render the saved inbox',
      );
      assert.equal(
        cold.observedAt,
        offlineObservedAt,
        'Cold rendering must preserve the actual observation time',
      );
      assert(cold.runCount > 0 && cold.runFreshness === 'stale');
      await cdp('screenshot', route, path.join(artifacts, 'cold-offline.png'));
    });
    await until(
      (value) => value.freshness === 'ready' && row(value)?.rendered && !row(value)?.disabled,
      'Reconnect must keep the decision until a current read enables it',
    );
    await access(file);
    await cdp('click', route, button);
    await until(
      (value) => value.freshness === 'ready' && !row(value),
      'An explicit UI resolve must remove the rendered decision',
    );
    await assert.rejects(access(file), { code: 'ENOENT' });
    assert(!(await rpc('decision.list')).decisions.some((entry) => entry.id === id));
    await cdp('screenshot', route, path.join(artifacts, 'resolved.png'));
    console.log(
      JSON.stringify({
        result: 'PASS',
        action: phase,
        id,
        notificationArrival: arrived.observedAt,
        refusal: row(refused).error,
        inboxNotificationObserved: true,
        resolveRefusalVisible: true,
        staleActionsRefused: true,
        staleKeyboardRefused: true,
        ageRepaint: repaint.stale,
        coldObservedAt: cold.observedAt,
        coldInboxRestored: true,
        currentReadBeforeResolve: true,
        coldRunProjectionRows: cold.runCount,
        explicitResolveRemovedFile: true,
        inboxClientProof: true,
        screenshots: artifacts,
      }),
    );
  } finally {
    await chmod(task, 0o755);
    await rm(project, { recursive: true, force: true });
  }
  process.exit(0);
}

if (phase === 'list-web') {
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE);
  const fixture = JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
  assert.equal(fixture.home, home);
  assert.equal(fixture.taskFile, path.join(fixture.taskDir, 'TASK.md'));
  for (const directory of [fixture.taskDir, fixture.workerRepo]) {
    const relative = path.relative(home, await realpath(directory));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }
  const original = (await rpc('run.get', { runId: fixture.runId })).run;
  assert.equal(original.readOnly, false, 'Never mutate imported reference runs');
  assert.equal(original.taskFile, fixture.taskFile);
  assert.equal(original.slotId, fixture.slotId);
  const tag = `offline-list-${randomUUID().slice(0, 24)}`;
  const tags = [...(original.tags ?? []), tag];
  const artifacts =
    process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR ?? path.join(home, 'list-proof-evidence', tag);
  await mkdir(artifacts, { recursive: true });
  const cdpPath = path.join(root, 'apps/command-center/scripts/cdp.mjs');
  const probePath = path.join(root, 'apps/command-center/scripts/probes/offline-run-list.js');
  const route = 'runs';
  const base = new URL(process.env.FARMSLOT_UI_URL ?? `http://localhost:${process.env.VITE_PORT}`);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
  base.hash = `runs?tab=all&tag=${tag}`;
  const cdp = async (...args) => {
    const { stdout } = await execute(process.execPath, [cdpPath, ...args], {
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  };
  const until = async (ready, label, timeout = 45000) => {
    const deadline = Date.now() + timeout;
    let value;
    do {
      value = await cdp('eval', route, '--file', probePath);
      if (ready(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  };
  const hasRun = (value) => value.rows?.some((row) => row.id === fixture.runId && row.visible);
  let cold;
  let beforeOffline;
  let age;
  try {
    base.searchParams.set('list-proof', tag);
    await cdp('goto', base.href);
    await cdp('focus', route);
    const initial = await until(
      (value) =>
        value.tag === tag &&
        value.tagFreshness === 'ready' &&
        value.freshness === 'ready' &&
        !hasRun(value),
      'The empty tagged list must finish a current read',
    );
    assert.equal(
      initial.storage,
      'opfs-sahpool',
      'The filtered proof requires actual browser SQLite',
    );
    await rpc('run.tags.set', { runId: fixture.runId, tags });
    await until(
      (value) => value.tagFreshness === 'ready' && hasRun(value),
      'An external tag write must populate the open filtered list',
    );
    await cdp('screenshot', route, path.join(artifacts, 'filtered-arrival.png'));
    await rpc('run.tags.set', { runId: fixture.runId, tags: original.tags ?? [] });
    await until(
      (value) => value.tagFreshness === 'ready' && !hasRun(value),
      'Removing a tag must remove the row from the open filtered list',
    );
    await rpc('run.tags.set', { runId: fixture.runId, tags });
    beforeOffline = await until(
      (value) => value.tagFreshness === 'ready' && value.freshness === 'ready' && hasRun(value),
      'The filtered list must be saved before disconnect',
    );
    await withOwnedGatewayOffline(async () => {
      const stale = await until(
        (value) =>
          value.freshness === 'stale' &&
          value.tagFreshness === 'stale' &&
          hasRun(value) &&
          value.actionsDisabled,
        'Saved filtered rows must disable their command controls',
      );
      age = await until(
        (value) => value.stale && value.stale !== stale.stale,
        'Saved run age must repaint while offline',
      );
      assert(!/old\s+old/.test(age.stale), 'The saved age must not repeat its age suffix');
      base.searchParams.set('offline-cold', randomUUID());
      await cdp('goto', base.href);
      await cdp('focus', route);
      cold = await until(
        (value) =>
          value.freshness === 'stale' &&
          value.tagFreshness === 'stale' &&
          hasRun(value) &&
          value.actionsDisabled,
        'A new offline document must restore the actual saved filtered list',
      );
      assert(stale.tagObservedAt >= beforeOffline.tagObservedAt);
      assert.equal(cold.tagObservedAt, stale.tagObservedAt);
      await cdp('screenshot', route, path.join(artifacts, 'filtered-cold-offline.png'));
    });
    await until(
      (value) =>
        value.freshness === 'ready' &&
        value.tagFreshness === 'ready' &&
        hasRun(value) &&
        !value.actionsDisabled,
      'Filtered run actions must wait for a current reconnect read',
    );
    await rpc('run.tags.set', { runId: fixture.runId, tags: original.tags ?? [] });
    await until(
      (value) => value.tagFreshness === 'ready' && !hasRun(value),
      'The restored tag set must remove the proof row without Refresh',
    );
    console.log(
      JSON.stringify({
        result: 'PASS',
        action: phase,
        runId: fixture.runId,
        filteredMembershipUpdates: true,
        coldFilteredListRestored: true,
        staleRunActionsDisabled: true,
        currentReadBeforeRunActions: true,
        savedAge: age.stale,
        coldObservedAt: cold.tagObservedAt,
        screenshots: artifacts,
      }),
    );
  } finally {
    const current = (await rpc('run.get', { runId: fixture.runId })).run;
    if (current.tags?.includes(tag))
      await rpc('run.tags.set', { runId: fixture.runId, tags: original.tags ?? [] });
  }
  process.exit(0);
}

async function observeResources() {
  const socket = new WebSocket(profile.url);
  const changes = [];
  socket.addEventListener('message', ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.type === 'event' && frame.event === 'resource.changed')
      changes.push(
        ...frame.payload.changes.map((change) => ({ ...change, receivedAt: Date.now() })),
      );
  });
  const request = (method, params = {}, stamped = false) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = (error, result) => {
        clearTimeout(timer);
        socket.removeEventListener('message', receive);
        if (error) reject(error);
        else resolve(result);
      };
      const receive = ({ data }) => {
        const frame = JSON.parse(data);
        if (frame.type !== 'res' || frame.id !== id) return;
        finish(
          frame.ok
            ? undefined
            : Object.assign(new Error(frame.error?.message ?? 'Gateway read refused'), {
                code: frame.error?.code,
              }),
          stamped ? { data: frame.payload, resourceState: frame.resourceState } : frame.payload,
        );
      };
      const timer = setTimeout(
        () => finish(new Error(`Resource proof ${method} timed out`)),
        10000,
      );
      socket.addEventListener('message', receive);
      socket.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Resource proof connection timed out')),
        10000,
      );
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('Resource proof connection failed'));
        },
        { once: true },
      );
    });
    const auth = await request('auth.connect', {
      clientKind: 'ui',
      token: profile.credential.token,
    });
    assert.equal(auth.capabilities.resourceChanges.version, 1);
    return {
      changes,
      epoch: auth.capabilities.resourceChanges.epoch,
      read: request,
      readStamped: (method, params) => request(method, params, true),
      barrier: () => request('gateway.ping'),
      close: () => socket.close(),
    };
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function withRunFixture(build, prove) {
  assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
  assert.equal(process.env.FARMSLOT_RUNS_DIR, path.join(home, 'runs'));
  assert((await realpath(process.env.FARMSLOT_RUNS_DIR)).startsWith(`${home}/`));
  const runId = randomUUID();
  const runFile = path.join(process.env.FARMSLOT_RUNS_DIR, `${runId}.json`);
  let seeded = false;
  let observed;
  let run;
  try {
    await withOwnedGatewayOffline(async () => {
      const now = Date.now();
      const createdAt = new Date(now).toISOString();
      run = {
        id: runId,
        familyId: runId,
        parentRunId: null,
        familyRootTicketOrPr: 'Offline run proof',
        lane: 'validation',
        variant: null,
        flowType: 'dev',
        mode: 'interactive',
        status: 'done',
        project: 'farmslot-farm',
        ticketOrPr: 'Offline run proof',
        slotId: null,
        branch: null,
        completionPolicy: 'artifact-only',
        taskFile: null,
        steps: [],
        decisions: [],
        metrics: {
          nudgeCount: 0,
          model: null,
          runner: null,
          runnerSessionId: null,
          runnerSessionPath: null,
        },
        createdAt,
        startedAt: createdAt,
        completedAt: createdAt,
        updatedAt: createdAt,
        agentContexts: [],
        ...(await build({ runId, now, createdAt })),
      };
      assert.equal(run.id, runId);
      assert.equal(run.slotId, null);
      assert.equal(run.taskFile, null);
      await writeFile(runFile, JSON.stringify(run, null, 2), { flag: 'wx', mode: 0o600 });
      seeded = true;
    });
    observed = await observeResources();
    return await prove({ runId, runFile, run, observed });
  } finally {
    observed?.close();
    if (seeded)
      await withOwnedGatewayOffline(async () => {
        try {
          await rm(runFile);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          // An archive proof legitimately moved this owned fixture out of the live store.
          const archived = path.join(home, 'runs', 'archive', `${runId}.json`);
          assert.equal(JSON.parse(await readFile(archived, 'utf8')).id, runId);
          await rm(archived);
        }
      });
  }
}

async function detailBrowser(runId) {
  const route = `run/${runId}`;
  const base = new URL(process.env.FARMSLOT_UI_URL ?? `http://localhost:${process.env.VITE_PORT}`);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
  base.searchParams.set('detail-proof', randomUUID());
  base.hash = route;
  const artifacts =
    process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR ??
    path.join(home, 'detail-proof-evidence', randomUUID());
  await mkdir(artifacts, { recursive: true });
  const cdp = async (...args) => {
    const { stdout } = await execute(
      process.execPath,
      [path.join(root, 'apps/command-center/scripts/cdp.mjs'), ...args],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout);
  };
  const probe = path.join(root, 'apps/command-center/scripts/probes/offline-run-detail.js');
  const storeProbe = path.join(
    root,
    'apps/command-center/scripts/probes/offline-run-detail-store.js',
  );
  const snapshot = () => cdp('eval', route, '--file', probe);
  const until = async (ready, label) => {
    const deadline = Date.now() + 45000;
    let value;
    do {
      value = await snapshot();
      if (ready(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  };
  const navigate = async () => {
    await cdp('goto', base.href);
    await cdp('focus', route);
  };
  await navigate();
  return {
    base,
    route,
    cdp,
    artifacts,
    until,
    navigate,
    peek: () => cdp('eval', route, '--file', storeProbe),
  };
}

if (phase === 'slot-facts-web') {
  assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
  assert(process.env.FARMSLOT_SLOT_RESOURCE_PROOF);
  const fixture = JSON.parse(await readFile(process.env.FARMSLOT_SLOT_RESOURCE_PROOF, 'utf8'));
  assert.equal(await realpath(fixture.home), home);
  const pool = await realpath(fixture.poolFile);
  assert(pool.startsWith(`${home}/pool/`), 'Only mutate the owned proof pool');
  const beforePool = await readFile(pool);
  const beforePoolMode = (await stat(pool)).mode & 0o777;
  const originalMode = JSON.parse(beforePool).slots.find(
    (slot) => slot.id === fixture.slotId,
  )?.mode;
  assert.equal(originalMode, 'custom');
  const inspect = async () => {
    const fleet = (await rpc('fleet.status')).fleet;
    assert.equal(fleet.slots.length, 1, 'Use an isolated one-slot fleet');
    const slot = fleet.slots[0];
    assert.equal(slot.slot, fixture.slotId);
    assert.equal(slot.repo, fixture.repo);
    assert(!slot.currentRunId && !slot.phase && slot.lifecycle !== 'busy');
    assert.equal((await rpc('run.list', { limit: 1 })).runs.length, 0);
    return slot;
  };
  await inspect();
  const route = `slot/${fixture.slotId}`;
  const base = new URL(process.env.FARMSLOT_UI_URL);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
  base.hash = route;
  const artifacts = process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR;
  assert(artifacts);
  await mkdir(artifacts, { recursive: true });
  const cdp = async (...args) => {
    const { stdout } = await execute(
      process.execPath,
      [path.join(root, 'apps/command-center/scripts/cdp.mjs'), ...args],
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  };
  const probe = path.join(root, 'apps/command-center/scripts/probes/offline-slot-run.js');
  const until = async (test, label) => {
    const deadline = Date.now() + 45000;
    let value;
    do {
      value = await cdp('eval', route, '--file', probe);
      if (test(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  };
  let observed, failure, result;
  const cleanup = [];
  try {
    observed = await observeResources();
    await cdp('goto', base.href);
    await cdp('focus', route);
    let before = await until(
      (value) =>
        value.mounted && value.reads?.slot.status === 'ready' && value.slotLifecycle === 'manual',
      'The actual slot workspace must observe its canonical current context',
    );
    if (
      await cdp(
        'eval',
        route,
        "return Boolean(document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('.backdrop'));",
      )
    )
      await cdp('click', route, 'whats-new-modal >>> button.primary');
    const cycles = [];
    for (const mode of ['dispatch', 'custom']) {
      const since = observed.changes.length;
      await inspect();
      await rpc('config.slot.update', { slotId: fixture.slotId, update: { mode } });
      const currentSlot = await inspect();
      assert.equal(JSON.parse(await readFile(pool)).slots[0].mode, mode);
      const after = await until(
        (value) =>
          value.reads?.slot.status === 'ready' &&
          value.slotLifecycle === currentSlot.lifecycle &&
          value.renderedLifecycle === currentSlot.lifecycle &&
          value.lifecycleVisible &&
          value.reads.slot.observedAt > before.reads.slot.observedAt,
        'A slot fact change must refetch the existing canonical query without Refresh',
      );
      assert.equal(after.reads.slot.query.id, before.reads.slot.query.id);
      assert.equal(after.slotCurrentRunId, null);
      const key = (value) => value.family === 'slot' && value.slotId === fixture.slotId;
      const prior = before.reads.slot.resourceState.dependencies.find(({ key: value }) =>
        key(value),
      );
      const current = after.reads.slot.resourceState.dependencies.find(({ key: value }) =>
        key(value),
      );
      assert(current.revision > prior.revision);
      await observed.barrier();
      assert(observed.changes.slice(since).some((change) => key(change.key)));
      assert(
        !observed.changes.slice(since).some(({ key }) => key.family === 'runs'),
        'A mode change must not invalidate unchanged run bindings',
      );
      cycles.push({
        mode,
        priorRevision: prior.revision,
        currentRevision: current.revision,
        after,
      });
      await cdp('screenshot', route, path.join(artifacts, `slot-${mode}.png`));
      before = after;
    }
    assert.equal((await inspect()).lifecycle, 'manual');
    assert.deepEqual(await readFile(pool), beforePool);
    assert.equal((await stat(pool)).mode & 0o777, beforePoolMode);
    await writeFile(path.join(artifacts, 'slot-fact-cycles.json'), JSON.stringify(cycles, null, 2));
    result = {
      result: 'PASS',
      slotFactsNotified: true,
      canonicalSlotContextRefetched: true,
      unchangedRunBindingsRetained: true,
      wholeFleetMigrationComplete: false,
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      await inspect();
      await rpc('config.slot.update', { slotId: fixture.slotId, update: { mode: originalMode } });
      assert.deepEqual(await readFile(pool), beforePool);
      assert.equal((await stat(pool)).mode & 0o777, beforePoolMode);
    } catch (error) {
      cleanup.push(error);
    }
    observed?.close();
  }
  if (failure || cleanup.length)
    throw new AggregateError([...(failure ? [failure] : []), ...cleanup], 'Slot fact proof failed');
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (phase === 'recipe-owner-web') {
  assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE);
  const fixture = JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
  assert.equal(fixture.home, home);
  assert((await realpath(fixture.runFile)).startsWith(`${home}/runs/`));
  const originalBytes = await readFile(fixture.runFile);
  const originalMode = (await stat(fixture.runFile)).mode & 0o777;
  const original = (await rpc('run.get', { runId: fixture.runId })).run;
  assert.equal(original.readOnly, false);
  assert.equal(original.status, 'done', 'Never activate the reusable mirror run');
  assert.equal(original.slotId, fixture.slotId);
  assert.equal(original.decisions.length, 0);
  const fleet = await rpc('fleet.status');
  const slot = fleet.fleet.slots.find((entry) => entry.slot === fixture.slotId);
  assert(slot && !slot.currentRunId && !slot.phase && slot.enabled === false);
  const proofRun = {
    ...JSON.parse(originalBytes),
    // A mismatching branch uses the actual review recovery path without inventing
    // a HEAD in this intentionally unborn repository. The slot stays unbound.
    branch: `offline-recipe-owner-${randomUUID()}`,
    decisions: [
      {
        id: randomUUID(),
        type: 'engine_human_gate',
        title: 'Private recipe ownership proof',
        description: 'Terminal owned mirror; backend replay must be refused',
        createdAt: new Date().toISOString(),
        actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
        payload: {
          kind: 'review',
          prNumber: null,
          repo: null,
          recommendation: 'COMMENT',
          reviewMd: 'Private recipe ownership proof',
          lineComments: [],
          recipeJson: JSON.stringify({
            title: 'Private refused replay',
            workflow: { entry: 'done', nodes: { done: { action: 'end', status: 'pass' } } },
          }),
        },
      },
    ],
  };
  const probe = path.join(root, 'apps/command-center/scripts/probes/offline-review-workspace.js');
  let seeded = false;
  let browser;
  let result;
  try {
    await withOwnedGatewayOffline(async () => {
      await writeFile(fixture.runFile, JSON.stringify(proofRun, null, 2));
      seeded = true;
    });
    browser = await detailBrowser(fixture.runId);
    const { route, cdp, artifacts } = browser;
    const snapshot = () => cdp('eval', route, '--file', probe);
    const until = async (predicate, label) => {
      const deadline = Date.now() + 45000;
      let value;
      do {
        value = await snapshot();
        if (predicate(value)) return value;
        await delay(100);
      } while (Date.now() < deadline);
      assert.fail(`${label}: ${JSON.stringify(value)}`);
    };
    await until(
      (value) => value.canonical && !value.paused && value.recipe?.runId === fixture.runId,
      'The actual canonical review must admit its recipe controls',
    );
    await cdp('click', route, 'run-detail >>> review-workspace .rw-tab:last-child');
    await until((value) => value.activeTab === 'recipe', 'Open the actual recipe tab');
    const replay = 'run-detail >>> review-workspace .rw-recipe-toggle';
    await cdp('click', route, replay);
    await until(
      (value) =>
        !value.recipeRunning &&
        /not ready for recipe replay|no admitted source lock/.test(value.recipe?.output),
      'The backend refusal must be visible and release the actual parent running state',
    );
    const message = 'run-detail >>> review-workspace .recipe-output-scroll > div:nth-child(2)';
    await cdp('click', route, message);
    await until(
      (value) => value.recipe?.errorVisible,
      'The actual refusal must be readable in the viewport',
    );
    await writeFile(
      path.join(artifacts, 'recipe-current-refusal.json'),
      JSON.stringify(await snapshot(), null, 2),
    );
    await cdp('screenshot', route, path.join(artifacts, 'recipe-current-refusal.png'));
    await withOwnedGatewayOffline(
      async () => {
        await until(
          (value) =>
            value.paused &&
            value.recipe?.disabled &&
            !value.recipe.running &&
            !value.recipeRunning &&
            /Check recipe history before replaying/.test(value.recipe.output),
          'A real interrupted start must retire ownership and visibly report uncertain delivery',
        );
        await cdp('click', route, message);
        await until(
          (value) => value.recipe?.errorVisible,
          'The uncertain-delivery message must remain readable',
        );
        await writeFile(
          path.join(artifacts, 'recipe-interrupted-start.json'),
          JSON.stringify(await snapshot(), null, 2),
        );
        await cdp('screenshot', route, path.join(artifacts, 'recipe-interrupted-start.png'));
      },
      {
        beforeStop: async () => {
          await cdp('click', route, replay);
          await until(
            (value) =>
              value.recipeRunning &&
              value.recipe?.running &&
              /Connecting to gateway/.test(value.recipe.output),
            'Keep the real replay start pending before the owned gateway outage',
          );
        },
      },
    );
    const recovered = await until(
      (value) => !value.paused && !value.recipeRunning && !value.recipe?.running,
      'Current reconnect reads must not restart the interrupted recipe',
    );
    assert.doesNotMatch(recovered.recipe.output, /Recipe replay accepted/);
    // Navigate using the router, then return to the same canonical fixture.
    await cdp('eval', route, "location.hash='runs'; return true;");
    await cdp('eval', 'runs', `location.hash=${JSON.stringify(route)}; return true;`);
    const reopened = await until(
      (value) => value.canonical && !value.paused && Boolean(value.recipe),
      'The reopened review must acquire its own idle output panel',
    );
    assert.equal(reopened.recipeRunning, false);
    assert.equal(reopened.recipe.running, false);
    assert.equal(reopened.recipe.output, '');
    const finalRun = (await rpc('run.get', { runId: fixture.runId })).run;
    assert.equal(finalRun.status, 'done');
    assert.equal(finalRun.decisions[0].resolvedAt, undefined);
    const finalSlot = (await rpc('fleet.status')).fleet.slots.find(
      (entry) => entry.slot === fixture.slotId,
    );
    assert.equal(finalSlot.currentRunId, slot.currentRunId);
    assert.equal(finalSlot.phase, slot.phase);
    result = {
      result: 'PASS',
      action: phase,
      recipeRefusalVisible: true,
      recipeInterruptedOwnerRetired: true,
      recipeReopenedOwnerIdle: true,
      successfulStreamingProven: false,
      runId: fixture.runId,
    };
  } finally {
    if (seeded) {
      await withOwnedGatewayOffline(async () => {
        await writeFile(fixture.runFile, originalBytes);
        await chmod(fixture.runFile, originalMode);
        assert.deepEqual(await readFile(fixture.runFile), originalBytes);
        assert.equal((await stat(fixture.runFile)).mode & 0o777, originalMode);
      });
    }
    if (browser) {
      browser.base.hash = 'runs';
      await browser.cdp('goto', browser.base.href);
    }
  }
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (phase === 'review-workspace-web') {
  const decision = ({ createdAt }) => ({
    status: 'human-gating',
    completedAt: undefined,
    decisions: [
      {
        id: randomUUID(),
        // This legacy context renders a review but is refused by the refresh endpoint.
        // It cannot publish: there is no PR, worker, slot or posting waiter.
        type: 'engine_human_gate',
        title: 'Private review input proof',
        description: 'Owned slot-free legacy review context',
        createdAt,
        actions: [
          { id: 'post', label: 'Post', style: 'primary' },
          { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
        ],
        payload: {
          kind: 'review',
          prNumber: null,
          repo: null,
          recommendation: 'COMMENT',
          reviewMd: 'Private canonical review workspace proof',
          lineComments: [
            {
              path: 'private.txt',
              line: 1,
              side: 'RIGHT',
              body: 'Private comment selection',
              severity: 'minor',
            },
          ],
        },
      },
    ],
  });
  const result = await withRunFixture(decision, async ({ runId }) =>
    withRunFixture(decision, async ({ runId: otherRunId, observed }) => {
      const first = await detailBrowser(otherRunId);
      const probe = path.join(
        root,
        'apps/command-center/scripts/probes/offline-review-workspace.js',
      );
      const snapshot = (route) => first.cdp('eval', route, '--file', probe);
      const until = async (route, predicate, label) => {
        const deadline = Date.now() + 45000;
        let value;
        do {
          value = await snapshot(route);
          if (predicate(value)) return value;
          await delay(100);
        } while (Date.now() < deadline);
        assert.fail(`${label}: ${JSON.stringify(value)}`);
      };
      const current = (value) =>
        value.mounted && value.canonical && value.run.status === 'ready' && !value.paused;
      const otherInitial = await until(
        first.route,
        current,
        'Cache the second actual review before the interrupted command',
      );
      const browser = await detailBrowser(runId);
      const { cdp, route, base, artifacts } = browser;
      const selector = (id) => `run-detail >>> review-workspace [data-testid="${id}"]`;
      const initial = await until(
        route,
        current,
        'The actual review must render its canonical full-run decision',
      );
      assert(initial.reportRendered);
      assert.deepEqual(initial.included, [0]);
      const confirmationButton = initial.buttons.find(
        (button) => ['review-post', 'review-dismiss'].includes(button.id) && !button.disabled,
      )?.id;
      assert(confirmationButton, 'The canonical decision must offer a confirmation action');
      const confirmationAction = confirmationButton.slice('review-'.length);
      await writeFile(
        path.join(artifacts, 'review-curation-before.json'),
        JSON.stringify(initial, null, 2),
      );
      await cdp('screenshot', route, path.join(artifacts, 'review-curation-before.png'));
      await cdp('click', route, 'run-detail >>> review-workspace .rw-ci input:not(:disabled)');
      await writeFile(
        path.join(artifacts, 'review-curation-after.json'),
        JSON.stringify(await snapshot(route), null, 2),
      );
      await until(
        route,
        (value) => current(value) && value.included.length === 0,
        'Actual comment curation must update',
      );
      const armed = await cdp(
        'click',
        route,
        selector(confirmationButton),
        '--observe-file',
        probe,
      );
      assert.equal(
        armed.observation.pendingConfirm,
        confirmationAction,
        'Arm the actual review decision confirmation',
      );
      const confirmationStarted = armed.clickedAt;
      const tag = `review-context-${randomUUID().slice(0, 8)}`;
      await observed.read('run.tags.set', { runId, tags: [tag] });
      const updated = await until(
        route,
        (value) => current(value) && value.tags?.includes(tag),
        'An external run update must reach the shared review',
      );
      const confirmationElapsedMs = Date.now() - confirmationStarted;
      assert(
        confirmationElapsedMs < 2500,
        'Observe invalidation before the normal three-second confirmation timeout',
      );
      assert.equal(
        updated.pendingConfirm,
        null,
        'Invalidation must retire the old review decision confirmation',
      );
      assert.deepEqual(
        updated.included,
        [],
        'Unrelated run metadata must preserve reviewer curation',
      );
      await cdp('click', route, selector(confirmationButton));
      await until(
        route,
        (value) => value.pendingConfirm === confirmationAction && !value.busy,
        'The next tap must request a new confirmation rather than post',
      );
      assert.equal((await rpc('run.get', { runId })).run.decisions[0].resolvedAt, undefined);
      await cdp('click', route, selector('review-refresh'));
      const refused = await until(
        route,
        (value) => value.errorRendered && !value.busy,
        'The real refresh refusal must remain visible',
      );
      assert.match(refused.actionError, /No pending review_posting decision/);
      await cdp(
        'click',
        route,
        'run-detail >>> review-workspace [data-testid="review-action-error"]',
      );
      assert((await snapshot(route)).errorVisible);
      await cdp('screenshot', route, path.join(artifacts, 'review-current-refusal.png'));
      const storedProbe = path.join(
        root,
        'apps/command-center/scripts/probes/offline-run-detail-store.js',
      );
      const otherRoute = `run/${otherRunId}`;
      base.hash = otherRoute;
      await cdp('goto', base.href);
      await until(otherRoute, current, 'Verify the second review before its offline render');
      let stored;
      const storeDeadline = Date.now() + 15000;
      do {
        stored = await cdp('eval', otherRoute, '--file', storedProbe);
        if (stored.storedObservedAt === (await snapshot(otherRoute)).run.observedAt) break;
        await delay(100);
      } while (Date.now() < storeDeadline);
      assert(stored.storedObservedAt, 'The second review must be written to actual SQLite');
      base.hash = route;
      await cdp('goto', base.href);
      await until(route, current, 'Reopen the first review for the interrupted command');
      let cold;
      await withOwnedGatewayOffline(
        async () => {
          const disconnected = await until(
            otherRoute,
            (value) =>
              value.mounted && value.run.status === 'stale' && value.paused && value.reportRendered,
            'The second actual review must remain readable after disconnect',
          );
          assert.equal(
            disconnected.actionError,
            '',
            'A former view command must not report into the mounted successor',
          );
          assert.equal(disconnected.busy, false);
          base.searchParams.set('review-cold', randomUUID());
          await cdp('goto', base.href);
          cold = await until(
            otherRoute,
            (value) =>
              value.mounted &&
              value.run.status === 'stale' &&
              value.paused &&
              value.reportRendered &&
              value.reportReadable &&
              value.saved,
            'A cold offline review must show saved facts with age',
          );
          assert.equal(cold.run.observedAt, stored.storedObservedAt);
          assert(cold.buttons.length && cold.buttons.every((button) => button.disabled));
          assert.equal(
            cold.actionError,
            '',
            'A former view command cannot write its failure into the current review',
          );
          await cdp(
            'click',
            otherRoute,
            'run-detail >>> review-workspace:has([data-testid="review-dismiss"]) [data-testid="review-run-age"]',
          );
          assert((await snapshot(otherRoute)).savedVisible);
          await cdp(
            'click',
            otherRoute,
            'run-detail >>> review-workspace:has([data-testid="review-dismiss"]) .rw-md-section',
          );
          assert(
            (await snapshot(otherRoute)).reportVisible,
            'The saved review report must remain legible in the viewport',
          );
          await cdp('screenshot', otherRoute, path.join(artifacts, 'review-cold-offline.png'));
        },
        {
          beforeStop: async () => {
            await cdp('click', route, selector('review-refresh'));
            await until(
              route,
              (value) => value.busy,
              'Keep the first actual refresh request pending',
            );
            base.hash = otherRoute;
            await cdp('eval', route, `location.hash=${JSON.stringify(otherRoute)}; return true;`);
            await until(
              otherRoute,
              (value) => value.mounted && value.runId === otherRunId,
              'Navigate to the other cached review before the former command fails',
            );
          },
        },
      );
      const recovered = await until(
        otherRoute,
        current,
        'Reconnect must refresh the current review without replay',
      );
      assert.equal(recovered.actionError, '');
      assert.equal(recovered.busy, false);
      for (const id of [runId, otherRunId])
        assert.equal(
          (await rpc('run.get', { runId: id })).run.decisions[0].resolvedAt,
          undefined,
          'No confirmation or interrupted command may resolve either fixture',
        );
      return {
        result: 'PASS',
        action: phase,
        reviewWorkspaceCanonical: true,
        reviewConfirmationRetired: true,
        reviewConfirmationAction: confirmationAction,
        reviewCommandErrorVisible: true,
        reviewOwnerReplyFenced: true,
        reviewColdOffline: true,
        reviewDecisionsUnresolved: true,
        runId,
        otherRunId,
        observedAt: cold.run.observedAt,
        previousObservedAt: otherInitial.run.observedAt,
        confirmationElapsedMs,
        successfulPublicationProven: false,
        gitContentProven: false,
      };
    }),
  );
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (phase === 'ready-workspace-web') {
  const decisionId = randomUUID();
  const result = await withRunFixture(
    ({ createdAt }) => ({
      status: 'human-gating',
      completedAt: undefined,
      decisions: [
        {
          id: decisionId,
          type: 'engine_human_gate',
          title: 'Private workspace proof',
          description: 'Owned slot-free gate',
          createdAt,
          actions: [{ id: 'request-extra-review', label: 'Request previous review' }],
          payload: {
            kind: 'ready',
            prNumber: null,
            repo: null,
            branch: 'private-proof',
            diffStat: { filesChanged: 0, insertions: 0, deletions: 0 },
            workerReport: 'Private offline workspace proof',
          },
        },
      ],
    }),
    async ({ runId }) => {
      const { cdp, base, route, artifacts } = await detailBrowser(runId);
      const probe = path.join(
        root,
        'apps/command-center/scripts/probes/offline-ready-workspace.js',
      );
      const snapshot = () => cdp('eval', route, '--file', probe);
      const until = async (predicate, label) => {
        const deadline = Date.now() + 45000;
        let value;
        do {
          value = await snapshot();
          if (predicate(value)) return value;
          await delay(100);
        } while (Date.now() < deadline);
        assert.fail(`${label}: ${JSON.stringify(value)}`);
      };
      const current = (value) =>
        value.mounted &&
        value.run.status === 'ready' &&
        value.evidence.status === 'ready' &&
        value.runCanonical &&
        value.gateCanonical &&
        !value.paused;
      const initial = await until(
        current,
        'The actual gate must observe the full run and frozen evidence',
      );
      assert(initial.renderedReport);
      assert.deepEqual(initial.evidence.query.params, {
        runId,
        decisionId,
        includeRecordedEvidence: true,
      });
      const tag = `workspace-${randomUUID().slice(0, 8)}`;
      await rpc('run.tags.set', { runId, tags: [tag] });
      const updated = await until(
        (value) => current(value) && value.tags?.includes(tag) && value.renderedTags?.includes(tag),
        'An external write must update the rendered canonical workspace run',
      );
      await cdp('click', route, 'run-detail >>> ready-workspace .gate-more-actions > summary');
      await cdp('screenshot', route, path.join(artifacts, 'workspace-before-submit.png'));
      await cdp(
        'click',
        route,
        'run-detail >>> ready-workspace [data-action="request-extra-review"]',
      );
      await writeFile(
        path.join(artifacts, 'workspace-after-click.json'),
        JSON.stringify(await snapshot(), null, 2),
      );
      const refused = await until(
        (value) => value.actionTone === 'error' && value.renderedMessage && !value.busy,
        'The real gateway refusal of a removed legacy action must remain visible',
      );
      assert.match(refused.actionMessage, /This review action was removed/);
      assert.equal(
        (await rpc('run.get', { runId })).run.decisions.find((d) => d.id === decisionId).resolvedAt,
        undefined,
      );
      await cdp('click', route, 'run-detail >>> ready-workspace .rdy-action-feedback');
      assert(
        (await snapshot()).feedbackVisible,
        'The gateway refusal must be visible in the viewport',
      );
      await cdp('screenshot', route, path.join(artifacts, 'workspace-current-refusal.png'));
      const beforeOffline = await until(current, 'The workspace must finish its outcome read');
      const storeProbe = path.join(
        root,
        'apps/command-center/scripts/probes/offline-ready-workspace-store.js',
      );
      let stored;
      const deadline = Date.now() + 15000;
      do {
        stored = await cdp('eval', route, '--file', storeProbe);
        if (stored.storedObservedAt === beforeOffline.run.observedAt) break;
        await delay(100);
      } while (Date.now() < deadline);
      assert.equal(stored.storedObservedAt, beforeOffline.run.observedAt);
      let cold;
      await withOwnedGatewayOffline(async () => {
        const stale = await until(
          (value) =>
            value.run?.status === 'stale' &&
            value.paused &&
            value.renderedReport &&
            value.commands.length &&
            value.commands.every((button) => button.disabled),
          'Saved gate actions must be disabled during an actual outage',
        );
        await cdp('key', route, 'Enter');
        assert.equal((await snapshot()).busy, false);
        const repaint = await until(
          (value) => value.saved && value.saved !== stale.saved,
          'The saved gate age must repaint',
        );
        base.searchParams.set('workspace-cold', randomUUID());
        await cdp('goto', base.href);
        cold = await until(
          (value) =>
            value.run?.status === 'stale' &&
            value.paused &&
            value.renderedReport &&
            value.saved &&
            value.commands.every((button) => button.disabled),
          'A cold offline document must render the saved gate without granting action authority',
        );
        assert.equal(cold.run.observedAt, stale.run.observedAt);
        assert(repaint.saved);
        await cdp('click', route, 'run-detail >>> ready-workspace .rdy-saved-state');
        assert(
          (await snapshot()).savedVisible,
          'The saved gate age must be visible in the viewport',
        );
        await cdp('screenshot', route, path.join(artifacts, 'workspace-cold-offline.png'));
      });
      const recovered = await until(
        current,
        'Reconnect must reread the frozen evidence before enabling actions',
      );
      assert.equal(recovered.actionMessage, '');
      assert.equal(
        (await rpc('run.get', { runId })).run.decisions.find((d) => d.id === decisionId).resolvedAt,
        undefined,
      );
      return {
        result: 'PASS',
        action: phase,
        runId,
        decisionId,
        workspaceSharedQueries: true,
        externalWorkspaceUpdate: true,
        refusal: refused.actionMessage,
        coldWorkspaceGate: true,
        coldObservedAt: cold.run.observedAt,
        noCommandReplay: true,
        screenshots: artifacts,
        updatedAt: updated.run.observedAt,
      };
    },
  );
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (phase === 'detail-web') {
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE);
  const fixture = JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
  assert.equal(fixture.home, home);
  const original = (await rpc('run.get', { runId: fixture.runId })).run;
  assert.equal(original.readOnly, false);
  assert.equal(original.taskFile, fixture.taskFile);
  const tag = `offline-detail-${randomUUID().slice(0, 20)}`;
  const browser = await detailBrowser(fixture.runId);
  const { until, cdp, route, artifacts } = browser;
  let cold, age;
  try {
    const initial = await until(
      (value) =>
        value.freshness === 'ready' &&
        value.fullObservationRendered &&
        value.recipeFreshness === 'ready',
      'The full run and recipe observations must finish their current reads',
    );
    assert.equal(initial.storage, 'opfs-sahpool');
    assert(initial.titleRendered && !initial.commandsDisabled);
    await rpc('run.tags.set', { runId: fixture.runId, tags: [...(original.tags ?? []), tag] });
    await until(
      (value) =>
        value.freshness === 'ready' &&
        value.fullObservationRendered &&
        value.renderedTags.includes(tag),
      'An external writer must update the open full run without Refresh',
    );
    const { stdout } = await execute(
      process.execPath,
      [path.join(root, 'apps/command-center/scripts/prove-offline-runs.mjs'), 'mirror-arrival'],
      { timeout: 180000, maxBuffer: 1024 * 1024 },
    );
    const mirror = JSON.parse(stdout);
    assert.equal(mirror.result, 'PASS');
    await until(
      (value) =>
        value.freshness === 'ready' &&
        value.recipeFreshness === 'ready' &&
        value.artifactPaths.includes(mirror.artifact) &&
        value.recipeArtifactPaths.includes(mirror.artifact),
      'Actual mirror arrival must update both open detail and recipe groups',
    );
    await cdp('screenshot', route, path.join(artifacts, 'detail-live-arrival.png'));
    const saved = await until(
      (value) => value.freshness === 'ready' && value.fullObservationRendered,
      'The detail must be saved before disconnect',
    );
    await withOwnedGatewayOffline(async () => {
      const stale = await until(
        (value) =>
          value.freshness === 'stale' && value.fullObservationRendered && value.commandsDisabled,
        'A saved full run must disable its actual command controls',
      );
      age = await until(
        (value) => value.stale && value.stale !== stale.stale,
        'The saved full-run age must repaint without a read',
      );
      browser.base.searchParams.set('cold-detail', randomUUID());
      await browser.navigate();
      cold = await until(
        (value) =>
          value.freshness === 'stale' &&
          value.fullObservationRendered &&
          value.commandsDisabled &&
          value.titleRendered &&
          value.renderedTags.includes(tag) &&
          value.artifactPaths.includes(mirror.artifact),
        'A new offline document must restore the full run rather than a compact list row',
      );
      assert(stale.observedAt >= saved.observedAt);
      assert.equal(cold.observedAt, stale.observedAt);
      await cdp('screenshot', route, path.join(artifacts, 'detail-cold-offline.png'));
    });
    await until(
      (value) =>
        value.freshness === 'ready' && value.fullObservationRendered && !value.commandsDisabled,
      'Run commands must wait for a current reconnect read',
    );
    await rpc('run.tags.set', { runId: fixture.runId, tags: original.tags ?? [] });
    await until(
      (value) => value.freshness === 'ready' && !value.renderedTags.includes(tag),
      'The restored tag set must reach the open detail',
    );
    console.log(
      JSON.stringify({
        result: 'PASS',
        action: phase,
        fullDetailNotifications: true,
        actualMirrorObservedInDetailAndRecipes: true,
        coldFullDetailRestored: true,
        fullDetailCommandsGated: true,
        coldObservedAt: cold.observedAt,
        staleAge: age.stale,
        screenshots: artifacts,
      }),
    );
  } finally {
    const current = (await rpc('run.get', { runId: fixture.runId })).run;
    if (current.tags?.includes(tag))
      await rpc('run.tags.set', { runId: fixture.runId, tags: original.tags ?? [] });
  }
  process.exit(0);
}

if (phase === 'detail-deletion-web') {
  const result = await withRunFixture(
    () => ({}),
    async ({ runId, runFile }) => {
      const browser = await detailBrowser(runId);
      const { until, cdp, route, artifacts } = browser;
      await until(
        (value) => value.freshness === 'ready' && value.fullObservationRendered,
        'The disposable detail must be current',
      );
      const saved = await browser.peek();
      assert(
        saved.persistent && saved.storedObservedAt !== undefined,
        'The actual SQLite detail row must exist before archive',
      );
      await rpc('run.archive', { runId });
      await until(
        (value) =>
          value.error?.code === 'RUN_NOT_FOUND' && !value.visibleRun && value.missingRendered,
        'An authorized not-found must remove the displayed full detail',
      );
      const deadline = Date.now() + 15000;
      let removed;
      do {
        removed = await browser.peek();
        if (removed.storedObservedAt === undefined) break;
        await delay(100);
      } while (Date.now() < deadline);
      assert.equal(
        removed.storedObservedAt,
        undefined,
        'The authorized not-found must evict the actual SQLite row',
      );
      await assert.rejects(access(runFile), { code: 'ENOENT' });
      await cdp('screenshot', route, path.join(artifacts, 'detail-archived.png'));
      await withOwnedGatewayOffline(async () => {
        browser.base.searchParams.set('cold-deleted', randomUUID());
        await browser.navigate();
        await until(
          (value) => value.mounted && !value.visibleRun && !value.fullObservationRendered,
          'The removed detail must not return in a new offline document',
        );
        const absent = await browser.peek();
        assert.equal(absent.storedObservedAt, undefined);
        await cdp('screenshot', route, path.join(artifacts, 'detail-deleted-cold-offline.png'));
      });
      return {
        result: 'PASS',
        action: phase,
        deletedDetailEvicted: true,
        actualSqliteRowRemoved: true,
        screenshots: artifacts,
      };
    },
  );
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (phase === 'family-web') {
  const artifacts = process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR;
  assert(artifacts);
  await mkdir(artifacts, { recursive: true });
  const cdpPath = path.join(root, 'apps/command-center/scripts/cdp.mjs');
  const probePath = path.join(root, 'apps/command-center/scripts/probes/offline-family.js');
  const cdp = async (...args) => {
    const { stdout } = await execute(process.execPath, [cdpPath, ...args], { timeout: 60000 });
    return JSON.parse(stdout);
  };
  const until = async (ready, label) => {
    const deadline = Date.now() + 45000;
    let value;
    do {
      value = await cdp('eval', 'family/', '--file', probePath);
      if (ready(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  };
  const result = await withRunFixture(
    () => ({ status: 'monitoring', completedAt: undefined, ticketOrPr: 'Offline family root' }),
    async (first) =>
      withRunFixture(
        () => ({ familyId: first.runId, ticketOrPr: 'Offline family sibling' }),
        async (second) => {
          const base = new URL(
            process.env.FARMSLOT_UI_URL ?? `http://localhost:${process.env.VITE_PORT}`,
          );
          base.searchParams.set('family-proof', randomUUID());
          base.hash = `family/${first.runId}`;
          await cdp('goto', base.href);
          await cdp('focus', 'family/');
          await until(
            (value) =>
              value.snapshotCanonical &&
              value.familyFreshness === 'ready' &&
              value.detailFreshness === 'ready' &&
              value.workflowState === 'active' &&
              value.runIds.includes(second.runId),
            'The real family page must observe the family and selected full run',
          );
          // Both fixtures have no slot, task, workspace, worker or session to stop.
          const cancelled = await rpc('run.cancel', { runId: first.runId });
          assert.equal(cancelled.run.status, 'cancelled');
          await until(
            (value) =>
              value.snapshotCanonical &&
              value.familyFreshness === 'ready' &&
              value.workflowState === 'complete' &&
              value.workflowRendered,
            'A second-client cancellation must update the visible family without Refresh',
          );
          await cdp('screenshot', 'family/', path.join(artifacts, 'family-current.png'));
          await withOwnedGatewayOffline(async () => {
            const stale = await until(
              (value) =>
                value.familyFreshness === 'stale' &&
                value.detailFreshness === 'stale' &&
                value.reportDisabled &&
                value.saved.length >= 2 &&
                value.storedObservedAt === value.observedAt,
              'Saved family observations must disable report generation and show their age',
            );
            assert(stale.selectionInRoute, 'A plain family route must remember its selected run');
            base.hash = stale.hash;
            base.searchParams.set('offline-cold', randomUUID());
            await cdp('goto', base.href);
            const cold = await until(
              (value) =>
                value.detailFreshness === 'stale' &&
                value.fullRunId === stale.selectedRunId &&
                value.savedRunLink === 'Open saved run',
              'A cold family route must offer its actual persisted selected run without a fabricated family summary',
            );
            assert.equal(cold.observedAt, stale.observedAt);
            assert.equal(cold.storage, 'opfs-sahpool');
            await cdp('screenshot', 'family/', path.join(artifacts, 'family-cold.png'));
            await cdp(
              'click',
              'family/',
              `family-observability >>> a[href="#run/${stale.selectedRunId}"]`,
            );
            const deadline = Date.now() + 30000;
            let opened;
            do {
              opened = await cdp(
                'eval',
                `run/${stale.selectedRunId}`,
                '--file',
                path.join(root, 'apps/command-center/scripts/probes/offline-run-detail.js'),
              );
              if (
                opened.fullObservationRendered &&
                opened.visibleRun === stale.selectedRunId &&
                opened.freshness === 'stale'
              )
                break;
              await delay(100);
            } while (Date.now() < deadline);
            assert(
              opened.fullObservationRendered &&
                opened.visibleRun === stale.selectedRunId &&
                opened.freshness === 'stale',
              'Open saved run must render the selected persisted full detail offline',
            );
            await cdp(
              'screenshot',
              `run/${stale.selectedRunId}`,
              path.join(artifacts, 'family-opened-run.png'),
            );
            await cdp('goto', base.href);
            await until(
              (value) =>
                value.detailFreshness === 'stale' && value.savedRunLink === 'Open saved run',
              'Returning to the saved family route must retain the same offline selection',
            );
          });
          await until(
            (value) =>
              value.familyFreshness === 'ready' &&
              value.detailFreshness === 'ready' &&
              value.snapshotCanonical &&
              value.workflowState === 'complete',
            'Current family and selected-run observations must return after reconnect',
          );
          return { result: 'PASS', action: phase, sharedFamily: true, coldFamilySelection: true };
        },
      ),
  );
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (phase === 'compare-web') {
  const cdpPath = path.join(root, 'apps/command-center/scripts/cdp.mjs');
  const probePath = path.join(root, 'apps/command-center/scripts/probes/offline-run-compare.js');
  const artifacts = process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR;
  assert(artifacts, 'Select the comparison capture directory');
  await mkdir(artifacts, { recursive: true });
  const cdp = async (...args) => {
    const { stdout } = await execute(process.execPath, [cdpPath, ...args], { timeout: 60000 });
    return JSON.parse(stdout);
  };
  const until = async (ready, label) => {
    const deadline = Date.now() + 45000;
    let value;
    do {
      value = await cdp('eval', 'runs/compare', '--file', probePath);
      if (ready(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  };
  const result = await withRunFixture(
    () => ({ ticketOrPr: 'Offline comparison A' }),
    async (first) =>
      withRunFixture(
        () => ({ familyId: first.runId, ticketOrPr: 'Offline comparison B' }),
        async (second) => {
          const base = new URL(
            process.env.FARMSLOT_UI_URL ?? `http://localhost:${process.env.VITE_PORT}`,
          );
          base.searchParams.set('compare-proof', randomUUID());
          base.hash = `runs/compare?a=${first.runId}&b=${second.runId}`;
          await cdp('goto', base.href);
          await cdp('focus', 'runs/compare');
          const ready = await until(
            (value) =>
              value.fullRunsCanonical &&
              value.titlesRendered &&
              value.freshness.every((state) => state === 'ready') &&
              value.familyFreshness === 'ready' &&
              value.familyRunIds.includes(second.runId),
            'The comparison must observe both full runs and their family snapshot',
          );
          assert.equal(ready.storage, 'opfs-sahpool');
          const tag = `compare-${randomUUID().slice(0, 12)}`;
          await rpc('run.tags.set', { runId: first.runId, tags: [tag] });
          await until(
            (value) =>
              value.freshness.every((state) => state === 'ready') && value.tags[0].includes(tag),
            'The open full comparison must follow an external run writer without Refresh',
          );
          await cdp('screenshot', 'runs/compare', path.join(artifacts, 'comparison-current.png'));
          await withOwnedGatewayOffline(async () => {
            const stale = await until(
              (value) =>
                value.freshness.every((state) => state === 'stale') && value.saved.length === 2,
              'Both saved comparison runs must become visibly stale',
            );
            base.searchParams.set('offline-cold', randomUUID());
            await cdp('goto', base.href);
            const cold = await until(
              (value) =>
                value.fullRunsCanonical &&
                value.titlesRendered &&
                value.freshness.every((state) => state === 'stale') &&
                value.saved.length === 2,
              'A new offline document must render both saved full runs and their age',
            );
            assert.deepEqual(cold.observedAt, stale.observedAt);
            assert(cold.tags[0].includes(tag));
            await cdp('screenshot', 'runs/compare', path.join(artifacts, 'comparison-cold.png'));
          });
          await until(
            (value) =>
              value.freshness.every((state) => state === 'ready') &&
              value.familyFreshness === 'ready',
            'Reconnect must refresh comparison and family observations',
          );
          return {
            result: 'PASS',
            action: phase,
            sharedComparison: true,
            coldComparison: true,
            runIds: [first.runId, second.runId],
          };
        },
      ),
  );
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (phase === 'load-modal-web') {
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE);
  const fixture = JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
  assert.equal(fixture.home, home);
  const slotId = fixture.slotId;
  assert(/^[a-z0-9-]+$/i.test(slotId));
  const poolFile = path.join(home, 'pool', `${slotId}.json`);
  const pool = JSON.parse(await readFile(poolFile, 'utf8'));
  const configured = pool.slots.find((slot) => slot.id === slotId);
  assert.equal(
    configured?.enabled,
    false,
    'Use only the owned disabled slot for the prepare refusal',
  );
  assert((await realpath(configured.repo)).startsWith(`${home}/`));
  const workspace = await rpc('git.status', { slotId });
  assert.equal(
    typeof workspace.branch,
    'string',
    'The slot fixture must be a readable Git workspace',
  );
  const artifacts =
    process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR ?? path.join(home, 'load-modal-proof', randomUUID());
  await mkdir(artifacts, { recursive: true });
  const cdp = async (...args) => {
    const { stdout } = await execute(
      process.execPath,
      [path.join(root, 'apps/command-center/scripts/cdp.mjs'), ...args],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout);
  };
  const probe = path.join(root, 'apps/command-center/scripts/probes/offline-load-run.js');
  const storeProbe = path.join(
    root,
    'apps/command-center/scripts/probes/offline-load-run-store.js',
  );
  const route = `slot/${slotId}`;
  const snapshot = () => cdp('eval', route, '--file', probe);
  const until = async (ready, label) => {
    const deadline = Date.now() + 45000;
    let value;
    do {
      value = await snapshot();
      if (ready(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  };
  const result = await withRunFixture(
    ({ runId }) => ({
      status: 'blocked',
      completedAt: undefined,
      branch: `offline-load-${runId}`,
      ticketOrPr: `Offline load-run proof ${runId.slice(0, 8)}`,
    }),
    async ({ runId, runFile }) => {
      const pages = (await cdp('tabs')).filter((tab) => tab.type === 'page');
      const ui = new URL(
        process.env.FARMSLOT_UI_URL ?? `http://localhost:${process.env.VITE_PORT}`,
      );
      assert(['localhost', '127.0.0.1', '[::1]'].includes(ui.hostname));
      const app = pages.find((tab) => tab.url.startsWith(`${ui.origin}/`));
      assert(app, 'Use the existing private browser document');
      const url = new URL(app.url);
      url.hash = route;
      await cdp('goto', url.href);
      await cdp('focus', route);
      const button = `slot-view slot-load-run-modal >>> [data-run-id="${runId}"] .slrm-load`;
      await cdp(
        'click',
        route,
        'slot-view button[title="Browse all runs and warm-switch this slot onto one"]',
      );
      await until(
        (value) =>
          value.open &&
          !value.contextBlocked &&
          value.status === 'ready' &&
          value.rowsMatchCanonical &&
          value.rows?.some((row) => row.id === runId && row.visible && !row.disabled),
        'The real load dialog must render the canonical current project list',
      );
      await cdp(
        'fill',
        route,
        'slot-view slot-load-run-modal >>> .slrm-input',
        `Offline load-run proof ${runId.slice(0, 8)}`,
      );
      const initial = await until(
        (value) => value.rows.length === 1 && value.rows[0].id === runId && value.rows[0].visible,
        'The user search must isolate the owned run',
      );
      assert.equal(initial.project, 'farmslot-farm');
      assert.deepEqual(initial.query.params, { limit: 200, project: 'farmslot-farm' });
      assert.equal(initial.storage, 'opfs-sahpool');
      const confirmationAt = Date.now();
      await cdp('click', route, button);
      await until(
        (value) => value.pendingConfirm === runId && !value.busy,
        'The first explicit click must only arm confirmation',
      );
      await rpc('run.cancel', { runId });
      const changed = await until(
        (value) =>
          value.status === 'ready' &&
          value.rowsMatchCanonical &&
          value.rows[0]?.text.includes('cancelled'),
        'An external writer must update the visible dialog and retire its old confirmation',
      );
      const confirmationClearedMs = Date.now() - confirmationAt;
      assert(
        confirmationClearedMs < 2500,
        'Observe invalidation before the independent confirmation timeout',
      );
      assert.equal(
        changed.pendingConfirm,
        '',
        'A changed observation must immediately retire the armed confirmation',
      );
      await cdp('screenshot', route, path.join(artifacts, 'load-dialog-current.png'));
      await cdp('click', route, button);
      await until(
        (value) => value.pendingConfirm === runId,
        'The current updated row must be explicitly selected again',
      );
      const before = await snapshot();
      let savedAt;
      await withOwnedGatewayOffline(async () => {
        const stale = await until(
          (value) =>
            value.status === 'stale' &&
            value.rowsMatchCanonical &&
            value.rows[0]?.visible &&
            value.rows[0].disabled &&
            value.pendingConfirm === '',
          'Saved dialog rows must remain visible, disable loading and retire confirmation after disconnect',
        );
        savedAt = stale.observedAt;
        assert(savedAt >= before.observedAt);
        await until(
          (value) => value.stale && value.stale !== stale.stale,
          'The dialog saved age must repaint without a network read',
        );
        const deadline = Date.now() + 15000;
        let stored;
        do {
          stored = await cdp('eval', route, '--file', storeProbe);
          if (stored.persistent && stored.storedObservedAt === savedAt) break;
          await delay(50);
        } while (Date.now() < deadline);
        assert.equal(
          stored.storedObservedAt,
          savedAt,
          'The accepted dialog observation must reach the actual SQLite row',
        );
        await cdp('screenshot', route, path.join(artifacts, 'load-dialog-stale.png'));
        assert.equal(JSON.parse(await readFile(runFile, 'utf8')).slotId, null);
      });
      const current = await until(
        (value) =>
          value.status === 'ready' &&
          !value.contextBlocked &&
          value.rowsMatchCanonical &&
          value.rows[0]?.visible &&
          !value.rows[0].disabled &&
          !value.pendingConfirm &&
          !value.busy,
        'Reconnect must refetch the dialog without replaying its selection',
      );
      assert.equal(
        current.prepare?.requestId,
        initial.prepare?.requestId,
        'A reconnect must not start a prepare',
      );
      const latestPool = JSON.parse(await readFile(poolFile, 'utf8'));
      assert.equal(latestPool.slots.find((slot) => slot.id === slotId)?.enabled, false);
      await cdp('click', route, button);
      await until(
        (value) => value.pendingConfirm === runId,
        'Loading after reconnect needs a new first click',
      );
      await cdp('click', route, button);
      const refused = await until(
        (value) => !value.busy && Boolean(value.actionError),
        'The real disabled-slot prepare refusal must be visible and release busy state',
      );
      assert.equal(JSON.parse(await readFile(runFile, 'utf8')).slotId, null);
      await cdp('screenshot', route, path.join(artifacts, 'load-dialog-refused.png'));
      await cdp('click', route, 'slot-view slot-load-run-modal >>> .slrm-close');
      await until(
        (value) => !value.open && !value.query,
        'Closing the dialog must release its query observer',
      );
      return {
        result: 'PASS',
        action: phase,
        dialogNotification: true,
        canonicalProjectQuery: true,
        staleDialogActionsDisabled: true,
        confirmationNotReplayed: true,
        confirmationClearedMs,
        sqliteObservedAt: savedAt,
        physicalPrepareRefusal: refused.actionError,
        dialogCommandRefusalVisible: true,
        screenshots: artifacts,
        coldSlotContextPendingFleetPersistence: true,
      };
    },
  );
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (phase === 'history-web') {
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE);
  const fixture = JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
  assert.equal(fixture.home, home);
  const { slotId, runId } = fixture;
  const pool = JSON.parse(await readFile(path.join(home, 'pool', `${slotId}.json`), 'utf8'));
  const configured = pool.slots.find((slot) => slot.id === slotId);
  assert.equal(configured?.enabled, false);
  assert((await realpath(configured.repo)).startsWith(`${home}/`));
  assert.equal(fixture.runFile, path.join(home, 'runs', `${runId}.json`));
  const runBytes = await readFile(fixture.runFile, 'utf8');
  const run = JSON.parse(runBytes);
  assert.equal(run.readOnly, false, 'Never change imported reference runs');
  assert.equal(run.slotId, slotId);
  assert.equal(run.status, 'done');
  const statusFile = path.join(root, '.farm-status.json');
  const originalStatus = await readFile(statusFile, 'utf8');
  const originalSlot = JSON.parse(originalStatus).slots.find((slot) => slot.slot === slotId);
  assert(originalSlot && !originalSlot.current_run_id, 'Use the idle owned fixture binding');
  const commitStatus = async (content) => {
    const temporary = `${statusFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, statusFile);
  };
  const bind = async (owner, remove = false) => {
    const status = JSON.parse(await readFile(statusFile, 'utf8'));
    const row = status.slots.find((slot) => slot.slot === slotId);
    assert(row && [null, undefined, runId].includes(row.current_run_id));
    if (remove) status.slots = status.slots.filter((slot) => slot.slot !== slotId);
    else row.current_run_id = owner;
    await commitStatus(JSON.stringify(status));
  };
  const artifacts =
    process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR ?? path.join(home, 'history-proof', randomUUID());
  await mkdir(artifacts, { recursive: true });
  const cdp = async (...args) => {
    const { stdout } = await execute(
      process.execPath,
      [path.join(root, 'apps/command-center/scripts/cdp.mjs'), ...args],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout);
  };
  const route = `slot/${slotId}`;
  const snapshot = () =>
    cdp(
      'eval',
      route,
      '--file',
      path.join(root, 'apps/command-center/scripts/probes/offline-slot-history.js'),
    );
  const row = (value) => value.rows?.find((entry) => entry.id === runId);
  const until = async (ready, label) => {
    const deadline = Date.now() + 45000;
    let value;
    do {
      value = await snapshot();
      if (ready(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  };
  const base = new URL(process.env.FARMSLOT_UI_URL ?? `http://localhost:${process.env.VITE_PORT}`);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
  base.hash = route;
  const prepare = `slot-view slot-history-modal >>> [data-run-id="${runId}"] slot-prepare-popover`;
  let seeded;
  let observed;
  try {
    await withOwnedGatewayOffline(async () => {
      seeded = JSON.stringify({ ...run, branch: 'offline-history-proof' }, null, 2);
      await writeFile(fixture.runFile, seeded);
    });
    observed = await observeResources();
    await cdp('goto', base.href);
    await cdp('focus', route);
    await cdp('click', route, 'slot-view button[title="View recent retained runs for this slot"]');
    const initial = await until(
      (value) =>
        value.open && value.status === 'ready' && value.rowsMatchCanonical && row(value)?.visible,
      'The actual history dialog must render its shared current query',
    );
    assert.deepEqual(initial.query.params, { limit: 25, slotId });
    await cdp(
      'click',
      route,
      `slot-view slot-history-modal >>> [data-run-id="${runId}"] .shm-row-main`,
    );
    await until(
      (value) => row(value)?.prepareDisabled === false,
      'A current retained run must expose its real prepare control',
    );
    await cdp('click', route, `${prepare} >>> .spp-trigger`);
    await until((value) => row(value)?.confirming, 'The real prepare options must open');
    await bind(runId);
    const bound = await until(
      (value) => value.status === 'ready' && value.rowsMatchCanonical && row(value)?.current,
      'A pointer-only external commit must update the visible current marker',
    );
    assert.equal(row(bound).confirming, false, 'Invalidation must retire the armed prepare');
    assert.equal((await rpc('run.forSlot', { slotId })).run?.id, runId);
    assert(observed.changes.some(({ key }) => key.family === 'slot' && key.slotId === slotId));
    assert.equal(
      await readFile(fixture.runFile, 'utf8'),
      seeded,
      'Binding proof must not rewrite a run',
    );
    await cdp('screenshot', route, path.join(artifacts, 'history-current.png'));
    await bind(null);
    await until(
      (value) => value.status === 'ready' && row(value) && !row(value).current,
      'Clearing only the binding must remove the current marker',
    );
    assert.equal(
      (await rpc('run.forSlot', { slotId })).run?.id,
      runId,
      'The existing idle-slot fallback may still show its retained reviewable run',
    );
    await bind(null, true);
    await until(
      (value) =>
        value.status === 'ready' && value.slotExists === false && row(value)?.prepareDisabled,
      'Removed membership must disable history prepare without deleting retained rows',
    );
    await commitStatus(originalStatus);
    await until(
      (value) =>
        value.status === 'ready' &&
        !value.contextBlocked &&
        value.slotExists &&
        row(value)?.prepareDisabled === false,
      'Restoring membership must refresh current history without a run write',
    );
    try {
      await commitStatus('{corrupt');
      const failed = await until(
        (value) =>
          value.error &&
          value.rowsMatchCanonical &&
          row(value)?.visible &&
          row(value).prepareDisabled,
        'A failed current read must preserve visible history and expose its error',
      );
      assert(failed.stale, 'The preserved history must show its saved age after a read failure');
      await cdp('screenshot', route, path.join(artifacts, 'history-read-error.png'));
    } finally {
      await commitStatus(originalStatus);
    }
    await until(
      (value) =>
        value.status === 'ready' && !value.contextBlocked && row(value)?.prepareDisabled === false,
      'Readable recovery must replace the failure',
    );
    await cdp('click', route, `${prepare} >>> .spp-trigger`);
    await until(
      (value) => row(value)?.confirming,
      'The current row must need a new prepare selection',
    );
    observed.close();
    observed = undefined;
    await withOwnedGatewayOffline(async () => {
      const stale = await until(
        (value) =>
          value.status === 'stale' &&
          value.rowsMatchCanonical &&
          row(value)?.visible &&
          row(value).prepareDisabled &&
          !row(value).confirming,
        'Disconnect must preserve history, disable actions and clear prepare confirmation',
      );
      await until(
        (value) => value.stale && value.stale !== stale.stale,
        'The saved history age must repaint without reading',
      );
      await cdp('screenshot', route, path.join(artifacts, 'history-offline.png'));
      assert.equal(await readFile(fixture.runFile, 'utf8'), seeded);
    });
    await until(
      (value) =>
        value.status === 'ready' &&
        !value.contextBlocked &&
        row(value)?.prepareDisabled === false &&
        !row(value).confirming,
      'Reconnect must require a fresh prepare selection without command replay',
    );
    await cdp('click', route, `${prepare} >>> .spp-trigger`);
    await cdp('click', route, `${prepare} >>> .spp-btn.primary`);
    const refused = await until(
      (value) => row(value)?.actionError && !row(value).busy,
      'The physical prepare refusal must be visible and release busy state',
    );
    assert.equal(await readFile(fixture.runFile, 'utf8'), seeded);
    await cdp('screenshot', route, path.join(artifacts, 'history-prepare-refused.png'));
    await cdp('click', route, 'slot-view slot-history-modal >>> .shm-close');
    await until(
      (value) => !value.open && !value.query,
      'Closing history must release its shared observation',
    );
    console.log(
      JSON.stringify({
        result: 'PASS',
        action: phase,
        pointerOnlyHistoryUpdate: true,
        retainedMembershipUpdate: true,
        readFailurePreservesHistory: true,
        historySavedAge: true,
        historyConfirmationNotReplayed: true,
        historyPrepareRefusal: row(refused).actionError,
        sharedHistoryProof: true,
        screenshots: artifacts,
        coldHistoryNotPersisted: true,
      }),
    );
  } finally {
    observed?.close();
    try {
      await commitStatus(originalStatus);
      base.hash = 'runs';
      await cdp('goto', base.href);
    } finally {
      if (seeded)
        await withOwnedGatewayOffline(async () => {
          assert.equal(
            await readFile(fixture.runFile, 'utf8'),
            seeded,
            'Do not overwrite another fixture writer',
          );
          await writeFile(fixture.runFile, runBytes);
        });
    }
  }
  process.exit(0);
}

if (phase === 'slot-run-web') {
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE);
  const fixture = JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
  assert.equal(fixture.home, home);
  const { runId, slotId } = fixture;
  const original = (await rpc('run.get', { runId })).run;
  assert.equal(original.readOnly, false);
  assert.equal(original.taskFile, fixture.taskFile);
  assert.equal(original.slotId, slotId);
  for (const directory of [fixture.taskDir, fixture.workerTaskDir])
    assert((await realpath(directory)).startsWith(`${home}/`));
  const recipeFile = path.join(fixture.workerTaskDir, 'artifacts/recipe.json');
  let originalRecipe;
  try {
    originalRecipe = await readFile(recipeFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const statusFile = path.join(root, '.farm-status.json');
  const originalStatus = await readFile(statusFile, 'utf8');
  const statusCommit = async (content) => {
    const temporary = `${statusFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, statusFile);
  };
  const artifacts =
    process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR ?? path.join(home, 'slot-run-proof', randomUUID());
  await mkdir(artifacts, { recursive: true });
  const cdp = async (...args) => {
    const { stdout } = await execute(
      process.execPath,
      [path.join(root, 'apps/command-center/scripts/cdp.mjs'), ...args],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout);
  };
  const route = `slot/${slotId}`;
  const base = new URL(process.env.FARMSLOT_UI_URL ?? `http://localhost:${process.env.VITE_PORT}`);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
  base.searchParams.set('slot-run-proof', randomUUID());
  base.hash = `${route}?runId=${runId}`;
  const snapshot = () =>
    cdp(
      'eval',
      route,
      '--file',
      path.join(root, 'apps/command-center/scripts/probes/offline-slot-run.js'),
    );
  const until = async (ready, label) => {
    const deadline = Date.now() + 45000;
    let value;
    do {
      value = await snapshot();
      if (ready(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  };
  const tag = `offline-slot-${randomUUID().slice(0, 16)}`;
  let seeded = false;
  let cold;
  let savedAt;
  try {
    await cdp('goto', base.href);
    await cdp('focus', route);
    const initial = await until(
      (value) =>
        value.runId === runId &&
        value.runCanonical &&
        value.recipesCanonical &&
        value.runCurrent &&
        value.recipesCurrent &&
        !value.contextBlocked,
      'The real slot view must render its canonical full run and recipe observations',
    );
    assert(initial.titleRendered);
    assert.deepEqual(initial.reads.slot.query.params, { slotId });
    assert.deepEqual(initial.reads.pinned.query.params, { runId });
    assert.deepEqual(initial.reads.recipes.query.params, { runId });
    await writeFile(
      recipeFile,
      JSON.stringify({
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        title: 'Private slot store proof',
        workflow: { entry: 'done', nodes: { done: { action: 'end', status: 'pass' } } },
      }),
    );
    seeded = true;
    const sync = await rpc('run.refreshMirror', { runId });
    assert.equal(sync.ok, true, sync.reason);
    const arrived = await until(
      (value) =>
        value.runCanonical &&
        value.recipesCanonical &&
        value.recipesCurrent &&
        value.recipeGroups.some((group) => group.recipe) &&
        value.mirrorDisabled === false,
      'Actual recipe acquisition must update the visible slot inventory and sync action without a panel refresh',
    );
    await rpc('run.tags.set', { runId, tags: [...(original.tags ?? []), tag] });
    await until(
      (value) => value.runCanonical && value.runCurrent && value.tags?.includes(tag),
      'An external run writer must update the canonical run rendered by SlotView',
    );
    await cdp('screenshot', route, path.join(artifacts, 'slot-run-current.png'));
    await cdp('click', route, 'slot-view [data-testid="slot-recipe-refresh-mirror"]');
    await until(
      (value) => !value.mirrorBusy && /Synced|Up to date/.test(value.mirrorFeedback),
      'The current real artifact sync command must finish without an independent run reread',
    );
    try {
      await statusCommit('{unreadable');
      await until(
        (value) =>
          value.runCanonical &&
          value.titleRendered &&
          value.runError &&
          value.errorRendered &&
          value.actionsBlocked &&
          value.mirrorDisabled,
        'A slot binding read failure must retain rendered facts, show its error and disable commands',
      );
      await cdp('screenshot', route, path.join(artifacts, 'slot-run-read-error.png'));
    } finally {
      await statusCommit(originalStatus);
    }
    await until(
      (value) =>
        value.runCurrent && value.recipesCurrent && !value.contextBlocked && !value.mirrorDisabled,
      'Readable binding recovery must revalidate the shared observations',
    );
    await withOwnedGatewayOffline(async () => {
      const stale = await until(
        (value) =>
          value.reads.pinned.status === 'stale' &&
          value.runCanonical &&
          value.titleRendered &&
          value.actionsBlocked &&
          value.mirrorDisabled &&
          !value.mirrorBusy,
        'Disconnect must preserve the canonical slot run and disable artifact sync',
      );
      savedAt = stale.reads.pinned.observedAt;
      await until(
        (value) => value.freshness && value.freshness !== stale.freshness,
        'Saved slot-run age must repaint without rereading',
      );
      const deadline = Date.now() + 15000;
      let stored;
      do {
        stored = await cdp(
          'eval',
          route,
          '--file',
          path.join(root, 'apps/command-center/scripts/probes/offline-slot-run-store.js'),
        );
        if (stored.storedObservedAt === savedAt) break;
        await delay(50);
      } while (Date.now() < deadline);
      assert.equal(stored.storedObservedAt, savedAt);
      await cdp('screenshot', route, path.join(artifacts, 'slot-run-stale.png'));
      base.searchParams.set('cold-slot-run', randomUUID());
      await cdp('goto', base.href);
      await cdp('focus', route);
      cold = await until(
        (value) =>
          value.runId === runId &&
          value.runCanonical &&
          value.titleRendered &&
          value.reads.pinned.status === 'stale' &&
          value.actionsBlocked,
        'A cold offline slot route must render its actual saved full run with commands disabled',
      );
      assert.equal(cold.reads.pinned.observedAt, savedAt);
      await cdp('screenshot', route, path.join(artifacts, 'slot-run-cold.png'));
    });
    const current = await until(
      (value) =>
        value.runCurrent &&
        value.recipesCurrent &&
        value.runCanonical &&
        value.recipesCanonical &&
        !value.contextBlocked &&
        value.mirrorDisabled === false,
      'Reconnect must reread current run and inventory without replaying artifact sync',
    );
    assert.equal(current.mirrorFeedback, '');
    assert.equal(current.mirrorBusy, false);
    console.log(
      JSON.stringify({
        result: 'PASS',
        action: phase,
        slotRunObservations: true,
        actualRecipeMirrorArrival: arrived.recipeGroups.length,
        slotRunReadFailure: true,
        coldSlotFullRun: true,
        sqliteObservedAt: savedAt,
        commandsNotReplayed: true,
        screenshots: artifacts,
        coldFleetAndInventoryPersistenceNotClaimed: true,
      }),
    );
  } finally {
    await statusCommit(originalStatus);
    if (seeded) {
      if (originalRecipe) await writeFile(recipeFile, originalRecipe);
      else await rm(recipeFile);
      await rpc('run.refreshMirror', { runId });
    }
    await rpc('run.tags.set', { runId, tags: original.tags ?? [] });
    base.hash = 'runs';
    await cdp('goto', base.href);
  }
  process.exit(0);
}

if (phase === 'dispatch-runs-web') {
  const cdp = async (...args) => {
    const { stdout } = await execute(
      process.execPath,
      [path.join(root, 'apps/command-center/scripts/cdp.mjs'), ...args],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout);
  };
  const route = 'dispatch';
  const probe = path.join(root, 'apps/command-center/scripts/probes/offline-dispatch-runs.js');
  const storeProbe = path.join(
    root,
    'apps/command-center/scripts/probes/offline-dispatch-runs-store.js',
  );
  const base = new URL(process.env.FARMSLOT_UI_URL ?? `http://localhost:${process.env.VITE_PORT}`);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
  base.searchParams.set('dispatch-runs-proof', randomUUID());
  base.hash = route;
  const artifacts =
    process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR ??
    path.join(home, 'dispatch-runs-proof', randomUUID());
  await mkdir(artifacts, { recursive: true });
  const snapshot = () => cdp('eval', route, '--file', probe);
  const until = async (ready, label) => {
    const deadline = Date.now() + 45000;
    let value;
    do {
      value = await snapshot();
      if (ready(value)) return value;
      await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
  };
  const storedAt = async (expected) => {
    const deadline = Date.now() + 15000;
    let stored;
    do {
      stored = await cdp('eval', route, '--file', storeProbe);
      if (stored.storedObservedAt === expected) return stored;
      await delay(50);
    } while (Date.now() < deadline);
    assert.fail(
      `The actual dispatch SQLite row must match its accepted timestamp: ${JSON.stringify(stored)}`,
    );
  };
  const result = await withRunFixture(
    ({ runId }) => ({
      status: 'blocked',
      completedAt: undefined,
      ticketOrPr: `Offline dispatch proof ${runId.slice(0, 8)}`,
    }),
    async ({ runId, runFile }) => {
      const row = (value) => value.cards?.find((card) => card.id === runId);
      await cdp('goto', base.href);
      await cdp('focus', route);
      await cdp('click', route, 'dispatch-wizard >>> [data-testid="dispatch-intent-comparison"]');
      const initial = await until(
        (value) =>
          value.open &&
          value.picker.status === 'ready' &&
          value.canonicalRows &&
          row(value)?.visible &&
          !row(value).disabled,
        'The comparison picker must render the actual shared current list',
      );
      assert.equal(initial.selectedBaseline, '');
      assert.equal(initial.picker.query.method, 'run.list');
      assert.equal(initial.picker.query.params.limit, 50);
      await cdp('fill', route, 'dispatch-wizard >>> .compare-modal-search', runId);
      await until(
        (value) => value.cards.length === 1 && row(value)?.visible,
        'Real picker search must isolate the disposable run',
      );
      await rpc('run.cancel', { runId });
      const changed = await until(
        (value) =>
          value.picker.status === 'ready' &&
          value.canonicalRows &&
          row(value)?.text.includes('cancelled'),
        'External cancellation must update the visible canonical comparison card',
      );
      await cdp('screenshot', route, path.join(artifacts, 'dispatch-picker-current.png'));
      await cdp('key', route, 'Tab');
      await until(
        (value) => value.activeCard === runId,
        'Real keyboard focus must reach the baseline card',
      );
      let pickerObservedAt;
      await withOwnedGatewayOffline(async () => {
        const stale = await until(
          (value) =>
            value.open &&
            value.picker.status === 'stale' &&
            value.canonicalRows &&
            row(value)?.visible &&
            row(value).disabled,
          'Saved comparison cards must disable selection after disconnect',
        );
        pickerObservedAt = stale.picker.observedAt;
        assert(pickerObservedAt >= changed.picker.observedAt);
        await cdp('key', route, 'Enter');
        const refused = await snapshot();
        assert.equal(
          refused.selectedBaseline,
          '',
          'A real keyboard selection cannot adopt stale comparison inputs',
        );
        assert.equal(refused.open, true);
        await until(
          (value) => value.pickerAge && value.pickerAge !== stale.pickerAge,
          'Saved picker age must repaint without reading',
        );
        await storedAt(pickerObservedAt);
        await cdp('screenshot', route, path.join(artifacts, 'dispatch-picker-stale.png'));
      });
      await until(
        (value) =>
          value.pickerReady &&
          !value.contextBlocked &&
          value.picker.status === 'ready' &&
          row(value)?.visible &&
          !row(value).disabled &&
          !value.selectedBaseline,
        'Reconnect must reread the picker without selecting a baseline',
      );
      await cdp('click', route, `dispatch-wizard >>> [data-run-id="${runId}"] .compare-run-cta`);
      const selected = await until(
        (value) =>
          value.selectedBaseline === runId &&
          !value.open &&
          value.baseline.status === 'ready' &&
          value.runInputsReady,
        'An explicit current selection must bind its canonical full-run observation',
      );
      assert.equal(selected.baseline.query.method, 'run.get');
      assert.deepEqual(selected.baseline.query.params, { runId });
      assert(selected.ticket.includes('Offline dispatch proof'));
      let baselineObservedAt;
      await withOwnedGatewayOffline(async () => {
        const stale = await until(
          (value) =>
            value.selectedBaseline === runId &&
            value.baseline.status === 'stale' &&
            !value.runInputsReady &&
            value.baselineAge,
          'A saved selected baseline must retire dispatch readiness until a current read',
        );
        baselineObservedAt = stale.baseline.observedAt;
        await storedAt(baselineObservedAt);
        await cdp('screenshot', route, path.join(artifacts, 'dispatch-baseline-stale.png'));
      });
      await until(
        (value) =>
          value.selectedBaseline === runId &&
          value.baseline.status === 'ready' &&
          value.runInputsReady,
        'Reconnect must revalidate the selected full run without dispatching',
      );
      const record = JSON.parse(await readFile(runFile, 'utf8'));
      assert.equal(record.status, 'cancelled');
      assert.equal(record.slotId, null);
      return {
        result: 'PASS',
        action: phase,
        sharedComparisonPicker: true,
        externalCancellationVisible: true,
        staleKeyboardRefused: true,
        selectionNotReplayed: true,
        selectedFullRunObserved: true,
        pickerSqliteObservedAt: pickerObservedAt,
        baselineSqliteObservedAt: baselineObservedAt,
        coldPickerPendingFleetPersistence: true,
        dispatchCommandMatrixPending: true,
        screenshots: artifacts,
      };
    },
  );
  base.hash = 'runs';
  await cdp('goto', base.href);
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (phase === 'bulk-archive-web') {
  const tag = `offline-archive-${randomUUID().slice(0, 20)}`;
  const artifacts =
    process.env.FARMSLOT_RUN_WEB_EVIDENCE_DIR ?? path.join(home, 'archive-proof-evidence', tag);
  await mkdir(artifacts, { recursive: true });
  const cdpPath = path.join(root, 'apps/command-center/scripts/cdp.mjs');
  const probePath = path.join(root, 'apps/command-center/scripts/probes/offline-run-list.js');
  const cdp = async (...args) => {
    const { stdout } = await execute(process.execPath, [cdpPath, ...args], {
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  };
  const result = await withRunFixture(
    () => ({ tags: [tag] }),
    async (first) =>
      withRunFixture(
        () => ({ tags: [tag] }),
        async (second) => {
          const ids = [first.runId, second.runId];
          const base = new URL(
            process.env.FARMSLOT_UI_URL ?? `http://localhost:${process.env.VITE_PORT}`,
          );
          assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
          base.searchParams.set('archive-proof', tag);
          base.hash = `runs?tab=all&tag=${tag}`;
          const until = async (ready, label) => {
            const deadline = Date.now() + 45000;
            let value;
            do {
              value = await cdp('eval', 'runs', '--file', probePath);
              if (ready(value)) return value;
              await delay(100);
            } while (Date.now() < deadline);
            assert.fail(`${label}: ${JSON.stringify(value)}`);
          };
          await cdp('goto', base.href);
          await cdp('focus', 'runs');
          await until(
            (value) =>
              value.freshness === 'ready' &&
              value.tagFreshness === 'ready' &&
              ids.every((id) => value.rows.some((row) => row.id === id && row.visible)),
            'Both disposable runs must be visible and current',
          );
          await cdp('click', 'runs', 'run-list >>> .manage-btn');
          for (const id of ids)
            await cdp('click', 'runs', `run-list >>> [data-row-id="${id}"] .selector-btn`);
          await until(
            (value) => value.selectedCount === 2 && value.archiveDisabled === false,
            'The explicit archive selection must contain both current runs',
          );
          await cdp('screenshot', 'runs', path.join(artifacts, 'archive-two-selected.png'));
          await cdp('click', 'runs', 'run-list >>> .actions-bar.manage .action-btn.cleanup');
          await until(
            (value) =>
              value.freshness === 'ready' &&
              value.tagFreshness === 'ready' &&
              !value.actionInProgress &&
              ids.every((id) => !value.rows.some((row) => row.id === id)),
            'One explicit archive must remove both selected runs',
          );
          for (const id of ids) {
            await assert.rejects(access(path.join(home, 'runs', `${id}.json`)), { code: 'ENOENT' });
            const archived = JSON.parse(
              await readFile(path.join(home, 'runs', 'archive', `${id}.json`), 'utf8'),
            );
            assert.equal(archived.id, id);
            assert(archived.archivedAt);
            await assert.rejects(second.observed.read('run.get', { runId: id }), {
              code: 'RUN_NOT_FOUND',
            });
          }
          await cdp('screenshot', 'runs', path.join(artifacts, 'archive-two-completed.png'));
          return {
            result: 'PASS',
            action: phase,
            explicitBatchArchived: 2,
            runIds: ids,
            screenshots: artifacts,
          };
        },
      ),
  );
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (phase === 'inbox-expiry') {
  const decisionId = randomUUID();
  let expiresAt;
  const result = await withRunFixture(
    ({ now }) => {
      expiresAt = now + 25_000;
      const completedAt = new Date(expiresAt - 48 * 60 * 60 * 1000).toISOString();
      const createdAt = new Date(Date.parse(completedAt) - 60_000).toISOString();
      return {
        completedAt,
        createdAt,
        startedAt: createdAt,
        updatedAt: completedAt,
        decisions: [
          {
            id: decisionId,
            type: 'blocked_alert',
            title: 'Inbox expiry proof',
            description: 'A completed pending decision expires without a run write.',
            actions: [],
            createdAt,
          },
        ],
      };
    },
    async ({ runId, runFile, observed }) => {
      const before = await observed.read('decision.list');
      assert(
        before.decisions.some((decision) => decision.id === decisionId),
        'The expiring decision must be visible before its deadline',
      );
      const unchanged = await readFile(runFile, 'utf8');
      const deadline = expiresAt + 8000;
      const expiredNotice = () =>
        observed.changes.find(
          ({ key, receivedAt }) => key.family === 'decisions' && receivedAt >= expiresAt,
        );
      while (!expiredNotice() && Date.now() < deadline) await delay(50);
      assert(expiredNotice(), 'The gateway must publish the completed-decision expiry boundary');
      const after = await observed.read('decision.list');
      assert(!after.decisions.some((decision) => decision.id === decisionId));
      assert.equal((await observed.read('run.get', { runId })).run.status, 'done');
      assert.equal(
        await readFile(runFile, 'utf8'),
        unchanged,
        'Inbox expiry must not rewrite the run',
      );
      return {
        result: 'PASS',
        action: phase,
        runId,
        decisionId,
        expiresAt,
        noticeAt: expiredNotice().receivedAt,
        expiredInboxNotice: true,
        persistedRunUnchanged: true,
      };
    },
  );
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (phase === 'quiet-gate') {
  const decisionId = randomUUID();
  const result = await withRunFixture(
    ({ createdAt }) => ({
      status: 'human-gating',
      completedAt: undefined,
      decisions: [
        {
          id: decisionId,
          type: 'engine_human_gate',
          title: 'Stable no-change gate',
          description: 'A source prerequisite is missing.',
          createdAt,
          actions: [{ id: 'hold', label: 'Hold' }],
          payload: {
            kind: 'no-change',
            disposition: 'no-change',
            reason: 'No worker source is bound.',
          },
        },
      ],
    }),
    async ({ runId, runFile, observed }) => {
      const primed = (await observed.read('run.get', { runId })).run;
      const readiness = primed.decisions.find((decision) => decision.id === decisionId)?.payload
        ?.gateReadiness;
      assert(readiness, 'The first real read must evaluate the gate prerequisites');
      const deadline = Date.now() + 5000;
      let persisted;
      do {
        persisted = await readFile(runFile, 'utf8');
        if (JSON.parse(persisted).updatedAt === primed.updatedAt) break;
        await delay(20);
      } while (Date.now() < deadline);
      assert.equal(JSON.parse(persisted).updatedAt, primed.updatedAt);
      await observed.barrier();
      const before = observed.changes.length;
      for (let index = 0; index < 3; index++) {
        const current = (await observed.read('run.get', { runId })).run;
        assert.deepEqual(
          current.decisions.find((decision) => decision.id === decisionId)?.payload?.gateReadiness,
          readiness,
        );
      }
      await observed.barrier();
      assert(
        !observed.changes.slice(before).some(({ key }) => key.runId === runId),
        'Unchanged gate reads must not invalidate themselves',
      );
      assert.equal(await readFile(runFile, 'utf8'), persisted);
      return {
        result: 'PASS',
        action: phase,
        runId,
        decisionId,
        gateReadiness: readiness.state,
        stableGateReads: 3,
        unchangedGateQuiet: true,
      };
    },
  );
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (phase === 'feedback-consumption') {
  const draftId = randomUUID();
  const retrospectiveId = randomUUID();
  const candidateId = randomUUID();
  const library = path.join(home, `offline-feedback-library-${candidateId}`);
  const targetPath = 'review/antipatterns.md';
  await mkdir(path.join(library, 'review'), { recursive: true });
  await execute('git', ['init', '--quiet', '--initial-branch=fixture', library]);
  await writeFile(
    path.join(library, targetPath),
    '# Private feedback proof\n\nRecord the rule before acknowledging it.\n',
    { flag: 'wx' },
  );
  try {
    const result = await withRunFixture(
      ({ runId, createdAt }) => {
        const candidate = {
          id: candidateId,
          sourceKey: `github.com/offline/fixture#1:review-comment:${candidateId}`,
          provider: 'github',
          repository: 'offline/fixture',
          prNumber: 1,
          kind: 'review-comment',
          revision: candidateId,
          authorKind: 'human',
          resolution: { state: 'open' },
          runIds: [runId],
          familyChangeRunIds: [],
          attribution: { kind: 'unknown', note: 'Private fixture' },
          sources: ['comments-triage'],
        };
        return {
          decisions: [
            {
              id: draftId,
              type: 'engine_learnings_draft',
              title: 'Private landed rule',
              description: 'The rule exists in the private fixture library.',
              createdAt,
              actions: [{ id: 'landed', label: 'Recorded in canonical library' }],
              payload: {
                kind: 'learnings-draft',
                project: 'farmslot-farm',
                sourceRunId: runId,
                destination: {
                  repo: library,
                  path: targetPath,
                  source: 'vars.knowledge_destination',
                },
                holds: [],
                drafts: [
                  {
                    id: `offline-rule-${candidateId}`,
                    targetPath,
                    targetRepo: library,
                    symptom: 'Unrecorded feedback',
                    cause: 'Missing acknowledgement',
                    action: 'Record the landed rule',
                    sourceEntry: candidateId,
                  },
                ],
                feedbackCandidates: [candidate],
              },
            },
            {
              id: retrospectiveId,
              type: 'retrospective',
              title: 'Private feedback retrospective',
              description: 'Read current consumption from the owning ledger.',
              createdAt,
              actions: [],
              payload: {
                kind: 'retrospective',
                outcome: 'success',
                whatThisIs: 'Private feedback proof',
                actionEffects: [],
                feedbackCandidates: [candidate],
              },
            },
          ],
        };
      },
      async ({ runId, observed }) => {
        const inboxCandidate = async () => {
          const inbox = await observed.read('decision.list');
          return inbox.decisions
            .find(({ id }) => id === retrospectiveId)
            ?.payload?.feedbackCandidates?.find(({ id }) => id === candidateId);
        };
        const before = await inboxCandidate();
        assert(before && !before.consumedBy?.length);
        const mark = observed.changes.length;
        assert.equal(
          (await observed.read('decision.resolve', { decisionId: draftId, actionId: 'landed' }))
            .resolved,
          true,
        );
        const after = await inboxCandidate();
        assert(
          after?.consumedBy?.some(
            (entry) =>
              entry.rule === `offline-rule-${candidateId}` && entry.revision === candidateId,
          ),
          'A landed rule must appear in the current retrospective consumption',
        );
        const ledgerFile =
          process.env.FARMSLOT_FEEDBACK_LEDGER ?? path.join(home, 'state/feedback-ledger.json');
        assert((await realpath(ledgerFile)).startsWith(`${home}/`));
        const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'));
        assert(
          ledger.entries.some(
            (entry) => entry.candidateId === candidateId && entry.decisionId === draftId,
          ),
        );
        await observed.barrier();
        assert(observed.changes.slice(mark).some(({ key }) => key.family === 'decisions'));
        return {
          result: 'PASS',
          action: phase,
          runId,
          candidateId,
          ledgerEntryReadable: true,
          retrospectiveConsumptionUpdated: true,
        };
      },
    );
    console.log(JSON.stringify(result));
  } finally {
    await rm(library, { recursive: true, force: true });
  }
  process.exit(0);
}

if (phase === 'query-stamps') {
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE);
  const fixture = JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
  assert.equal(fixture.home, home);
  const observed = await observeResources();
  try {
    const reads = [
      [
        'run.list',
        { limit: 1000, includeFamilySummaries: true, includeProjectAnalytics: true },
        ['runs'],
      ],
      ['run.get', { runId: fixture.runId }, ['run', 'runs']],
      ['decision.list', {}, ['decisions']],
      ['family.observability.get', { familyId: fixture.runId }, ['decisions', 'family']],
      ['run.recipeRunsForRun', { runId: fixture.runId }, ['artifacts', 'run']],
      ['run.slotHistory', { slotId: fixture.slotId, limit: 5 }, ['runs', 'slots']],
      ['run.forSlot', { slotId: fixture.slotId }, ['runs', 'slot']],
      ['run.recipeRunsForSlot', { slotId: fixture.slotId }, ['runs', 'slot']],
      ['run.tags.list', {}, ['runs']],
    ];
    const receipts = [];
    for (const [method, params, families] of reads) {
      const result = await observed.readStamped(method, params);
      assert.equal(
        result.resourceState?.epoch,
        observed.epoch,
        `${method} must carry the current read epoch`,
      );
      assert.deepEqual(
        result.resourceState.dependencies.map(({ key }) => key.family).sort(),
        families,
      );
      for (const { key, revision } of result.resourceState.dependencies) {
        assert(Number.isSafeInteger(revision) && revision >= 0);
        if ('runId' in key) assert.equal(key.runId, fixture.runId);
        if ('familyId' in key) assert.equal(key.familyId, fixture.runId);
        if ('slotId' in key) assert.equal(key.slotId, fixture.slotId);
        if ('scope' in key) assert.equal(key.scope, 'farm');
      }
      receipts.push({ method, dependencies: result.resourceState.dependencies });
    }
    console.log(
      JSON.stringify({ result: 'PASS', action: phase, stampedRunReads: reads.length, receipts }),
    );
  } finally {
    observed.close();
  }
  process.exit(0);
}

if (phase === 'missing-run') {
  const observed = await observeResources();
  const runId = `offline-missing-${randomUUID()}`;
  try {
    for (const method of ['run.get', 'run.recipeRunsForRun'])
      await assert.rejects(
        observed.read(method, { runId }),
        { code: 'RUN_NOT_FOUND' },
        'Missing runs must return the cache eviction code',
      );
    console.log(
      JSON.stringify({ result: 'PASS', action: phase, runId, structuredMissingRun: true }),
    );
  } finally {
    observed.close();
  }
  process.exit(0);
}

if (phase === 'mirror-arrival') {
  assert(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'Select the owned setup-time run fixture');
  const fixture = JSON.parse(await readFile(process.env.FARMSLOT_RUN_PROOF_FIXTURE, 'utf8'));
  assert.equal(fixture.home, home);
  assert.match(fixture.runId, /^[a-f0-9-]{36}$/);
  for (const directory of [fixture.taskDir, fixture.workerRepo, fixture.workerTaskDir]) {
    const relative = path.relative(home, await realpath(directory));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }
  assert.equal(fixture.taskFile, path.join(fixture.taskDir, 'TASK.md'));
  assert.equal(fixture.workerTaskDir, path.join(fixture.workerRepo, '.task', fixture.runId));
  assert.equal(process.env.FARMSLOT_POOL_DIR, path.join(home, 'pool'));
  const pool = JSON.parse(
    await readFile(path.join(home, 'pool', `${fixture.slotId}.json`), 'utf8'),
  );
  assert.equal(pool.host, 'localhost');
  assert(pool.slots.some((slot) => slot.id === fixture.slotId && slot.repo === fixture.workerRepo));
  const before = (await rpc('run.get', { runId: fixture.runId })).run;
  assert.equal(before.taskFile, fixture.taskFile);
  assert.equal(before.slotId, fixture.slotId);
  assert.equal(before.readOnly, false, 'Never mutate imported reference runs');
  const artifact = `artifacts/offline-mirror-${randomUUID()}.md`;
  const contents = `# Artifact arriving after completion\n\n${randomUUID()}\n`;
  const expectedHash = createHash('sha256').update(contents).digest('hex');
  assert(!before.output?.artifactManifest.some((entry) => entry.path === artifact));
  const source = path.join(fixture.workerTaskDir, artifact);
  const destination = path.join(fixture.taskDir, artifact);
  await assert.rejects(access(destination), { code: 'ENOENT' });
  const observed = await observeResources();
  try {
    await writeFile(source, contents, { flag: 'wx' });
    await observed.barrier();
    assert(
      !observed.changes.some(
        ({ key }) => key.family === 'artifacts' && key.runId === fixture.runId,
      ),
      'Worker completion alone must not announce a readable gateway mirror',
    );
    // The worker writes only its source. The real refresh must acquire and retain it.
    const refreshed = await rpc('run.refreshMirror', { runId: fixture.runId });
    assert.equal(refreshed.ok, true, refreshed.reason);
    assert(refreshed.copied > 0, 'The late worker artifact must actually transfer');
    assert.equal(await readFile(destination, 'utf8'), contents);
    const after = (await rpc('run.get', { runId: fixture.runId })).run;
    assert.equal(after.output.captureError, undefined);
    const entry = after.output.artifactManifest.find((entry) => entry.path === artifact);
    assert(entry, 'The gateway output must contain the newly acquired artifact');
    assert.equal(entry.sha256, expectedHash);
    assert.equal(entry.sizeBytes, Buffer.byteLength(contents));
    assert(after.output.artifactBundle?.bundleDigest, 'The output must be retained by identity');
    const retainedUrl = new URL('/api/run-artifact', gateway);
    retainedUrl.protocol = 'http:';
    retainedUrl.search = new URLSearchParams({
      runId: fixture.runId,
      path: artifact,
      recipeRunId: 'current-artifacts',
      bundleDigest: after.output.artifactBundle.bundleDigest,
    });
    const retained = await fetch(retainedUrl, {
      headers: { Authorization: `Bearer ${profile.credential.token}` },
    });
    assert.equal(
      retained.status,
      200,
      'The retained artifact must be readable through its real endpoint',
    );
    assert.equal(await retained.text(), contents);
    assert.equal(retained.headers.get('ETag'), `"${expectedHash}"`);
    assert.equal(
      retained.headers.get('X-Farmslot-Bundle-Digest'),
      after.output.artifactBundle.bundleDigest,
    );
    await observed.barrier();
    assert(
      observed.changes.some(({ key }) => key.family === 'artifacts' && key.runId === fixture.runId),
      'Actual mirror arrival must publish its own artifact change',
    );
    console.log(
      JSON.stringify({
        result: 'PASS',
        action: phase,
        runId: fixture.runId,
        artifact,
        copied: refreshed.copied,
        sha256: entry.sha256,
        bytes: entry.sizeBytes,
        bundleDigest: after.output.artifactBundle.bundleDigest,
        workerSourceArrived: true,
        readableMirrorMatches: true,
        gatewayManifestMatches: true,
        retainedHttpMatches: true,
        artifactChangeObserved: true,
      }),
    );
  } finally {
    observed.close();
  }
  process.exit(0);
}

const id = randomUUID();
const project = path.join(projects, `offline-store-proof-${id}`);
await mkdir(project);
try {
  const task = path.join(project, 'tasks', 'decision-proof');
  await mkdir(task, { recursive: true });
  const file = path.join(task, '.pending_decision.json');
  await writeFile(
    file,
    JSON.stringify({
      id,
      type: 'blocked_alert',
      title: 'Run store decision proof',
      actions: [{ id: 'acknowledge', label: 'Acknowledge' }],
      created_at: new Date().toISOString(),
    }),
  );
  const before = await rpc('decision.list');
  assert.equal(before.decisions.filter((decision) => decision.id === id).length, 1);
  assert.equal(
    before.decisions.find((decision) => decision.id === id).title,
    'Run store decision proof',
  );
  const acknowledgement = await rpc('decision.resolve', {
    decisionId: id,
    actionId: 'acknowledge',
  });
  assert.equal(acknowledgement.resolved, true);
  await assert.rejects(
    access(file),
    { code: 'ENOENT' },
    'An acknowledged decision must have no source',
  );
  const after = await rpc('decision.list');
  assert(!after.decisions.some((decision) => decision.id === id));
  console.log(
    JSON.stringify({
      result: 'PASS',
      action: 'file-decision',
      explicitId: id,
      readableBefore: true,
      resolved: true,
      fileRemoved: true,
      absentFromInbox: true,
    }),
  );
} finally {
  await rm(project, { recursive: true, force: true });
}
