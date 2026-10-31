import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  messages,
  nativeResumeFitsScrollView,
  nativeScrollViewGesture,
  renderedNativeResumeTarget,
  resolveNativeStoreInputs,
  sha256,
} from './native-store-fixture.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const phase = process.argv[2];
const forbidden = [
  'native.session.create',
  'native.session.ensure',
  'native.session.send',
  'native.session.respond',
  'native.session.close',
  'native.session.interrupt',
  'native.session.cancel',
];
if (phase === 'dry-preflight') {
  try {
    process.stdout.write(
      `${JSON.stringify(await resolveNativeStoreInputs(process.env, root), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
} else if (phase === 'proxy-server') {
  await proxyServer();
} else if (phase === 'prove') {
  await prove();
} else {
  throw new Error('Use dry-preflight, proxy-server, or prove. No phase starts a simulator.');
}

/** Runtime-only, redacted passive transport. Never imported/started by dry-preflight. */
async function proxyServer() {
  assert.equal(process.env.FARMSLOT_NATIVE_STORE_PROXY_PORT, '7917');
  assert.equal(process.env.GATEWAY_PORT, '7914');
  const directory = await realpath(process.env.FARMSLOT_NATIVE_STORE_PROXY_DIR);
  assert((await stat(directory)).isDirectory());
  const { createServer } = await import('node:http');
  const { default: WebSocket, WebSocketServer } = await import('ws');
  const startId = randomUUID();
  const receipt = {
    version: 1,
    startId,
    pid: process.pid,
    startedAt: Date.now(),
    root,
    script: fileURLToPath(import.meta.url),
    scriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    listenHost: '127.0.0.1',
    port: 7917,
    upstreamPort: 7914,
  };
  // Exclusive receipt prevents silently replacing a previous proxy/attempt. Root owns teardown.
  await writeFile(path.join(directory, 'server.json'), JSON.stringify(receipt), {
    flag: 'wx',
    mode: 0o600,
  });
  const counts = Object.assign(
    Object.create(null),
    Object.fromEntries(forbidden.map((method) => [method, 0])),
  );
  // Read-only D07 response provenance from the app's existing transport. Never retain params/auth.
  const observedReadMethods = new Set([
    'backlog.list',
    'roadmap.list',
    'config.projects',
    'dispatch.queue.list',
    'workGraph.list',
    'prWatch.list',
    'prRules.list',
    'prPush.list',
    'copilot.status',
  ]);
  const successfulReads = Object.create(null);
  const lastObservedReads = Object.create(null);
  let sequence = 0;
  let failure;
  let writes = Promise.resolve();
  let closing = false;
  const pairs = new Set();
  const state = () => ({
    startId,
    sequence,
    counts: { ...counts },
    successfulReads: { ...successfulReads },
    connections: pairs.size,
    lastObservedReads: { ...lastObservedReads },
    failure,
    stopped: closing,
  });
  const persist = () => {
    const content = JSON.stringify(state());
    writes = writes.then(async () => {
      const tmp = path.join(directory, 'counts.tmp');
      await writeFile(tmp, content, { mode: 0o600 });
      await rename(tmp, path.join(directory, 'counts.json'));
    });
    return writes;
  };
  async function controlledOutage() {
    try {
      const marker = JSON.parse(await readFile(path.join(directory, 'outage.json'), 'utf8'));
      return marker.startId === startId;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  function closePair(pair) {
    if (pair.closed) return;
    pair.closed = true;
    pairs.delete(pair);
    pair.downstream.terminate();
    pair.upstream.terminate();
  }
  async function fail(code) {
    if (failure) return;
    // Error messages/frames/URLs may contain credentials. Persist only a fixed diagnostic code.
    failure = code;
    await persist();
    for (const pair of [...pairs]) closePair(pair);
    sockets.close();
    server.close();
    process.exitCode = 1;
  }
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/native-store-proof-counts') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(state()));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (downstream, incoming) => {
    const upstream = new WebSocket(`ws://127.0.0.1:7914${incoming.url}`);
    const pair = { downstream, upstream, reads: new Map() };
    pairs.add(pair);
    const waiting = [];
    let queuedBytes = 0;
    downstream.on('message', (bytes, binary) => {
      if (!binary) {
        let frame;
        try {
          frame = JSON.parse(String(bytes));
        } catch {
          void fail('INVALID_CLIENT_JSON');
          return;
        }
        if (frame.type === 'req' && typeof frame.method === 'string') {
          if (frame.method === 'auth.connect') {
            pair.authRequestId = frame.id;
            pair.epoch = undefined;
          }
          // Bound keys to known protocol method syntax. Never persist params or auth frames.
          if (!/^[a-zA-Z][a-zA-Z0-9_.]{0,100}$/.test(frame.method)) {
            void fail('INVALID_METHOD');
            return;
          }
          if (Object.keys(counts).length >= 256 && !(frame.method in counts)) {
            void fail('METHOD_LIMIT');
            return;
          }
          counts[frame.method] = (counts[frame.method] || 0) + 1;
          if (observedReadMethods.has(frame.method)) {
            if (pair.reads.size >= 200 || pair.reads.has(frame.id)) {
              void fail('READ_TRACKING_LIMIT');
              return;
            }
            pair.reads.set(frame.id, {
              method: frame.method,
              observedRequest: frame.resourceRead?.version === 1,
            });
          }
          sequence++;
          void persist();
        }
      }
      if (upstream.readyState === WebSocket.CONNECTING) {
        queuedBytes += bytes.length;
        if (queuedBytes > 8 * 1024 * 1024) {
          void fail('PENDING_BYTES_LIMIT');
          return;
        }
        waiting.push([bytes, binary]);
      } else if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary });
      else closePair(pair);
    });
    upstream.on('open', () => {
      for (const [bytes, binary] of waiting) upstream.send(bytes, { binary });
      waiting.length = 0;
    });
    upstream.on('message', (bytes, binary) => {
      if (!binary) {
        let frame;
        try {
          frame = JSON.parse(String(bytes));
        } catch {
          void fail('INVALID_UPSTREAM_JSON');
          return;
        }
        if (frame.type === 'res' && frame.id === pair.authRequestId) {
          const capability = frame.payload?.capabilities?.resourceChanges;
          pair.epoch =
            frame.ok === true &&
            capability?.version === 1 &&
            typeof capability.epoch === 'string' &&
            capability.epoch.length > 0
              ? capability.epoch
              : undefined;
        }
        const read = frame.type === 'res' ? pair.reads.get(frame.id) : undefined;
        if (read) {
          pair.reads.delete(frame.id);
          const dependencies = frame.resourceState?.dependencies;
          if (
            frame.ok === true &&
            read.observedRequest &&
            pair.epoch &&
            frame.resourceState?.epoch === pair.epoch &&
            Array.isArray(dependencies) &&
            dependencies.length > 0 &&
            dependencies.every(
              (entry) =>
                entry &&
                entry.key &&
                typeof entry.key === 'object' &&
                !Array.isArray(entry.key) &&
                typeof entry.key.family === 'string' &&
                entry.key.family.length > 0 &&
                Number.isSafeInteger(entry.revision) &&
                entry.revision >= 0,
            ) &&
            frame.payload &&
            typeof frame.payload === 'object' &&
            !Array.isArray(frame.payload)
          ) {
            successfulReads[read.method] = (successfulReads[read.method] || 0) + 1;
            lastObservedReads[read.method] = {
              completedAt: Date.now(),
              resourceState: frame.resourceState,
              payloadSha256: sha256(JSON.stringify(frame.payload)),
            };
            void persist();
          }
        }
      }
      if (downstream.readyState === WebSocket.OPEN) downstream.send(bytes, { binary });
    });
    for (const peer of [downstream, upstream]) {
      peer.on('close', () => {
        if (pairs.has(pair)) closePair(pair);
      });
      peer.on('error', async (error) => {
        if (closing || pair.closed) return;
        if (
          ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code) &&
          (await controlledOutage())
        ) {
          closePair(pair);
          return;
        }
        await fail('UNEXPECTED_SOCKET_ERROR');
      });
    }
  });
  server.on('error', () => {
    void fail('LISTENER_ERROR');
  });
  sockets.on('error', () => {
    void fail('WEBSOCKET_SERVER_ERROR');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(7917, '127.0.0.1', resolve);
  });
  await persist();
  await writeFile(path.join(directory, 'ready.json'), JSON.stringify(receipt), {
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ proxyReady: true, pid: process.pid, startId, port: 7917 })}\n`,
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      closing = true;
      for (const pair of [...pairs]) closePair(pair);
      sockets.close();
      server.close();
      await persist();
    });
}

async function prove() {
  // Same resolver and exact hashed inputs as preflight. No device work precedes this gate.
  const plan = await resolveNativeStoreInputs(process.env, root);
  assert(
    process.env.FARMSLOT_NATIVE_STORE_PLAN,
    'Set FARMSLOT_NATIVE_STORE_PLAN to the saved dry plan',
  );
  const saved = JSON.parse(await readFile(process.env.FARMSLOT_NATIVE_STORE_PLAN, 'utf8'));
  assert.equal(saved.inputHash, plan.inputHash, 'Preflight input drift; do not launch');
  const attemptFile = path.join(plan.artifacts, `native-store-attempt-${plan.inputHash}.json`);
  let outageMarker;
  let poolRestore;
  const attempt = { inputHash: plan.inputHash, startedAt: Date.now(), status: 'consumed' };
  await writeFile(attemptFile, JSON.stringify(attempt), { flag: 'wx', mode: 0o600 });
  const save = (name, value) =>
    writeFile(path.join(plan.artifacts, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { setTimeout: delay } = await import('node:timers/promises');
    const execute = promisify(execFile);
    const { createAgentDeviceClient } = await import('agent-device');
    const { withOwnedGatewayOffline } =
      await import('../../../command-center/scripts/owned-gateway-outage.mjs');
    process.env.SCHEME = plan.scheme;
    process.env.FARMSLOT_RECIPE_METRO_HOST = '127.0.0.1';
    const { waitForSimulatorRecipeBridge, confirmSimulatorURLPrompt } =
      await import('./simulator-dev-client.mjs');
    const { prepareDevClient } = await import('./prepare-dev-client.mjs');
    const receipt = JSON.parse(await readFile(path.join(plan.proxyDir, 'ready.json'), 'utf8'));
    assert.equal(receipt.root, root);
    assert.equal(receipt.port, 7917);
    assert.equal(receipt.upstreamPort, 7914);
    const proxyCounts = async () => {
      const response = await fetch('http://127.0.0.1:7917/native-store-proof-counts', {
        signal: AbortSignal.timeout(3000),
      });
      assert(response.ok);
      const counts = await response.json();
      assert.equal(counts.startId, receipt.startId);
      assert(!counts.failure && !counts.stopped, 'Proxy must remain healthy across the attempt');
      return counts;
    };
    const initialProxy = await proxyCounts();
    const device = createAgentDeviceClient({ stateDir: plan.stateDir });
    const sessions = (await device.sessions.list()).filter(
      (session) => session.device.id === plan.simulator,
    );
    assert.equal(
      sessions.length,
      1,
      'Reuse exactly one existing owned device session; never create one',
    );
    const selection = { session: sessions[0].name, platform: 'ios', target: 'mobile' };
    let selected = plan.sessions[0];
    let samples = 0;
    async function observe(ref = `runs-cache:conversation:${selected.id}`) {
      const response = await fetch(`http://127.0.0.1:${plan.metroPort}/farmslot-recipe/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'observeUi',
          nodeId: 'native-store-proof',
          payload: { refs: [ref] },
          timeout_ms: 3000,
        }),
        signal: AbortSignal.timeout(6000),
      });
      if (response.status === 504) return undefined;
      assert(response.ok, `Observer HTTP ${response.status}`);
      const reply = await response.json();
      assert(reply.ok, 'Actual app bridge refused observation');
      const state = reply.observations.runCollections;
      assert.equal(state.platform, 'ios');
      await save(`observe-${String(++samples).padStart(4, '0')}.json`, state);
      return state;
    }
    async function until(predicate, label, ref) {
      const deadline = Date.now() + 60000;
      do {
        await confirmSimulatorURLPrompt(plan.simulator);
        const state = await observe(ref);
        if (state && predicate(state)) return state;
        await delay(150);
      } while (Date.now() < deadline);
      assert.fail(label);
    }
    const open = async (session) => {
      await execute('xcrun', ['simctl', 'openurl', plan.simulator, session.route], {
        timeout: 15000,
      });
      await confirmSimulatorURLPrompt(plan.simulator);
    };
    const complete = (state, status) => {
      const c = state.conversation;
      return (
        c?.session?.id === selected.id &&
        c.session.ownerPrincipalId === selected.owner &&
        c.session.executionNodeId === 'local' &&
        c.selection?.sessionId === selected.id &&
        c.cursor === 660 &&
        c.history?.canonical &&
        c.history.status === status &&
        c.history.messageCount === 200 &&
        c.history.firstMessage === selected.first &&
        c.history.lastMessage === selected.last &&
        c.history.stored?.id === selected.storedId &&
        c.history.observedAt > 0 &&
        c.history.stored.observedAt === c.history.observedAt
      );
    };
    const snapshot = async (name) => {
      const screen = await device.capture.snapshot({
        ...selection,
        interactiveOnly: false,
        forceFull: true,
      });
      await save(`${name}.snapshot.json`, screen);
      await device.capture.screenshot({
        ...selection,
        path: path.join(plan.artifacts, `${name}.png`),
        stabilize: true,
      });
      return screen;
    };
    const visibleText = (screen, text) =>
      screen.nodes.some(
        (node) =>
          node.visibleToUser !== false && `${node.label || ''} ${node.value || ''}`.includes(text),
      );
    async function view(name, ...labels) {
      const deadline = Date.now() + 30000;
      do {
        const screen = await device.capture.snapshot({
          ...selection,
          interactiveOnly: false,
          forceFull: true,
        });
        if (labels.every((label) => visibleText(screen, label))) return snapshot(name);
        await delay(150);
      } while (Date.now() < deadline);
      assert.fail(`Native view did not render ${name}: ${labels.join(', ')}`);
    }
    const fleetComplete = (state, status, ids) =>
      state.fleet?.status === status &&
      state.fleet.canonical &&
      state.fleet.projectionMatches &&
      state.fleet.stored?.observedAt === state.fleet.observedAt &&
      state.fleet.observedAt > 0 &&
      ids.every((id) =>
        state.fleet.data?.slots.some(
          (slot) => slot.slot === id && slot.machine === plan.fleet.machine,
        ),
      );
    const openRoute = async (route) => {
      await execute('xcrun', ['simctl', 'openurl', plan.simulator, route], { timeout: 15000 });
      await confirmSimulatorURLPrompt(plan.simulator);
    };
    async function sqlite(state, name) {
      assert.equal(state.diagnostics.integrity, 'ok');
      const directory = state.diagnostics.directory.startsWith('file:')
        ? fileURLToPath(state.diagnostics.directory)
        : state.diagnostics.directory;
      assert(path.isAbsolute(directory));
      assert.equal(path.basename(state.diagnostics.filename), state.diagnostics.filename);
      const ownedDirectory = await realpath(directory);
      assert(
        ownedDirectory.includes(`/CoreSimulator/Devices/${plan.simulator}/`),
        'Inspect only the selected simulator cache',
      );
      const database = path.join(ownedDirectory, state.diagnostics.filename);
      const scope = JSON.parse(state.workspaceKey).scope;
      assert(typeof scope === 'string' && scope.length > 0);
      const code =
        'import sqlite3,json,sys,pathlib; db=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True); db.execute("PRAGMA query_only=ON"); integrity=db.execute("PRAGMA integrity_check").fetchone()[0]; rows=db.execute("SELECT q.id,q.observed_at,q.data FROM resource_queries q JOIN resource_stores s ON q.store_id=s.id WHERE s.scope_id=?",(sys.argv[2],)).fetchall(); print(json.dumps({"integrity":integrity,"rows":[dict(id=r[0],observedAt=r[1],data=json.loads(r[2])) for r in rows if r[0].startswith("native.session.read:")],"fleet":[dict(id=r[0],observedAt=r[1],data=json.loads(r[2])) for r in rows if r[0]==sys.argv[3]]})); db.close()';
      assert(state.fleet?.stored?.id, 'The actual fleet query must be persisted');
      const { stdout } = await execute(
        'python3',
        ['-c', code, database, scope, state.fleet.stored.id],
        {
          timeout: 15000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const result = JSON.parse(stdout);
      result.rows.sort((a, b) => a.id.localeCompare(b.id));
      await save(`${name}.sqlite.json`, result);
      assert.equal(result.integrity, 'ok');
      assert.equal(result.fleet.length, 1);
      assert.equal(result.fleet[0].observedAt, state.fleet.observedAt);
      assert.deepEqual(result.fleet[0].data.fleet, state.fleet.data);
      assert.equal(result.rows.length, 10);
      assert.deepEqual(
        result.rows.map((row) => row.id).sort(),
        plan.sessions
          .slice(-10)
          .map((s) => s.storedId)
          .sort(),
      );
      for (const row of result.rows) {
        const fixture = plan.sessions.find((s) => s.storedId === row.id);
        assert.equal(row.data.session.id, fixture.id);
        assert.equal(row.data.session.ownerPrincipalId, fixture.owner);
        assert.equal(row.data.cursor, 660);
        const logical = messages(row.data.events);
        assert.equal(logical.length, 200);
        assert.equal(logical[0].text, fixture.first);
        assert.equal(logical.at(-1).text, fixture.last);
        assert(row.observedAt > 0);
      }
      return result;
    }
    await waitForSimulatorRecipeBridge({ platform: 'ios', simulator: plan.simulator });
    await openRoute(plan.fleet.route);
    await until(
      (state) => fleetComplete(state, 'ready', [plan.fleet.slotId]),
      'The native fleet must render the original configured slot from its canonical cache',
      'runs-cache:snapshot',
    );
    await view('fleet-before-writer', plan.fleet.slotId);
    const originalPool = await readFile(plan.fleet.poolFile);
    const updatedPool = JSON.parse(originalPool);
    updatedPool.slots.push({
      ...updatedPool.slots[0],
      id: plan.fleet.addedSlotId,
      session: plan.fleet.addedSlotId,
    });
    const updatedBytes = Buffer.from(`${JSON.stringify(updatedPool, null, 2)}\n`);
    poolRestore = { originalPool, updatedSha256: sha256(updatedBytes) };
    const poolTemporary = `${plan.fleet.poolFile}.proof-tmp`;
    await writeFile(poolTemporary, updatedBytes, { flag: 'wx', mode: 0o600 });
    await rename(poolTemporary, plan.fleet.poolFile);
    const fleetIds = [plan.fleet.slotId, plan.fleet.addedSlotId];
    await save('fleet-writer.json', { before: sha256(originalPool), after: sha256(updatedBytes) });
    const liveFleet = await until(
      (state) => fleetComplete(state, 'ready', fleetIds),
      'An independent pool-file writer did not update the open native fleet without Refresh',
      'runs-cache:snapshot',
    );
    await save('fleet-live.json', liveFleet);
    await view('fleet-live', ...fleetIds);
    await openRoute(plan.fleet.slotRoute);
    await view('slot-warm', plan.fleet.slotId);
    const warm = [];
    for (const session of plan.sessions) {
      selected = session;
      await open(session);
      warm.push(
        await until(
          (state) =>
            complete(state, 'ready') && state.conversation.ready && state.conversation.caughtUp,
          `History ${session.id} did not become canonical/current/complete`,
        ),
      );
    }
    const current = warm.at(-1);
    assert(fleetComplete(current, 'ready', fleetIds));
    assert(
      (await proxyCounts()).counts['native.session.read'] >
        (initialProxy.counts['native.session.read'] || 0),
      'App must actually traverse the counted proxy, not bypass it',
    );
    await save('warm.json', warm);
    await snapshot('warm-selected');
    const dbWarm = await sqlite(current, 'warm');
    for (const state of warm.slice(-10)) {
      const row = dbWarm.rows.find((row) => row.id === state.conversation.history.stored.id);
      assert.equal(row.observedAt, state.conversation.history.observedAt);
    }
    const selectedRow = dbWarm.rows.find((row) => row.id === selected.storedId);
    const commands = current.conversation.commands;
    let countsBefore = await proxyCounts();
    await save('counts-before.json', countsBefore);
    const marker = path.join(plan.proxyDir, 'outage.json');
    await writeFile(
      marker,
      JSON.stringify({ startId: receipt.startId, inputHash: plan.inputHash }),
      { flag: 'wx', mode: 0o600 },
    );
    outageMarker = marker;
    let cold;
    await withOwnedGatewayOffline(async () => {
      await until((state) => complete(state, 'stale'), 'Selected history did not become stale');
      // Exactly one intentional app restart. The simulator is never booted or shut down here.
      await prepareDevClient('ios', plan.simulator, plan.bundleId);
      await waitForSimulatorRecipeBridge({ platform: 'ios', simulator: plan.simulator });
      await openRoute(plan.fleet.route);
      const coldFleet = await until(
        (state) =>
          fleetComplete(state, 'stale', fleetIds) &&
          state.startedAt > current.startedAt &&
          state.fleet.observedAt === dbWarm.fleet[0].observedAt,
        'Cold native fleet did not restore the exact saved slot data and observation time',
        'runs-cache:snapshot',
      );
      assert.deepEqual(coldFleet.fleet.data, dbWarm.fleet[0].data.fleet);
      await save('fleet-cold.json', coldFleet);
      await view('fleet-cold', ...fleetIds, 'Saved fleet,');
      await openRoute(plan.fleet.slotRoute);
      await view('slot-cold', plan.fleet.slotId);
      await open(selected);
      cold = await until(
        (state) => complete(state, 'stale') && state.startedAt > current.startedAt,
        'Cold runtime did not restore the exact saved standalone history',
      );
      assert.equal(cold.conversation.history.observedAt, selectedRow.observedAt);
      assert.equal(cold.startedAt > current.startedAt, true);
      assert.equal(cold.conversation.resumeAvailable, true);
      assert.equal(cold.conversation.resumeReady, false);
      assert.equal(cold.conversation.canSend, false);
      assert.equal(cold.conversation.writable, false);
      assert.deepEqual(cold.conversation.commands, commands);
      const dbCold = await sqlite(cold, 'cold');
      assert.deepEqual(
        dbCold.rows,
        dbWarm.rows,
        'Offline restart must preserve exact saved data and age',
      );
      assert.deepEqual(dbCold.fleet, dbWarm.fleet);
      let screen;
      let resume;
      let resumeScreenshot;
      let previousContent;
      let unchangedScrolls = 0;
      // Timeline initially follows the tail. Scroll real content toward the Resume control.
      for (let i = 0; i < 80; i++) {
        screen = await snapshot(`cold-scroll-${i}`);
        resume = screen.nodes.find((node) => node.identifier === plan.resumeSelector);
        if (nativeResumeFitsScrollView(screen, plan.resumeSelector)) {
          resumeScreenshot = path.join(plan.artifacts, `cold-scroll-${i}.png`);
          break;
        }
        const content = JSON.stringify(
          screen.nodes
            .filter((node) => node.visibleToUser !== false)
            .map(({ label, value, rect }) => ({ label, value, rect })),
        );
        unchangedScrolls = content === previousContent ? unchangedScrolls + 1 : 0;
        assert(unchangedScrolls < 2, 'Conversation scroll gesture did not move actual content');
        previousContent = content;
        const gesture = nativeScrollViewGesture(screen);
        await save(`cold-scroll-${i}.gesture.json`, gesture);
        await device.interactions.swipe({ ...selection, ...gesture });
      }
      assert(
        resume?.rect && resume.rect.y >= 0 && resume.visibleToUser !== false,
        'Actual Resume testID must be present in native accessibility tree',
      );
      assert.equal(
        resume.enabled,
        false,
        'Native accessibility disabled must agree with stale Resume',
      );
      assert(
        screen.nodes.some((node) =>
          /^Saved conversation history, .+/.test(node.label || node.value || ''),
        ),
        'Visible saved conversation age caption required',
      );
      const viewport = screen.nodes.find(
        (node) =>
          ['Application', 'Window'].includes(node.type) &&
          node.rect?.width > 0 &&
          node.rect?.height > 0,
      )?.rect;
      const x = resume.rect.x + resume.rect.width / 2;
      const y = resume.rect.y + resume.rect.height / 2;
      assert(
        viewport
          ? x >= viewport.x &&
              y >= viewport.y &&
              x < viewport.x + viewport.width &&
              y < viewport.y + viewport.height
          : resume.visibleToUser === true,
        'The point tap must be inside the actual native viewport or explicitly visible',
      );
      assert(
        resume.rect.width > 0 && resume.rect.height > 0 && resume.rect.x >= 0 && resume.rect.y >= 0,
      );
      assert(resumeScreenshot, 'Require the actual target screenshot before any point press');
      const recognized = await execute(
        'osascript',
        [
          '-l',
          'JavaScript',
          fileURLToPath(new URL('./recognize-simulator-prompt.jxa', import.meta.url)),
          resumeScreenshot,
        ],
        { timeout: 30000 },
      );
      const rendered = JSON.parse(recognized.stdout);
      assert.deepEqual(renderedNativeResumeTarget(screen, rendered, plan.resumeSelector), { x, y });
      await save('disabled-resume-target-pair.json', {
        screenshot: path.basename(resumeScreenshot),
        screenshotSha256: sha256(await readFile(resumeScreenshot)),
        recognized: rendered,
        target: {
          identifier: plan.resumeSelector,
          rect: resume.rect,
          enabled: resume.enabled,
          x,
          y,
        },
      });
      countsBefore = await proxyCounts();
      await save('counts-before-disabled-tap.json', countsBefore);
      // Supported coordinate press deliberately exercises the disabled real Pressable once.
      await device.interactions.press({ ...selection, x, y });
      const afterTap = await until(
        (state) => complete(state, 'stale'),
        'Disabled tap lost saved history',
      );
      assert.deepEqual(afterTap.conversation.commands, commands);
      assert(!afterTap.conversation.pendingCommandId);
      await snapshot('cold-after-disabled-resume');
      await save('cold.json', cold);
    });
    const recovered = await until(
      (state) =>
        complete(state, 'ready') && state.conversation.ready && state.conversation.caughtUp,
      'Gateway recovery did not refresh the saved history',
    );
    assert.equal(recovered.startedAt, cold.startedAt, 'Recovery must not cold-launch again');
    assert(recovered.conversation.history.observedAt >= selectedRow.observedAt);
    // Bounded read-only samples after real recovery catch queued command delivery as well.
    const settledUntil = Date.now() + 2000;
    do {
      const state = await observe();
      if (state) {
        assert.deepEqual(state.conversation.commands, commands);
        assert(!state.conversation.pendingCommandId);
      }
      await delay(150);
    } while (Date.now() < settledUntil);
    const countsAfter = await proxyCounts();
    await save('counts-after.json', countsAfter);
    for (const method of forbidden)
      assert.equal(
        countsAfter.counts[method] || 0,
        countsBefore.counts[method] || 0,
        `Disabled Resume/recovery must not deliver ${method}, even a failed request`,
      );
    for (const session of plan.sessions)
      assert.equal(
        sha256(await readFile(session.journal)),
        session.sha256,
        'No native command may mutate a setup CLOSED journal',
      );
    await sqlite(recovered, 'recovered');
    await snapshot('recovered');
    await save('recovered.json', recovered);
    await openRoute(plan.fleet.route);
    await until(
      (state) => fleetComplete(state, 'ready', fleetIds) && state.startedAt === cold.startedAt,
      'Native fleet did not recover in the same cold runtime',
      'runs-cache:snapshot',
    );
    await view('fleet-recovered', ...fleetIds);
    await unlink(marker);
    outageMarker = undefined;
    attempt.status = 'passed';
    process.stdout.write(
      `${JSON.stringify({
        nativeStoreWarmRetention: true,
        nativeStoreColdAge: true,
        nativeStoreDisabledResumeNoRpc: true,
        nativeStoreRecoveryNoReplay: true,
        nativeFleetLiveWriter: true,
        nativeFleetColdAge: true,
        nativeSlotColdView: true,
        inputHash: plan.inputHash,
      })}\n`,
    );
  } catch (error) {
    attempt.status = 'failed';
    // Keep detailed failure locally. Do not echo process stderr, profile data or raw transport frames.
    attempt.failure = error.code || error.name || 'PROOF_FAILED';
    if (error.code === 'ERR_ASSERTION') attempt.assertion = error.message;
    await save('failure.json', { failure: attempt.failure, assertion: attempt.assertion });
    throw new Error(
      'Native store proof failed; preserve the attempt and observation/snapshot artifacts for root disposition.',
      { cause: undefined },
    );
  } finally {
    if (poolRestore) {
      const currentPool = await readFile(plan.fleet.poolFile);
      assert(
        [poolRestore.updatedSha256, sha256(poolRestore.originalPool)].includes(sha256(currentPool)),
        'Refuse to overwrite a foreign pool change during proof cleanup',
      );
      await writeFile(plan.fleet.poolFile, poolRestore.originalPool);
    }
    if (outageMarker) await unlink(outageMarker);
    attempt.finishedAt = Date.now();
    await writeFile(attemptFile, JSON.stringify(attempt, null, 2), { mode: 0o600 });
  }
}
