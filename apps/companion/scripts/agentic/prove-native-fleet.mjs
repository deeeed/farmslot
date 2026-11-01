// One bounded AC4 case. Uses an already-running app, device session, node and private gateway.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveFleetInputs, sourceRoot } from './native-fleet-fixture.mjs';
import { nativeScrollViewGesture } from './native-store-fixture.mjs';

const phase = process.argv[2];
if (phase === 'dry-preflight') {
  try {
    process.stdout.write(`${JSON.stringify(await resolveFleetInputs(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
} else if (phase === 'prove') await prove();
else
  throw new Error(
    'Use dry-preflight or prove. This helper never starts or restarts an app/service/device.',
  );

async function prove() {
  const plan = await resolveFleetInputs();
  assert(process.env.FARMSLOT_NATIVE_AC4_PLAN, 'Save dry-preflight output before execution');
  const checked = JSON.parse(await readFile(process.env.FARMSLOT_NATIVE_AC4_PLAN, 'utf8'));
  assert.equal(
    checked.inputHash,
    plan.inputHash,
    'Checked inputs drifted; stop before device attachment',
  );
  const attemptFile = path.join(plan.artifacts, `native-ac4-attempt-${plan.inputHash}.json`);
  const attempt = { inputHash: plan.inputHash, startedAt: Date.now(), status: 'consumed' };
  await writeFile(attemptFile, JSON.stringify(attempt), { flag: 'wx', mode: 0o600 });
  const save = (name, value) =>
    writeFile(path.join(plan.artifacts, name), `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
  let last, device, selection;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { setTimeout: delay } = await import('node:timers/promises');
    const execute = promisify(execFile);
    const { createAgentDeviceClient } = await import('agent-device');
    const { confirmSimulatorURLPrompt } = await import('./simulator-dev-client.mjs');
    device = createAgentDeviceClient({ stateDir: plan.stateDir });
    const sessions = (await device.sessions.list()).filter(
      (session) => session.device.id === plan.simulator,
    );
    assert.equal(sessions.length, 1, 'Reuse exactly one root-owned existing iOS SDK session');
    selection = { session: sessions[0].name, platform: 'ios', target: 'mobile' };
    const f = plan.fixture;
    const readCounts = async () => {
      const response = await fetch(`http://127.0.0.1:${plan.proxyPort}/native-store-proof-counts`, {
        signal: AbortSignal.timeout(3000),
      });
      assert(response.ok, 'Existing redacted passive proxy is unavailable');
      const counts = await response.json();
      assert.equal(counts.startId, plan.proxyStartId);
      assert(!counts.failure && !counts.stopped);
      return counts;
    };
    const initialCounts = await readCounts();
    async function rpc(method, params = {}) {
      const { stdout } = await execute(
        process.execPath,
        [
          path.join(sourceRoot, 'apps/command-center/scripts/cdp.mjs'),
          'gateway',
          method,
          JSON.stringify(params),
        ],
        {
          cwd: sourceRoot,
          env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: '10000' },
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        },
      );
      return JSON.parse(stdout);
    }
    const nodeBefore = (await rpc('nodes.list')).nodes.find((node) => node.machine === f.machine);
    assert(
      nodeBefore && nodeBefore.pid === plan.nodePid,
      'Require the root-supervised actual registered node',
    );
    const nodeSame = async () => {
      const node = (await rpc('nodes.list')).nodes.find((entry) => entry.machine === f.machine);
      assert.deepEqual(
        node && { machine: node.machine, pid: node.pid, connectedAt: node.connectedAt },
        { machine: nodeBefore.machine, pid: nodeBefore.pid, connectedAt: nodeBefore.connectedAt },
        'Do not accept a replaced/disconnected node',
      );
    };
    let samples = 0;
    async function observe(kind = 'slot') {
      const response = await fetch(`http://127.0.0.1:${plan.metroPort}/farmslot-recipe/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(6000),
        body: JSON.stringify({
          command: 'observeUi',
          nodeId: 'native-ac4-open-panel',
          payload: { refs: [`runs-cache:${kind}:${f.runId}`] },
          timeout_ms: 3000,
        }),
      });
      if (response.status === 504) return undefined; // no bridge sample, never a successful state
      assert(response.ok, `Read-only bridge HTTP ${response.status}`);
      const reply = await response.json();
      assert(reply.ok, 'App observation refused');
      last = reply.observations.runCollections;
      await save(`observe-${String(++samples).padStart(4, '0')}.json`, last);
      assert.equal(last.platform, 'ios');
      assert.equal(last.nativeAc4?.version, 1, 'Separate dev-proof frame patch is required');
      return last;
    }
    async function until(predicate, label, kind = 'slot') {
      const deadline = Date.now() + 12000;
      do {
        const state = await observe(kind);
        if (state && predicate(state)) return state;
        const read =
          kind === 'slot-diff'
            ? state?.nativeAc4?.diff?.observation
            : state?.nativeAc4?.progress?.observation;
        // Source fences can briefly refuse reads while their next change notification is pending.
        // Observe recovery within this same deadline; never issue a proof-side Retry or refetch.
        const sourceUpdating = [
          'RESOURCE_OBSERVATION_UNAVAILABLE',
          'RESOURCE_OBSERVATION_CHANGED',
          'RESOURCE_SOURCE_UNAVAILABLE',
          'RESOURCE_SOURCE_CHANGED',
        ].includes(read?.error?.code);
        if (read?.status === 'unsupported' || (read?.status === 'error' && !sourceUpdating))
          assert.fail(`${label}: ${read.error?.code ?? read.status}`);
        await delay(100);
      } while (Date.now() < deadline);
      assert.fail(label);
    }
    async function snapshot(name) {
      const screen = await device.capture.snapshot({
        ...selection,
        interactiveOnly: false,
        forceFull: true,
      });
      await save(`${name}.snapshot.json`, screen); // always save before any visible assertion
      await device.capture.screenshot({
        ...selection,
        path: path.join(plan.artifacts, `${name}.png`),
        stabilize: true,
      });
      return screen;
    }
    const nodeVisible = (screen, node) => {
      if (node.visibleToUser === false) return false;
      const viewport = screen.nodes.find(
        (item) =>
          ['Application', 'Window'].includes(item.type) &&
          item.rect?.width > 0 &&
          item.rect?.height > 0,
      )?.rect;
      if (!viewport || !node.rect) return node.visibleToUser === true;
      const x = node.rect.x + node.rect.width / 2,
        y = node.rect.y + node.rect.height / 2;
      return (
        node.rect.width > 0 &&
        node.rect.height > 0 &&
        x >= viewport.x &&
        y >= viewport.y &&
        x < viewport.x + viewport.width &&
        y < viewport.y + viewport.height
      );
    };
    const visible = (screen, text) =>
      screen.nodes.some(
        (node) =>
          nodeVisible(screen, node) && `${node.label || ''} ${node.value || ''}`.includes(text),
      );
    async function show(name, labels, allowScroll) {
      for (let index = 0; index < (allowScroll ? 14 : 5); index++) {
        const screen = await snapshot(`${name}-${index}`);
        if (labels.every((label) => visible(screen, label))) return screen;
        if (allowScroll)
          await device.interactions.swipe({
            ...selection,
            ...nativeScrollViewGesture(screen, 'down'),
          });
        else await delay(150);
      }
      assert.fail(`Actual visible panel did not show ${name}`);
    }
    const open = async (route) => {
      await execute('xcrun', ['simctl', 'openurl', plan.simulator, route], { timeout: 15000 });
      await confirmSimulatorURLPrompt(plan.simulator);
    };
    const writer = async (kind) => {
      // The node is on this same host. This independent subprocess changes only its owned source files.
      const { stdout } = await execute(
        process.execPath,
        [
          path.join(sourceRoot, 'apps/companion/scripts/agentic/native-fleet-fixture.mjs'),
          'write',
          kind,
          plan.fixturePath,
        ],
        { cwd: sourceRoot, timeout: 20000, maxBuffer: 1024 * 1024 },
      );
      const receipt = JSON.parse(stdout);
      assert.equal(receipt.status, 'committed');
      assert.equal(receipt.runId, f.runId);
      await save(`writer-${kind}.json`, receipt);
      return receipt;
    };
    const advanced = (before, after, family) => {
      assert(
        before?.resourceState?.epoch && before.resourceState.epoch === after?.resourceState?.epoch,
        'Same real gateway epoch required',
      );
      const keys = (after.resourceState.dependencies ?? []).filter(
        (dep) => dep.key.family === family,
      );
      assert(
        keys.some((dep) =>
          (before.resourceState.dependencies ?? []).some(
            (old) =>
              JSON.stringify(old.key) === JSON.stringify(dep.key) && dep.revision > old.revision,
          ),
        ),
        `Actual ${family} revision must advance`,
      );
    };
    const slotReady = (state) =>
      state.online &&
      state.fleet.status === 'ready' &&
      state.fleet.canonical &&
      state.fleet.projectionMatches &&
      state.nativeAc4?.focused &&
      state.nativeAc4.slotCanonical &&
      state.nativeAc4.slotId === f.slotId &&
      state.nativeAc4.runId === f.runId;
    const progressReady = (state) =>
      slotReady(state) &&
      state.nativeAc4.progress?.canonical &&
      state.nativeAc4.progress.observation.status === 'ready' &&
      state.nativeAc4.progress.shown;
    const diffReady = (state) =>
      slotReady(state) &&
      state.nativeAc4.diff?.canonical &&
      state.nativeAc4.diff.observation.status === 'ready';
    const samePanel = (before, after) => {
      assert.equal(after.startedAt, before.startedAt);
      assert.equal(after.connectionGeneration, before.connectionGeneration);
      assert.equal(after.connectionProfileId, before.connectionProfileId);
      assert.equal(after.nativeAc4.focused, true);
    };

    await open(plan.slotRoute);
    const slotBefore = await until(
      (state) => slotReady(state) && state.nativeAc4.slot.branch === f.beforeBranch,
      'Open slot baseline was not current',
    );
    await show('slot-before', [f.slotId, f.beforeBranch], false);
    await writer('branch'); // actual .git/HEAD write, watched by the registered private node
    const slotAfter = await until(
      (state) => slotReady(state) && state.nativeAc4.slot.branch === f.afterBranch,
      'Real node HEAD push did not reach the still-open slot without Refresh',
    );
    samePanel(slotBefore, slotAfter);
    advanced(slotBefore.fleet, slotAfter.fleet, 'slots');
    await show('slot-after-node-head', [f.slotId, f.afterBranch], false);
    await nodeSame();
    await save('slot-node-result.json', {
      nativeNodeSlotPush: true,
      before: slotBefore,
      after: slotAfter,
    });

    const progressBefore = await until(
      (state) => progressReady(state) && state.nativeAc4.progress.rendered?.completedSteps === 0,
      'Open actual checklist baseline was not current',
    );
    await show('progress-before', ['AC4 first source mark', '0/2'], true);
    const marked = await writer('progress'); // task's real mark writes both CHECKLIST.md and SIGNAL.json
    const progressAfter = await until(
      (state) =>
        progressReady(state) &&
        state.nativeAc4.progress.rendered?.completedSteps === 1 &&
        state.nativeAc4.progress.rendered.timing?.events.some(
          (event) => event.stepNumber === 1 && event.checkedAt === marked.data.mark.checkedAt,
        ),
      'Real checklist/signal mark did not reach the still-open progress panel',
    );
    samePanel(progressBefore, progressAfter);
    advanced(
      progressBefore.nativeAc4.progress.observation,
      progressAfter.nativeAc4.progress.observation,
      'progress',
    );
    assert.equal(progressAfter.nativeAc4.progress.query.method, 'task.progress');
    const progressScreen = await show(
      'progress-after-mark',
      ['AC4 first source mark', '1/2'],
      false,
    );
    assert(
      progressScreen.nodes.some(
        (node) =>
          node.identifier === 'checklist-duration' &&
          nodeVisible(progressScreen, node) &&
          (node.label || node.value),
      ),
      'The actual marked-step timing must also render',
    );
    const actualProgress = await rpc(
      'task.progress',
      progressAfter.nativeAc4.progress.query.params,
    );
    assert.equal(actualProgress.structured.completedSteps, 1);
    assert(
      actualProgress.structured.timing.events.some(
        (event) => event.checkedAt === marked.data.mark.checkedAt,
      ),
    );
    await nodeSame();
    await save('progress-result.json', {
      nativeTaskMarkPush: true,
      writer: marked,
      before: progressBefore,
      after: progressAfter,
    });

    await open(plan.diffRoute);
    const diffBefore = await until(
      (state) => diffReady(state) && state.nativeAc4.diff.text.includes('AC4_GIT_BEFORE'),
      'Open slotted Git baseline failed; retain actual route error, do not substitute a frozen or unbound diff',
      'slot-diff',
    );
    assert.equal(
      diffBefore.nativeAc4.diff.query.params.slotId,
      f.slotId,
      'Live diff must address its actual slot',
    );
    assert.equal(
      diffBefore.nativeAc4.diff.query.params.runId,
      f.runId,
      'Observed slot diffs must retain the current run ownership pin',
    );
    await show('git-before', ['AC4_GIT_BEFORE'], true);
    await writer('git');
    const diffAfter = await until(
      (state) =>
        diffReady(state) &&
        state.nativeAc4.diff.text.includes('AC4_GIT_AFTER') &&
        !state.nativeAc4.diff.text.includes('AC4_GIT_BEFORE'),
      'Real workspace write did not reach the still-open Git panel',
      'slot-diff',
    );
    samePanel(diffBefore, diffAfter);
    advanced(
      diffBefore.nativeAc4.diff.observation,
      diffAfter.nativeAc4.diff.observation,
      'workspace',
    );
    assert.equal(diffAfter.nativeAc4.diff.query.method, 'git.diff');
    // This independent RPC is unmarked, so runId would select frozen-review semantics.
    const actualDiff = await rpc('git.diff', { slotId: f.slotId });
    assert.equal(actualDiff.diff, diffAfter.nativeAc4.diff.text);
    await show('git-after', ['AC4_GIT_AFTER'], false);
    await nodeSame();
    await save('git-result.json', { nativeGitPush: true, before: diffBefore, after: diffAfter });
    const finalCounts = await readCounts();
    for (const method of [
      'fleet.refresh',
      'slot.refresh',
      'slot.softRefresh',
      'slot.autoRefresh',
      'slot.check',
      'native.session.create',
      'native.session.ensure',
      'native.session.send',
      'native.session.respond',
      'native.session.close',
      'native.session.interrupt',
      'native.session.cancel',
    ])
      assert.equal(
        finalCounts.counts[method] || 0,
        initialCounts.counts[method] || 0,
        `No ${method} is permitted`,
      );
    for (const method of ['fleet.status', 'task.progress', 'git.diff'])
      assert(
        (finalCounts.counts[method] || 0) > (initialCounts.counts[method] || 0),
        `Real app must traverse the existing counted proxy for ${method}`,
      );
    await save('passive-counts.json', { before: initialCounts, after: finalCounts });
    attempt.status = 'passed';
    process.stdout.write(
      `${JSON.stringify({ nativeNodeSlotPush: true, nativeTaskMarkPush: true, nativeGitPush: true, nativeSlottedDiffRoute: true, nativeAc4NoRefresh: true, inputHash: plan.inputHash })}\n`,
    );
  } catch (error) {
    attempt.status = 'failed';
    attempt.failure = error.code || error.name;
    if (error.code === 'ERR_ASSERTION') attempt.assertion = error.message;
    await save('failure.json', { ...attempt, last });
    if (device && selection) {
      try {
        const screen = await device.capture.snapshot({
          ...selection,
          interactiveOnly: false,
          forceFull: true,
        });
        await save('failure.snapshot.json', screen);
        await device.capture.screenshot({
          ...selection,
          path: path.join(plan.artifacts, 'failure.png'),
          stabilize: true,
        });
      } catch (captureError) {
        await save('failure-capture.json', { failure: captureError.code || captureError.name });
      }
    }
    throw new Error(
      'AC4 proof stopped. Preserve its consumed attempt, actual observations, writer receipts and screenshots for root disposition.',
    );
  } finally {
    attempt.finishedAt = Date.now();
    await writeFile(attemptFile, JSON.stringify(attempt, null, 2), { mode: 0o600 });
    // Keep every source/failure artifact. Root stops its node/gateway before any scratch teardown.
  }
}
