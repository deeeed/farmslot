import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { recordBrowserProof } from './stable-layout-refetch-proof.mjs';

export function nativePanelFixture(now) {
  const binding = {
    sessionId: 'panel-session',
    executionNodeId: 'panel-node',
    ownerPrincipalId: 'layout-fixture',
    generation: 'panel-generation',
    leaseId: 'panel-lease',
    commandId: 'panel-command',
    acceptedAt: new Date(now).toISOString(),
  };
  const session = {
    id: binding.sessionId,
    executionNodeId: binding.executionNodeId,
    generation: binding.generation,
    ownerPrincipalId: binding.ownerPrincipalId,
    nativeSessionId: 'panel-conversation',
    hostPid: 0,
    runner: 'sample',
    model: 'sample-model',
    accountContextId: 'panel-account',
    cwd: '/workspace/panel-fixture',
    executable: '',
    version: 'fixture',
    mode: 'default',
    accountMode: 'native',
    state: 'idle',
    workerManaged: true,
    workerLeaseId: binding.leaseId,
    capabilities: {
      modes: ['default'],
      streaming: true,
      tools: false,
      approvals: false,
      questions: false,
      interrupt: true,
      resume: false,
    },
  };
  const events = [
    {
      sessionId: session.id,
      generation: session.generation,
      sequence: 1,
      at: new Date(now).toISOString(),
      type: 'command.submitted',
      commandId: binding.commandId,
      text: 'Inspect this retained conversation.',
    },
    {
      sessionId: session.id,
      generation: session.generation,
      sequence: 2,
      at: new Date(now).toISOString(),
      type: 'text.delta',
      commandId: binding.commandId,
      text: 'Retained panel history.',
    },
  ];
  return {
    run: {
      transport: 'native',
      familyId: 'layout-run',
      agentContexts: [
        {
          id: 'panel-worker',
          role: 'primary',
          label: 'Worker',
          runId: 'layout-run',
          slotId: null,
          status: 'working',
          nudgeCount: 0,
          runner: 'sample',
          model: 'sample-model',
          nativeSession: binding,
        },
      ],
    },
    params: {
      sessionId: session.id,
      executionNodeId: session.executionNodeId,
      worker: {
        runId: 'layout-run',
        contextId: 'panel-worker',
        generation: binding.generation,
        leaseId: binding.leaseId,
      },
    },
    advance(revision) {
      events.push({
        sessionId: session.id,
        generation: session.generation,
        sequence: events.length + 1,
        at: new Date().toISOString(),
        type: 'text.delta',
        commandId: binding.commandId,
        text: ` Source revision ${revision}.`,
      });
    },
    page: () => ({
      session,
      events: structuredClone(events),
      cursor: events.length,
      hasMore: false,
      commands: [],
      pendingRequests: [],
      scope: { leaseId: binding.leaseId, startAfter: 0, endAt: events.length, released: false },
    }),
  };
}

