import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  digest,
  exclusiveJson,
  forbiddenPlanningMethods,
  observedMemoryMethods,
  persistedQueries,
  planningSourceMutation,
  resolveNativePlanningInputs,
  verifyNativePlanningSource,
  writePlanningSource,
} from './native-planning-fixture.mjs';
import { nativeScrollViewGesture, renderedNativeDisabledTarget } from './native-store-fixture.mjs';

const source = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const helpers = [
  'apps/companion/scripts/agentic/prove-native-planning.mjs',
  'apps/companion/scripts/agentic/native-planning-fixture.mjs',
  'apps/companion/scripts/agentic/prepare-native-planning-inputs.mjs',
  'apps/companion/scripts/agentic/prove-native-store.mjs',
  'apps/companion/scripts/agentic/simulator-dev-client.mjs',
  'apps/companion/scripts/agentic/prepare-dev-client.mjs',
  'apps/companion/scripts/agentic/recognize-simulator-prompt.jxa',
  'apps/command-center/scripts/owned-gateway-outage.mjs',
  'apps/companion/scripts/agentic/native-store-fixture.mjs',
  'apps/companion/src/farmslot/run-collections-proof.ts',
  'apps/companion/scripts/agentic/recipe/recipes/offline-cold-start.recipe.json',
];

export async function authorizePlanningProof() {
  assert(
    process.env.FARMSLOT_D07_NATIVE_AUTHORIZATION,
    'A future exact-hash runtime disposition is required',
  );
  const a = JSON.parse(await readFile(process.env.FARMSLOT_D07_NATIVE_AUTHORIZATION, 'utf8'));
  assert.equal(a.executionAuthorized, true);
  await verifyNativePlanningSource(source, a.sourceHead);
  assert.equal(a.purpose, 'D07-native-planning');
  assert.equal(a.oneBoot, true);
  assert.equal(a.deliberateColdRestart, true);
  for (const name of helpers)
    assert.equal(
      digest(await readFile(path.join(source, name))),
      a.driverHashes[name],
      `Unapproved helper: ${name}`,
    );
  return a;
}

export function retainedPlanningRows(result) {
  assert.equal(result.integrity, 'ok');
  const rows = Object.fromEntries(
    Object.entries(persistedQueries).map(([name, id]) => {
      const matches = result.rows.filter((row) => row.id === id);
      assert.equal(matches.length, 1, `Actual UI did not persist ${id}`);
      assert(matches[0].observedAt > 0 && matches[0].bytes > 0);
      return [name, matches[0]];
    }),
  );
  for (const method of [
    'backlog.list',
    'dispatch.queue.list',
    'workGraph.list',
    'roadmap.list',
    'config.projects',
  ]) {
    const cohort = result.rows.filter((row) => row.id.startsWith(`${method}:`));
    assert(
      cohort.reduce((sum, row) => sum + row.bytes, 0) <= 2 * 1024 * 1024,
      `${method} aggregate exceeds 2MiB`,
    );
  }
  for (const method of observedMemoryMethods)
    assert(
      !result.rows.some((row) => row.id.startsWith(`${method}:`)),
      `Observed memory-only ${method} was persisted`,
    );
  return rows;
}

export function assertObservedMemoryQueries(snapshot, wire, methods) {
  for (const method of methods) {
    const state = snapshot.domainObservations?.[method];
    assert(
      state && state.status === 'ready' && state.hasData && state.persisted === false,
      `Actual canonical ${method} must be current; transport counts alone are insufficient`,
    );
    assert.equal(state.id, `${method}:{}`);
    assert.deepEqual(
      state.resourceState,
      wire.lastObservedReads?.[method]?.resourceState,
      `Canonical ${method} must cover its actual observed reply`,
    );
  }
}

/** Startup may legitimately read Backlog before the recipe begins; preboot probes cannot count. */
export function assertPlanningReadsFromRuntime(snapshot, wire, methods) {
  assert(Number.isFinite(snapshot.startedAt) && snapshot.startedAt > 0);
  for (const method of methods) {
    assert((wire.successfulReads?.[method] ?? 0) > 0, `Missing observed app read: ${method}`);
    assert(
      wire.lastObservedReads?.[method]?.completedAt >= snapshot.startedAt,
      `A pre-app reply cannot prove current ${method}`,
    );
  }
}

