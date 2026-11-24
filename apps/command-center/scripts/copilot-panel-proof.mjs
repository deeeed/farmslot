// Co-Pilot reachability proof over the stable-layout protocol fixture. It never starts an agent.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { probeUntil, watchPageErrors } from './proof-until.mjs';

const WIDTH = 1005;
const HEIGHT = 504;

/** A running Co-Pilot bound to the native panel fixture session, with one pending approval. */
export function copilotPanelFixture(now, nativeFixture) {
  const at = new Date(now).toISOString();
  const base = nativeFixture.page();
  const approval = {
    sessionId: base.session.id,
    generation: base.session.generation,
    sequence: base.events.length + 1,
    at,
    type: 'approval.requested',
    request: {
      // Unique per proof: the view remembers answered requests in browser storage.
      id: `copilot-approval-${now}`,
      title: 'Run cat docs/bootstrap.md',
      detail: 'cat docs/bootstrap.md',
    },
    data: { command: 'cat docs/bootstrap.md' },
  };
  const responses = [];
  const launch = {
    runner: 'sample',
    model: 'sample-model',
    safetyTier: 'sandboxed',
    checkout: '/workspace/panel-fixture',
    branch: 'main',
    head: 'a'.repeat(40),
    dirtyFileCount: 0,
  };
  const runtime = {
    runtimeId: 'gateway-copilot',
    status: 'running',
    nativeSession: { sessionId: base.session.id, executionNodeId: base.session.executionNodeId },
    runner: launch.runner,
    model: launch.model,
    autostart: false,
    safetyTier: launch.safetyTier,
    checkout: {
      path: launch.checkout,
      branch: launch.branch,
      head: launch.head,
      dirtyFileCount: 0,
    },
    workload: {
      severity: 'low',
      totals: { total: 0 },
      hosts: [],
      policy: {
        singleton: true,
        automaticCancellation: false,
        automaticDispatch: false,
        automaticFanOut: false,
      },
    },
    lastDelivery: { id: 'copilot-delivery', state: 'accepted', requestedAt: at, settledAt: at },
    startedAt: at,
    updatedAt: at,
    dangerousLaunch: {
      ...launch,
      typedPhrase: 'ENABLE DANGEROUS CO-PILOT',
      warning: 'Fixture warning',
      fingerprint: 'fixture',
    },
  };
  const page = () => {
    const current = nativeFixture.page();
    return {
      ...current,
      session: {
        ...current.session,
        workerManaged: false,
        capabilities: { ...current.session.capabilities, approvals: true },
      },
      pendingRequests: responses.length ? [] : [approval],
    };
  };
  return {
    responses,
    requestId: approval.request.id,
    values: {
      'copilot.status': () => ({ session: runtime }),
      'chat.sessions': () => ({ sessions: [] }),
      'native.session.read': page,
      // Co-Pilot reads its conversation through the stream; the reset frame carries the same page.
      'native.session.subscribe': () => {
        const snapshot = page();
        return {
          subscriptionId: 'copilot-subscription',
          kind: 'reset',
          cursor: {
            sessionId: snapshot.session.id,
            executionNodeId: snapshot.session.executionNodeId,
            hostGeneration: 'fixture-host',
            generation: snapshot.session.generation,
            sequence: snapshot.cursor,
          },
          snapshot: { ...snapshot, historyBefore: 0, truncated: false },
        };
      },
      'native.session.unsubscribe': () => ({ ok: true }),
      'native.session.list': () => ({ sessions: [page().session] }),
      'native.session.respond': (params) => {
        responses.push(params);
        return { ok: true };
      },
    },
  };
}

/**
 * At Arthur's 1005x504 window with Co-Pilot settings open, the pending approval scrolls into view
 * inside the content box with its title readable, Approve is the element under its own centre,
 * neither is covered by the status row or transfer bar, and a real click reaches the gateway.
 */
export async function proveCopilotPanel({
  cdp,
  target,
  browserCall,
  emulation,
  broadcast,
  output,
  save,
  frames,
  fixture,
}) {
  const before = process.env.FARMSLOT_LAYOUT_EXPECT_SHIFT === '1';
  const inspect = () =>
    cdp('eval', target, '--file', path.join(import.meta.dirname, 'probes/copilot-panel.js'));
  const pageErrors = await watchPageErrors({ emulation, browserCall });
  const until = probeUntil({ inspect, save, errors: pageErrors.errors, prefix: 'copilot-' });
  await browserCall('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // A running transfer from the gateway gives the docked transfer bar real height.
  broadcast('file.transfer.progress', {
    transferId: 'copilot-transfer',
    path: '/workspace/panel-fixture/after.mp4',
    label: 'after.mp4',
    phase: 'mirror',
    bytesTransferred: 20_000_000,
    totalBytes: 50_000_000,
    state: 'running',
  });
  await until((v) => v.transferHeight > 0, 'transfer-rendered');
  await cdp('eval', target, "location.hash='copilot?panels=copilot-settings'; return true;");
  const loaded = await until((v) => v.settingsOpen && v.approve, 'approval-rendered');
  // The new request scrolls itself into view; give the smooth layout one settle period.
  await delay(500);
  const value = await inspect();
  const shot = await browserCall('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
  });
  await writeFile(
    path.join(output, `copilot-${before ? 'before' : 'after'}-${WIDTH}x${HEIGHT}.png`),
    Buffer.from(shot.data, 'base64'),
  );
  await save(`copilot-${before ? 'before' : 'after'}-${WIDTH}x${HEIGHT}`, { loaded, value });
  const reachable =
    value.viewport.width === WIDTH &&
    value.viewport.height === HEIGHT &&
    value.approveInsideContent &&
    value.approveHit &&
    value.titleHit &&
    !value.overlaysCoverContent;
  if (before) {
    assert(!reachable, 'The original layout must reproduce the unreachable approval');
    pageErrors.stop();
    await save('copilot-result', { result: 'PASS', expected: 'unreachable approval', value });
    return;
  }
  assert(value.approveInsideContent, 'Approve must be inside the visible content box');
  assert(value.approveHit, 'Approve must be the element under its own centre');
  assert(value.titleHit, 'The request title must be visible beside its Approve button');
  assert(!value.overlaysCoverContent, 'The status row and transfer bar must not cover content');
  assert(value.transferHeight > 0, 'The transfer bar must be on screen for the overlap check');
  await cdp('click', target, 'native-session-view >>> [data-testid="native-approve"]');
  await until(() => fixture.responses.length > 0, 'approve-delivered', 10_000);
  assert.equal(fixture.responses[0].decision, 'approve');
  assert.equal(fixture.responses[0].requestId, fixture.requestId);
  pageErrors.stop();
  assert.deepEqual(pageErrors.errors, [], 'No uncaught rendering errors');
  await save('copilot-result', {
    result: 'PASS',
    value,
    response: fixture.responses[0],
    respondFrames: frames.filter((frame) => frame.method === 'native.session.respond').length,
  });
}