export async function proveNativePanel({
  cdp,
  target,
  browserCall,
  emulation,
  transition,
  output,
  save,
  frames,
  viewport,
}) {
  const before = process.env.FARMSLOT_LAYOUT_EXPECT_SHIFT === '1';
  const inspect = () =>
    cdp('eval', target, '--file', path.join(import.meta.dirname, 'probes/native-panel.js'));
  const runtimeErrors = [];
  const onRuntimeEvent = (raw) => {
    const event = JSON.parse(String(raw));
    if (event.method === 'Runtime.exceptionThrown') runtimeErrors.push(event.params);
  };
  emulation.on('message', onRuntimeEvent);
  await browserCall('Runtime.enable');
  async function until(accept, label, timeout = 45_000) {
    const end = Date.now() + timeout;
    let value;
    do {
      value = await inspect();
      if (runtimeErrors.length) {
        await save('runtime-errors', runtimeErrors);
        assert.fail(runtimeErrors[0].exceptionDetails.exception?.description ?? 'Rendering failed');
      }
      if (accept(value)) return value;
      await delay(100);
    } while (Date.now() < end);
    await save('timeout-' + label, value);
    await save('runtime-errors', runtimeErrors);
    assert.fail(label + ': ' + JSON.stringify(value));
  }
  const click = () =>
    cdp('click', target, 'run-detail >>> [data-testid="run-native-history-toggle"]');
  const results = [];
  const expanded = await cdp(
    'eval',
    target,
    "return document.querySelector('farm-app').querySelector('.fa-nav-toggle')?.title === 'Collapse sidebar';",
  );
  if (expanded) await cdp('click', target, '.fa-nav-toggle');
  await cdp('eval', target, "location.hash='run/layout-run'; return true;");
  for (const width of [1280, 414]) {
    await viewport(width);
    await until((v) => v.runLoaded, 'run-loaded');
    if (!before) {
      const closed = await until((v) => v.expanded === false && v.views === 0, 'closed-default');
      await save(width + '-collapsed', closed);
    }
    const samples = [];
    await recordBrowserProof({
      name: `native-panel-${before ? 'before' : 'after'}-${width}`,
      browserCall,
      emulation,
      output,
      save,
      run: async () => {
        if (!before) await click();
        await until((v) => v.history.includes('Retained panel history.'), 'history-open');
        await cdp(
          'eval',
          target,
          "const app=document.querySelector('farm-app');const root=(app.shadowRoot??app).querySelector('run-detail').shadowRoot;root.querySelector('native-worker-history').scrollIntoView({block:'center'});return true;",
        );
        const modeSample = async (mode, accept) => {
          const expected = transition(mode);
          const value = await until(
            (v) =>
              frames.some((f) => f.method === 'native.session.read' && f.revision === expected) &&
              (mode !== 'native-ready' || v.history.includes(`Source revision ${expected}.`)) &&
              accept(v),
            mode,
          );
          samples.push({ mode, revision: expected, ...value });
          await save(`${width}-${mode}-${samples.length}`, value);
          return value;
        };
        const ready = await modeSample('native-ready', (v) =>
          v.history.includes('Source revision'),
        );
        const baseline = ready.timelineTop;
        const offset = ready.timelineOffset;
        for (const mode of ['native-error', 'native-ready', 'native-changed', 'native-ready']) {
          const value = await modeSample(mode, (v) =>
            mode === 'native-error'
              ? before
                ? v.errors.some((e) => e.includes('Native observation source'))
                : v.readState === 'reconnecting'
              : mode === 'native-changed'
                ? v.status.includes('Refreshing history')
                : v.status.includes(before ? 'idle' : 'Live'),
          );
          assert(value.history.includes('Retained panel history.'), 'Loaded history must survive');
          if (!before) {
            assert.equal(value.timelineOffset, offset, 'The status must not move its timeline');
            assert.equal(value.timelineTop, baseline, 'A read status must not move history');
            assert.equal(value.statusHeight, 56);
            assert(value.statusVisible, 'The status must be visible in the recording');
            assert(!value.errors.some((e) => /observation source|source recovery/i.test(e)));
            if (mode === 'native-error') {
              assert.equal(value.observedAt, ready.observedAt);
              assert(value.age.includes('Saved conversation history'));
              assert(value.inputDisabled, 'Failed reads must keep input disabled');
            }
          }
        }
        if (!before && width === 1280) {
          await modeSample('native-error', (v) => v.readState === 'reconnecting');
          const failedRevision = samples.at(-1).revision;
          const failedAt = frames.find(
            (frame) => frame.method === 'native.session.read' && frame.revision === failedRevision,
          ).at;
          const aged = await until(
            (v) => v.readState === 'unavailable',
            'sustained-outage',
            75_000,
          );
          const outageMs = Date.now() - failedAt;
          assert(outageMs >= 60_000, 'Unavailable must wait for 60 seconds of actual outage');
          assert.equal(aged.timelineTop, baseline);
          assert.equal(aged.timelineOffset, offset);
          assert(
            aged.retry && aged.inputDisabled,
            'A real failed read stays fail-closed with Retry',
          );
          samples.push({ mode: 'sustained-outage', outageMs, ...aged });
          const retryMark = frames.length;
          await cdp(
            'click',
            target,
            'run-detail >>> native-worker-history >>> native-session-view >>> [data-testid="native-refresh"]',
          );
          await until(
            () => frames.slice(retryMark).some((frame) => frame.method === 'native.session.read'),
            'explicit-retry-read',
            5_000,
          );
          await modeSample('native-ready', (v) => v.status.includes('Live'));
          assert.equal((await inspect()).timelineOffset, offset);
        }
        const image = await browserCall('Page.captureScreenshot', { format: 'png' });
        await writeFile(
          path.join(output, `native-panel-${before ? 'before' : 'after'}-${width}.png`),
          Buffer.from(image.data, 'base64'),
        );
      },
    });
    if (before)
      assert(
        new Set(samples.map((s) => s.timelineTop)).size > 1,
        'Original status rows must reproduce the movement',
      );
    else {
      const opened = await inspect();
      await browserCall('Page.reload');
      const restored = await until(
        (v) =>
          v.timeOrigin !== opened.timeOrigin &&
          v.expanded &&
          v.views === 1 &&
          v.history.includes('Retained panel history.'),
        'remember-open',
      );
      await save(`${width}-remember-open`, restored);
      await click();
      const closed = await until((v) => v.expanded === false && v.views === 0, 'close-history');
      await browserCall('Page.reload');
      const remainedClosed = await until(
        (v) =>
          v.timeOrigin !== closed.timeOrigin &&
          v.runLoaded &&
          v.expanded === false &&
          v.views === 0,
        'remember-closed',
      );
      await save(`${width}-remember-closed`, remainedClosed);
    }
    results.push({ width, samples });
  }
  assert(
    !frames.some(
      (f) =>
        f.method.startsWith('native.') &&
        !['native.session.read', 'native.session.list', 'native.session.catalog'].includes(
          f.method,
        ),
    ),
    'The proof may only read native facts',
  );
  await save('native-panel-result', {
    result: 'PASS',
    before,
    results,
    limit:
      'Mounted observed-WebSocket presentation proof; no native host, worker, device, provider or gateway activation.',
  });
  assert.deepEqual(runtimeErrors, [], 'No uncaught rendering errors');
  emulation.off('message', onRuntimeEvent);
}