/** A mounted change needs its owning revision, actual app read and persisted payload. */
export function assertMountedPlanningChange(plan, kind, before, after, writer, priorWire, wire) {
  assert(['graph', 'queue'].includes(kind));
  const queryId = persistedQueries[kind];
  const method = queryId.slice(0, queryId.indexOf(':'));
  const collection = kind === 'graph' ? 'work-graphs' : 'dispatch-queue';
  const rows = (snapshot) => snapshot.result.rows.filter((row) => row.id === queryId);
  assert.equal(before.result.integrity, 'ok');
  assert.equal(after.result.integrity, 'ok');
  assert.equal(rows(before).length, 1);
  assert.equal(rows(after).length, 1);
  assert(
    Number.isFinite(before.state.startedAt) && Number.isFinite(before.state.connectionGeneration),
  );
  assert(typeof before.state.workspaceKey === 'string' && before.state.workspaceKey.length);
  assert(
    typeof before.state.connectionProfileId === 'string' && before.state.connectionProfileId.length,
  );
  for (const key of ['startedAt', 'connectionGeneration', 'workspaceKey', 'connectionProfileId'])
    assert.equal(
      after.state[key],
      before.state[key],
      `Mounted writer changed app identity: ${key}`,
    );
  assert.equal(before.state.online, true);
  assert.equal(after.state.online, true);
  assert.equal(wire.startId, priorWire.startId);
  assert.equal(writer.kind, kind);
  assert.equal(writer.method, planningSourceMutation(plan, kind).method);
  assert.equal(writer.sourceHead, plan.sourceHead);
  assert.equal(writer.path, plan.files[kind].path);
  assert.equal(writer.before, plan.files[kind].sha256);
  assert(Number.isFinite(writer.requestedAt) && writer.requestedAt > 0);
  assert((wire.successfulReads[method] ?? 0) > (priorWire.successfulReads[method] ?? 0));
  const previous = priorWire.lastObservedReads[method];
  const current = wire.lastObservedReads[method];
  assert(previous?.completedAt >= before.state.startedAt, 'Before row requires an actual app read');
  assert(
    current?.completedAt >= writer.requestedAt,
    'Mounted mutation requires a post-request read',
  );
  assert(typeof previous.resourceState.epoch === 'string' && previous.resourceState.epoch.length);
  assert.equal(current.resourceState.epoch, previous.resourceState.epoch);
  const revision = (read) =>
    read.resourceState.dependencies.find(
      ({ key }) => key.family === 'planning' && key.collection === collection,
    )?.revision;
  assert(
    Number.isSafeInteger(revision(previous)) && revision(current) > revision(previous),
    'The owning planning revision must advance',
  );
  assert.equal(digest(JSON.stringify(rows(before)[0].data)), previous.payloadSha256);
  assert.equal(digest(JSON.stringify(rows(after)[0].data)), current.payloadSha256);
  const expected = plan.expected[kind];
  if (kind === 'graph') {
    const original = rows(before)[0].data.graphs.find(
      ({ graph }) => graph.id === expected.id,
    )?.graph;
    const updated = rows(after)[0].data.graphs.find(({ graph }) => graph.id === expected.id)?.graph;
    assert.equal(original?.status, expected.beforeStatus);
    assert.equal(updated?.status, expected.afterStatus);
    assert.equal(updated?.title, expected.title);
    assert.equal(updated?.project, plan.project);
  } else {
    const original = rows(before)[0].data.items.find((row) => row.id === expected.id);
    const updated = rows(after)[0].data.items.find((row) => row.id === expected.id);
    assert.equal(original?.priority, expected.priority);
    assert.equal(updated?.priority, expected.afterPriority);
    assert.equal(updated?.status, 'queued');
    assert.equal(updated?.project, plan.project);
  }
}

async function prove() {
  await authorizePlanningProof();
  const plan = await resolveNativePlanningInputs(process.env, source);
  const saved = JSON.parse(await readFile(process.env.FARMSLOT_D07_NATIVE_PLAN, 'utf8'));
  assert.equal(plan.inputHash, saved.inputHash, 'No stale plan reuse');
  const artifacts = await realpath(process.env.FARMSLOT_RECIPE_ARTIFACTS_DIR);
  const attemptFile = path.join(artifacts, `d07-native-attempt-${plan.inputHash}.json`);
  await exclusiveJson(attemptFile, {
    status: 'consumed',
    inputHash: plan.inputHash,
    startedAt: Date.now(),
  });
  let samples = 0;
  const save = (name, value) => exclusiveJson(path.join(artifacts, name), value);
  try {
    // Device, subprocess and SDK dependencies are runtime-only; check-import has no actions.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { setTimeout: delay } = await import('node:timers/promises');
    const execute = promisify(execFile);
    const { createAgentDeviceClient } = await import('agent-device');
    const { confirmSimulatorURLPrompt, waitForSimulatorRecipeBridge } =
      await import('./simulator-dev-client.mjs');
    const { prepareDevClient } = await import('./prepare-dev-client.mjs');
    const simulator = process.env.IOS_SIMULATOR;
    assert.equal(process.env.PLATFORM, 'ios');
    assert(simulator && process.env.SCHEME && process.env.BUNDLE_ID);
    const scheme = process.env.SCHEME;
    const device = createAgentDeviceClient({
      stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR,
    });
    const sessions = (await device.sessions.list()).filter(
      (session) => session.device.id === simulator,
    );
    assert.equal(
      sessions.length,
      1,
      'Attach the recipe-owned current session, never open another lease',
    );
    const selection = { session: sessions[0].name, platform: 'ios', target: 'mobile' };
    const receipt = JSON.parse(
      await readFile(path.join(process.env.FARMSLOT_NATIVE_STORE_PROXY_DIR, 'ready.json'), 'utf8'),
    );
    const counts = async () => {
      const response = await fetch('http://127.0.0.1:7917/native-store-proof-counts', {
        signal: AbortSignal.timeout(3000),
      });
      assert(response.ok);
      const value = await response.json();
      assert.equal(value.startId, receipt.startId);
      assert(!value.failure && !value.stopped);
      return value;
    };
    const observe = async () => {
      const response = await fetch(
        `http://127.0.0.1:${process.env.METRO_PORT}/farmslot-recipe/command`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: 'observeUi',
            nodeId: 'd07-native-planning',
            payload: { refs: ['runs-cache:snapshot'] },
            timeout_ms: 3000,
          }),
          signal: AbortSignal.timeout(6000),
        },
      );
      assert(response.ok, 'Bridge failure is terminal, not a retry/relaunch trigger');
      const reply = await response.json();
      assert(reply.ok && reply.observations?.runCollections);
      const value = reply.observations.runCollections;
      assert.equal(value.platform, 'ios');
      await save(`d07-observe-${++samples}.json`, value);
      return value;
    };
    const currentMemory = async (name, methods) => {
      const deadline = Date.now() + 12000;
      do {
        const [snapshot, wire] = await Promise.all([observe(), counts()]);
        for (const method of methods)
          assert(
            !snapshot.domainObservations?.[method]?.errorCode,
            `Canonical ${method} read failed`,
          );
        if (methods.every((method) => snapshot.domainObservations?.[method]?.status === 'ready')) {
          assertObservedMemoryQueries(snapshot, wire, methods);
          await save(name, { snapshot, wire });
          return;
        }
        await delay(80);
      } while (Date.now() < deadline);
      assert.fail(`Current canonical observations missing: ${methods.join(', ')}`);
    };
    const open = async (route) => {
      await execute('xcrun', ['simctl', 'openurl', simulator, `${scheme}:///${route}`], {
        timeout: 15000,
      });
      await confirmSimulatorURLPrompt(simulator);
    };
    const capture = async (name) => {
      const screen = await device.capture.snapshot({
        ...selection,
        interactiveOnly: false,
        forceFull: true,
      });
      await save(`${name}.snapshot.json`, screen);
      await device.capture.screenshot({
        ...selection,
        path: path.join(artifacts, `${name}.png`),
        stabilize: true,
      });
      return screen;
    };
    const has = (screen, label) => {
      const viewport = screen.nodes.find(
        (node) => ['Application', 'Window'].includes(node.type) && node.rect?.width > 0,
      )?.rect;
      return Boolean(
        viewport &&
        screen.nodes.some((node) => {
          const r = node.rect;
          return (
            node.visibleToUser !== false &&
            r?.width > 0 &&
            r?.height > 0 &&
            r.x >= viewport.x &&
            r.y >= viewport.y &&
            r.x + r.width <= viewport.x + viewport.width &&
            r.y + r.height <= viewport.y + viewport.height &&
            `${node.label ?? ''} ${node.value ?? ''}`.includes(label)
          );
        }),
      );
    };
    const view = async (name, labels, forbidden = []) => {
      for (let i = 0; i < 10; i++) {
        const screen = await capture(`${name}-${i}`);
        if (
          labels.every((label) => has(screen, label)) &&
          forbidden.every((label) => !has(screen, label))
        )
          return screen;
        await delay(250);
      }
      assert.fail(`Mounted view failed ${name}; bounded 10 captures, no Refresh/relaunch`);
    };
    const sqlite = async (name) => {
      const state = await observe();
      assert.equal(state.diagnostics.integrity, 'ok');
      const directory = await realpath(
        state.diagnostics.directory.startsWith('file:')
          ? fileURLToPath(state.diagnostics.directory)
          : state.diagnostics.directory,
      );
      assert(directory.includes(`/CoreSimulator/Devices/${simulator}/`));
      assert.equal(path.basename(state.diagnostics.filename), state.diagnostics.filename);
      const scope = JSON.parse(state.workspaceKey).scope;
      assert(typeof scope === 'string' && scope.length);
      const program =
        'import sqlite3,json,sys,pathlib; c=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True); c.execute("PRAGMA query_only=ON"); rows=c.execute("SELECT q.id,q.observed_at,q.data,q.bytes FROM resource_queries q JOIN resource_stores s ON q.store_id=s.id WHERE s.scope_id=? ORDER BY q.id",(sys.argv[2],)).fetchall(); print(json.dumps({"integrity":c.execute("PRAGMA integrity_check").fetchone()[0],"rows":[dict(id=r[0],observedAt=r[1],data=json.loads(r[2]),bytes=r[3]) for r in rows]})); c.close()';
      const { stdout } = await execute(
        'python3',
        ['-c', program, path.join(directory, state.diagnostics.filename), scope],
        { timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
      );
      const result = JSON.parse(stdout);
      await save(`${name}.sqlite.json`, result);
      return { state, result };
    };
    const unchangedCommands = (before, after) => {
      assert.equal(after.startId, before.startId);
      for (const method of forbiddenPlanningMethods)
        assert.equal(
          after.counts[method] ?? 0,
          before.counts[method] ?? 0,
          `No command/replay: ${method}`,
        );
    };
    const mountedWriter = async (kind, beforeLabels, afterLabels) => {
      await view(`${kind}-writer-before`, beforeLabels);
      const before = await sqlite(`d07-${kind}-writer-before`);
      const priorWire = await counts();
      const writer = await writePlanningSource(plan, kind, artifacts);
      await view(`${kind}-writer-after`, afterLabels);
      const queryId = persistedQueries[kind];
      const method = queryId.slice(0, queryId.indexOf(':'));
      for (let i = 0; i < 10; i++) {
        const after = await sqlite(`d07-${kind}-writer-after-${i}`);
        const wire = await counts();
        const data = after.result.rows.find((row) => row.id === queryId)?.data;
        const updated =
          kind === 'graph'
            ? data?.graphs?.find(({ graph }) => graph.id === plan.expected.graph.id)?.graph
                .status === plan.expected.graph.afterStatus
            : data?.items?.find((row) => row.id === plan.expected.queue.id)?.priority ===
              plan.expected.queue.afterPriority;
        if (
          updated &&
          wire.lastObservedReads?.[method]?.payloadSha256 === digest(JSON.stringify(data))
        ) {
          assertMountedPlanningChange(plan, kind, before, after, writer, priorWire, wire);
          await save(`d07-${kind}-mounted-writer.json`, { before, after, writer, priorWire, wire });
          return;
        }
        await delay(80);
      }
      assert.fail(`Mounted ${kind} change was not persisted from its observed reply`);
    };
    await waitForSimulatorRecipeBridge({ platform: 'ios', simulator });
    const initial = await counts();
    for (const method of forbiddenPlanningMethods)
      assert.equal(initial.counts[method] ?? 0, 0, `No command during app bootstrap: ${method}`);
    await open('backlog');
    const beforeBacklog = await view('backlog-before', [
      plan.expected.backlog.before,
      'Mark ready',
      'Work graphs',
      'Dispatch queue',
    ]);
    const selector = `companion-backlog-${plan.expected.backlog.id}-ready`;
    assert.equal(beforeBacklog.nodes.find((node) => node.identifier === selector)?.enabled, true);
    await writePlanningSource(plan, 'backlog', artifacts);
    await view('backlog-after', [plan.expected.backlog.after], [plan.expected.backlog.before]);
    await open('roadmap');
    await view('roadmap-before', [plan.expected.roadmap.before]);
    await writePlanningSource(plan, 'roadmap', artifacts);
    await view('roadmap-after', [plan.expected.roadmap.after], [plan.expected.roadmap.before]);
    await open('backlog/create');
    await view('projects-before', [plan.project]);
    await writePlanningSource(plan, 'newProject', artifacts);
    await view('projects-after', [plan.addedProject]);
    await open('work-graphs');
    await mountedWriter(
      'graph',
      [plan.expected.graph.title, plan.expected.graph.beforeStatus],
      [plan.expected.graph.title, plan.expected.graph.afterStatus],
    );
    await open('dispatch-queue');
    await mountedWriter(
      'queue',
      [plan.expected.queue.label, `Priority ${plan.expected.queue.priority}`],
      [plan.expected.queue.label, `Priority ${plan.expected.queue.afterPriority}`],
    );
    await open('pr-automation');
    const prScreen = await view(
      'pr-read-only',
      ['PR monitoring and reviews', 'Monitors'],
      ['Reconnect to the gateway'],
    );
    assert(
      !prScreen.nodes.some((node) => node.identifier === 'companion-pr-error'),
      'A PR read error cannot count as proof',
    );
    await currentMemory('d07-pr-canonical-readiness.json', [
      'prWatch.list',
      'prRules.list',
      'prPush.list',
    ]);
    await open('copilot');
    await view('copilot-read-only', ['Operator Co-Pilot', 'Co-Pilot is stopped']);
    await currentMemory('d07-copilot-canonical-readiness.json', ['copilot.status']);
    const warmCounts = await counts();
    const warm = await sqlite('d07-warm');
    assertPlanningReadsFromRuntime(warm.state, warmCounts, [
      ...observedMemoryMethods,
      'dispatch.queue.list',
      'config.projects',
      'backlog.list',
      'roadmap.list',
      'workGraph.list',
    ]);
    unchangedCommands(initial, warmCounts);
    const retained = retainedPlanningRows(warm.result);
    for (const row of Object.values(retained)) {
      const method = row.id.slice(0, row.id.indexOf(':'));
      assert.equal(
        digest(JSON.stringify(row.data)),
        warmCounts.lastObservedReads[method]?.payloadSha256,
        `Stored ${method} must match the actual app's successful observed reply`,
      );
    }
    assert(
      retained.backlog.data.items.some(
        (item) =>
          item.id === plan.expected.backlog.id &&
          item.title === plan.expected.backlog.after &&
          item.status === 'candidate',
      ),
    );
    assert(
      retained.roadmap.data.items.some(
        (item) =>
          item.id === plan.expected.roadmap.id && item.title === plan.expected.roadmap.after,
      ),
    );
    assert(retained.projects.data.projects.some((project) => project.name === plan.addedProject));
    assert(
      retained.queue.data.items.some(
        (item) =>
          item.id === plan.expected.queue.id && item.priority === plan.expected.queue.afterPriority,
      ),
    );
    assert(
      retained.graph.data.graphs.some(
        ({ graph }) =>
          graph.id === plan.expected.graph.id &&
          graph.title === plan.expected.graph.title &&
          graph.status === plan.expected.graph.afterStatus,
      ),
    );
    await save('d07-observed-methods.json', {
      methods: observedMemoryMethods,
      counts: warmCounts,
      persistedRowsCheckedOnlyForActuallyObservedMethods: true,
    });
    const outage = path.join(process.env.FARMSLOT_NATIVE_STORE_PROXY_DIR, 'outage.json');
    // The external controller owns marker acquisition, service births/signals and restart.
    // These are checkpoints, not fabricated liveness or permission receipts.
    await save('d07-ready-for-outage.json', {
      startId: receipt.startId,
      inputHash: plan.inputHash,
      warmStartedAt: warm.state.startedAt,
    });
    let actuallyOffline = false;
    for (let i = 0; i < 10; i++) {
      let marker;
      try {
        marker = JSON.parse(await readFile(outage, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (marker) {
        assert.equal(marker.startId, receipt.startId);
        assert.equal(marker.inputHash, plan.inputHash);
        const current = await observe();
        if (!current.online) {
          actuallyOffline = true;
          break;
        }
      }
      await delay(250);
    }
    assert(actuallyOffline, 'Controller must perform a proved-owned outage before restart');
    let coldStartedAt;
    {
      await prepareDevClient('ios', simulator, process.env.BUNDLE_ID); // exactly one deliberate restart
      await waitForSimulatorRecipeBridge({ platform: 'ios', simulator });
      await open('backlog');
      let screen = await view('backlog-cold', [plan.expected.backlog.after, 'Saved backlog,']);
      const cold = await sqlite('d07-cold-backlog');
      assert(
        cold.state.startedAt > warm.state.startedAt,
        'A genuinely new JS runtime must load saved rows',
      );
      assert.equal(cold.state.online, false);
      assert.equal(cold.state.connectionProfileId, warm.state.connectionProfileId);
      assert.equal(cold.state.workspaceKey, warm.state.workspaceKey);
      coldStartedAt = cold.state.startedAt;
      const afterRestart = retainedPlanningRows(cold.result);
      assert.deepEqual(
        afterRestart,
        retained,
        'Exact IDs, complete saved data, bytes and original observedAt must survive restart',
      );
      const target = screen.nodes.find((node) => node.identifier === selector);
      assert(target && target.enabled === false, 'Actual stale Mark ready must be AX-disabled');
      // Capture the actual target and its exact paired image immediately before the press.
      screen = await capture('d07-disabled-pair');
      const imageFile = path.join(artifacts, 'd07-disabled-pair.png');
      const ocr = JSON.parse(
        (
          await execute(
            'osascript',
            [
              '-l',
              'JavaScript',
              path.join(source, 'apps/companion/scripts/agentic/recognize-simulator-prompt.jxa'),
              imageFile,
            ],
            { timeout: 30000 },
          )
        ).stdout,
      );
      const point = renderedNativeDisabledTarget(screen, ocr, selector, 'Mark ready');
      assert(has(screen, 'Saved backlog,'));
      const press = {
        inputHash: plan.inputHash,
        screenshotSha256: digest(await readFile(imageFile)),
        point,
        selector,
        ocr,
        startedAt: Date.now(),
        videoAuditRequired: true,
      };
      const beforeTap = await counts();
      await device.interactions.press({ ...selection, ...point });
      press.completedAt = Date.now();
      await save('d07-disabled-target-press.json', press);
      await view('backlog-after-disabled-tap', [plan.expected.backlog.after, 'Saved backlog,']);
      unchangedCommands(beforeTap, await counts());
      await open('roadmap');
      await view('roadmap-cold', [plan.expected.roadmap.after, 'Saved roadmap,']);
      await open('backlog/create');
      await view('projects-cold', [plan.addedProject]);
      // Existing form's Saved projects caption is below its sections. Bounded observed-viewport navigation.
      let previous;
      let ageVisible = false;
      for (let i = 0; i < 6; i++) {
        const current = await capture(`projects-cold-age-${i}`);
        if (has(current, 'Saved projects,')) {
          ageVisible = true;
          break;
        }
        const content = JSON.stringify(
          current.nodes
            .filter((node) => node.visibleToUser !== false)
            .map(({ label, rect }) => ({ label, rect })),
        );
        assert.notEqual(content, previous, 'No progress during saved-age navigation');
        previous = content;
        const gesture = nativeScrollViewGesture(current, 'down');
        await save(`projects-cold-age-${i}.gesture.json`, gesture);
        await device.interactions.swipe({ ...selection, ...gesture });
      }
      assert(ageVisible, 'Current product must visibly render saved projects age');
      await open('work-graphs');
      await view('work-graphs-cold', [
        plan.expected.graph.title,
        plan.expected.graph.afterStatus,
        'Saved work graphs,',
      ]);
      await open('dispatch-queue');
      await view('dispatch-queue-cold', [
        plan.expected.queue.label,
        `Priority ${plan.expected.queue.afterPriority}`,
        'Saved dispatch queue,',
      ]);
      const finalCold = await sqlite('d07-cold-final');
      assert.deepEqual(retainedPlanningRows(finalCold.result), retained);
      assert.equal(finalCold.state.startedAt, coldStartedAt);
      unchangedCommands(warmCounts, await counts());
    }
    await save('d07-ready-for-recovery.json', {
      startId: receipt.startId,
      inputHash: plan.inputHash,
      coldStartedAt,
    });
    let actuallyRecovered = false;
    for (let i = 0; i < 10; i++) {
      const state = await observe();
      assert.equal(state.startedAt, coldStartedAt);
      if (state.online) {
        actuallyRecovered = true;
        break;
      }
      await delay(250);
    }
    assert(actuallyRecovered, 'Controller must recover its exact gateway without an app relaunch');
    // The parent controller keeps the same passive proxy and exact owned outage marker until recovery.
    await open('backlog');
    await view(
      'backlog-recovered',
      [plan.expected.backlog.after, 'Mark ready'],
      ['Saved backlog,'],
    );
    const recovery = await sqlite('d07-recovery');
    assert.equal(recovery.state.startedAt, coldStartedAt, 'Recovery cannot relaunch the app');
    assert.equal(recovery.state.connectionProfileId, warm.state.connectionProfileId);
    assert.equal(recovery.state.workspaceKey, warm.state.workspaceKey);
    assert.equal(recovery.state.online, true);
    const recovered = retainedPlanningRows(recovery.result);
    for (const key of Object.keys(retained)) {
      assert.deepEqual(recovered[key].data, retained[key].data);
      assert(recovered[key].observedAt >= retained[key].observedAt);
    }
    const commandsAfter = await counts();
    unchangedCommands(warmCounts, commandsAfter);
    await delay(1500);
    unchangedCommands(commandsAfter, await counts());
    await save('d07-proof-result.json', {
      status: 'pass',
      inputHash: plan.inputHash,
      observedMemoryMethods,
      workGraphNativeUi: 'warm-and-cold',
      queueColdUi: 'warm-and-cold',
      independentPressVideoAudit: 'required',
      coldStartedAt,
    });
    process.stdout.write(
      `${JSON.stringify({ d07ExternalMountedChanges: true, d07ColdExactRows: true, d07VisibleSavedAge: true, d07DisabledTapNoReplay: true, d07MemoryOnlyObservedQueries: true })}\n`,
    );
  } catch (error) {
    await save('d07-first-failure.json', {
      name: error.name,
      message: error.message,
      at: Date.now(),
    });
    throw error; // No retry, relaunch, fixture rehash or source repair after consumption.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const phase = process.argv[2];
  if (phase === 'check-import')
    process.stdout.write('D07_IMPORT_ONLY_PASS zero session/device/service calls\n');
  else if (phase === 'dry-preflight')
    process.stdout.write(
      `${JSON.stringify(await resolveNativePlanningInputs(process.env, source), null, 2)}\n`,
    );
  else if (phase === 'prove') await prove();
  else throw new Error('Use check-import, dry-preflight or prove. None may bootstrap a device.');
}
