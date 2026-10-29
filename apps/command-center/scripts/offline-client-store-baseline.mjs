// CDP measurements retain counts and timings, never payloads or credentials.
import assert from 'node:assert/strict';

/** Count real outgoing read frames in a settled page, without retaining payloads. */
export async function observeIdleGatewayReads({ connect, tab, methods, durationMs = 11000 }) {
  assert(
    Array.isArray(methods) &&
      methods.length &&
      methods.every((method) => typeof method === 'string'),
  );
  assert(Number.isSafeInteger(durationMs) && durationMs > 0 && durationMs <= 60000);
  const counts = Object.fromEntries(methods.map((method) => [method, 0]));
  let active = false;
  const client = await connect(tab.webSocketDebuggerUrl, ({ method, params }) => {
    if (!active || method !== 'Network.webSocketFrameSent' || params.response.opcode !== 1) return;
    const raw = params.response.payloadData;
    if (!raw.startsWith('{')) return;
    const frame = JSON.parse(raw);
    if (frame.type === 'req' && Object.hasOwn(counts, frame.method)) counts[frame.method]++;
  });
  const started = performance.now();
  try {
    active = true;
    await client.call('Network.enable');
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    return {
      elapsedMs: Math.round(performance.now() - started),
      counts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    };
  } finally {
    active = false;
    client.close();
  }
}

/**
 * Measure production reads triggered by navigation, reload, or a socket disconnect. On a gateway
 * with version lists, cold and reconnect end at the run list's merged ready state: the first
 * run.list reply is then only the version index, and the rows it lists arrive in `ids` pages.
 */
export async function measureOfflineClientStore({ connect, tab, phase, route, gatewayUrl, match }) {
  assert(
    ['cold', 'reconnect', 'diff', 'gate'].includes(phase),
    'Expected cold, reconnect, diff or gate',
  );
  if (phase === 'gate') return measureGateOpen({ connect, tab, route, match });
  if (phase === 'diff') {
    assert(route, 'Diff measurement requires the real gate route');
    assert(match?.runId || match?.slotId, 'Diff measurement requires its runId or slotId');
  }
  const requests = new Map();
  const sockets = new Map();
  let receivedBytes = 0;
  // Each received frame's time and size, to count bytes through a merged ready state.
  const received = [];
  const pages = [];
  let startedAt;
  let readyAt;
  // The page's wall clock when the measurement began, to tell a new observation from a saved one.
  let startedWall;
  let versionRead = false;
  let armed = false;
  let firstRunList;
  let resolveRead;
  let rejectRead;
  let timer;
  const read = new Promise((resolve, reject) => {
    resolveRead = resolve;
    rejectRead = reject;
  });
  const client = await connect(tab.webSocketDebuggerUrl, ({ method, params }) => {
    if (!armed) return;
    if (method === 'Network.webSocketCreated') sockets.set(params.requestId, params.url);
    if (
      method === 'Network.webSocketFrameError' &&
      sockets.get(params.requestId)?.includes('/ws')
    ) {
      rejectRead(new Error(`Gateway websocket: ${params.errorMessage}`));
      return;
    }
    if (!['Network.webSocketFrameSent', 'Network.webSocketFrameReceived'].includes(method)) return;
    if (params.response.opcode !== 1) return;
    const raw = params.response.payloadData;
    // Vite also has a websocket; it does not carry gateway request/response frames.
    if (!raw.startsWith('{')) return;
    const frame = JSON.parse(raw);
    const key = `${params.requestId}:${frame.id}`;
    if (method === 'Network.webSocketFrameSent' && frame.type === 'req') {
      const wanted =
        phase === 'diff'
          ? frame.method === 'git.diff' &&
            Object.entries(match).every(([name, value]) => frame.params?.[name] === value)
          : frame.method === 'run.list';
      if (frame.method === 'run.list' && frame.params?.versions === true) versionRead = true;
      if (wanted)
        requests.set(key, {
          method: frame.method,
          timestamp: params.timestamp,
          inventory: !frame.params?.active,
          page: Array.isArray(frame.params?.ids),
        });
    } else if (
      method === 'Network.webSocketFrameReceived' &&
      ['res', 'event'].includes(frame.type)
    ) {
      const bytes = Buffer.byteLength(raw, 'utf8');
      receivedBytes += bytes;
      received.push({ at: params.timestamp, bytes });
      const request = requests.get(key);
      if (frame.type !== 'res' || !request) return;
      requests.delete(key);
      if (frame.error || frame.ok === false) {
        rejectRead(new Error(`${request.method} failed: ${frame.error?.code ?? 'unknown'}`));
        return;
      }
      if (request.page) {
        pages.push({ at: params.timestamp, bytes });
        return;
      }
      if (phase !== 'diff') {
        firstRunList ??= { at: params.timestamp, responseBytes: bytes };
        if (!request.inventory) return;
      }
      resolveRead({
        method: request.method,
        responseAt: params.timestamp,
        requestAt: request.timestamp,
        responseBytes: bytes,
        receivedBytes,
        // A version reply lists every live run and carries no rows.
        runCount: frame.payload?.versions?.length ?? frame.payload?.runs?.length,
      });
    }
  });
  const trigger = async () => {
    await client.call('Page.enable');
    await client.call('Network.enable');
    await client.call('Performance.enable');
    const metrics = await client.call('Performance.getMetrics');
    startedAt = metrics.metrics.find(({ name }) => name === 'Timestamp').value;
    armed = true;
    timer = setTimeout(() => rejectRead(new Error('Timed out waiting for gateway read')), 30_000);
    if (phase === 'cold') {
      const wall = await client.call('Runtime.evaluate', {
        expression: 'Date.now()',
        returnByValue: true,
      });
      startedWall = wall.result.value;
      await client.call('Page.reload', { ignoreCache: true });
    } else if (phase === 'diff') {
      const url = new URL(tab.url);
      url.hash = route;
      await client.call('Page.navigate', { url: url.href });
    } else {
      // Closing a real socket exercises automatic transport recovery. Querying native objects
      // avoids adding a debug global or modifying application data or connection settings.
      await client.call('Runtime.enable');
      const prototype = await client.call('Runtime.evaluate', {
        expression: 'WebSocket.prototype',
      });
      const sockets = await client.call('Runtime.queryObjects', {
        prototypeObjectId: prototype.result.objectId,
        objectGroup: 'offline-store-baseline',
      });
      const closed = await client.call('Runtime.callFunctionOn', {
        objectId: sockets.objects.objectId,
        functionDeclaration: `function(gatewayUrl) {
          let count = 0;
          const closedAt = performance.now();
          const closedWall = Date.now();
          for (const socket of this) {
            if (socket.readyState !== WebSocket.OPEN) continue;
            if (new URL(socket.url).pathname !== '/ws' && socket.url !== gatewayUrl) continue;
            socket.close(1000, 'Reconnect measurement');
            count++;
          }
          return {count, closedAt, closedWall};
        }`,
        arguments: [{ value: gatewayUrl }],
        returnByValue: true,
      });
      assert(
        !closed.exceptionDetails && closed.result.value?.count > 0,
        'No live gateway socket found',
      );
      startedAt =
        metrics.metrics.find(({ name }) => name === 'NavigationStart').value +
        closed.result.value.closedAt / 1000;
      startedWall = closed.result.value.closedWall;
    }
  };
  try {
    const [, result] = await Promise.all([trigger(), read]);
    const after = await client.call('Performance.getMetrics');
    const navigationStart = after.metrics.find(({ name }) => name === 'NavigationStart').value;
    if (phase === 'cold') startedAt = navigationStart;
    // An older gateway ends at its one full reply, exactly as the D07 baseline measured.
    const merged = (phase === 'cold' || phase === 'reconnect') && versionRead;
    if (merged) {
      // The cache stamps observedAt when the catch-up merge completes; the page's time origin maps
      // that wall time onto the navigation's CDP clock.
      const ready = await client.call('Runtime.evaluate', {
        expression: RUN_LIST_READY_AFTER(startedWall),
        awaitPromise: true,
        returnByValue: true,
      });
      assert(
        !ready.exceptionDetails,
        ready.exceptionDetails?.exception?.description ?? 'The run list did not become ready',
      );
      readyAt =
        navigationStart + (ready.result.value.observedAt - ready.result.value.timeOrigin) / 1000;
    }
    assert(result.responseAt >= startedAt, 'Read predates this measurement');
    if (merged) assert(readyAt >= result.responseAt, 'The run list was ready before its read');
    const destination = await client.call('Runtime.evaluate', {
      expression: 'location.hash',
      returnByValue: true,
    });
    if (phase === 'diff') {
      const [actualRoute, actualQuery] = destination.result.value.split('?');
      const [expectedRoute, expectedQuery] = `#${route.replace(/^#/, '')}`.split('?');
      assert.equal(actualRoute, expectedRoute, 'Gate route changed');
      const actualParams = new URLSearchParams(actualQuery);
      for (const [key, value] of new URLSearchParams(expectedQuery))
        assert.equal(actualParams.get(key), value, `Gate parameter ${key} changed`);
      const rendered = await client.call('Runtime.evaluate', {
        expression: `(async()=>{
          if(document.querySelector('whats-new-modal')?.open) throw Error('Dismiss the update notice before measuring a gate diff');
          const deadline=Date.now()+5000;
          while(Date.now()<deadline){
            const workspace=${DEEP_FIND}(document,'ready-workspace,review-workspace');
            const button=workspace && [...workspace.querySelectorAll('button.rdy-tab')].find(b=>b.textContent.trim().startsWith('Diff'));
            if(button && !button.classList.contains('active')) button.click();
            if(workspace) await workspace.updateComplete;
            const diff=workspace?.querySelector('diff-review');
            if(diff) await diff.updateComplete;
            if(diff?.querySelector('.d2h-diff-table')) return {paintedAt:performance.now()};
            await new Promise(resolve=>setTimeout(resolve,50));
          }
          throw Error('Gate diff did not render');
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      assert(!rendered.exceptionDetails, 'Gate diff did not render');
      result.renderedAt =
        after.metrics.find(({ name }) => name === 'NavigationStart').value +
        rendered.result.value.paintedAt / 1000;
    }
    const catchUp = pages.filter(({ at }) => at <= readyAt);
    return {
      phase,
      method: result.method,
      elapsedMs: Math.round(((merged ? readyAt : result.responseAt) - startedAt) * 1000),
      requestMs: Math.round((result.responseAt - result.requestAt) * 1000),
      receivedBytes: merged
        ? received.filter(({ at }) => at <= readyAt).reduce((sum, { bytes }) => sum + bytes, 0)
        : result.receivedBytes,
      responseBytes: result.responseBytes,
      ...(merged
        ? {
            catchUpPages: catchUp.length,
            catchUpBytes: catchUp.reduce((sum, { bytes }) => sum + bytes, 0),
          }
        : {}),
      ...(result.renderedAt === undefined
        ? {}
        : { renderedMs: Math.round((result.renderedAt - startedAt) * 1000) }),
      ...(result.runCount === undefined ? {} : { runCount: result.runCount }),
      ...(firstRunList
        ? {
            firstRunListMs: Math.round((firstRunList.at - startedAt) * 1000),
            firstRunListResponseBytes: firstRunList.responseBytes,
          }
        : {}),
      timing: `${phase === 'reconnect' ? 'socket close' : 'navigation'} to ${
        merged
          ? "the run list's merged ready state (the cache's observedAt for the catch-up merge)"
          : `${phase === 'diff' ? 'matching diff' : 'inventory run.list'} reply`
      }, CDP monotonic timestamps`,
      bytes: `received UTF-8 gateway application frames through ${merged ? 'that state' : 'that reply'}; excludes Vite and websocket framing`,
    };
  } finally {
    armed = false;
    clearTimeout(timer);
    await client.call('Runtime.releaseObjectGroup', { objectGroup: 'offline-store-baseline' });
    client.close();
  }
}

/**
 * Waits in the page for the run list to report a ready observation stamped after `since` (wall
 * milliseconds), and returns that stamp with the page's time origin.
 */
const RUN_LIST_READY_AFTER = (since) => `(async()=>{
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
    const list=${DEEP_FIND}(document,'run-list');
    const observedAt=Number(list?.getAttribute('data-runs-observed-at'));
    if(list?.getAttribute('data-runs-status')==='ready'&&observedAt>${Number(since)})
      return {observedAt,timeOrigin:performance.timeOrigin};
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('Open the run list (#runs) and wait for it to become ready before measuring');
})()`;

// Gate workspaces render inside run detail's shadow root, so lookups cross shadow roots.
const DEEP_FIND = `((function find(root,selector){const hit=root.querySelector(selector);if(hit)return hit;for(const node of root.querySelectorAll('*'))if(node.shadowRoot){const found=find(node.shadowRoot,selector);if(found)return found;}}))`;

const GATE_RENDER = `(async()=>{
  if(document.querySelector('whats-new-modal')?.open) throw Error('Dismiss the update notice before measuring a gate diff');
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
    const workspace=${DEEP_FIND}(document,'ready-workspace,review-workspace');
    const button=workspace && [...workspace.querySelectorAll('button.rdy-tab')].find(b=>b.textContent.trim().startsWith('Diff'));
    if(button && !button.classList.contains('active')) button.click();
    if(workspace) await workspace.updateComplete;
    const diff=workspace?.querySelector('diff-review');
    if(diff) await diff.updateComplete;
    if(diff?.querySelector('.d2h-diff-table')) return {paintedAt:performance.now()};
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('Gate diff did not render');
})()`;

/**
 * Open a pending gate's diff by navigation and stop at its rendered table. A connected gate reads
 * its file diff with `git.diff`; its package diff and other retained artifacts arrive over
 * `/api/run-artifact`, so HTTP artifact bytes are counted beside received gateway frames.
 */
export async function measureGateOpen({ connect, tab, route, match }) {
  assert(route, 'Gate measurement requires the real gate route');
  assert(match?.runId, 'Gate measurement requires its runId');
  let armed = false;
  let receivedBytes = 0;
  let diffReplyAt;
  const sent = {};
  const diffRequests = new Set();
  const artifacts = new Map();
  const client = await connect(tab.webSocketDebuggerUrl, ({ method, params }) => {
    if (!armed) return;
    if (method === 'Network.requestWillBeSent') {
      const url = new URL(params.request.url, 'http://localhost');
      if (url.pathname !== '/api/run-artifact') return;
      artifacts.set(params.requestId, {
        runId: url.searchParams.get('runId'),
        path: url.searchParams.get('path'),
        requestAt: params.timestamp,
      });
      return;
    }
    const artifact = artifacts.get(params.requestId);
    if (method === 'Network.responseReceived' && artifact) artifact.status = params.response.status;
    else if (method === 'Network.loadingFinished' && artifact) {
      artifact.bytes = params.encodedDataLength;
      artifact.finishedAt = params.timestamp;
    } else if (method === 'Network.loadingFailed' && artifact) artifact.failed = params.errorText;
    if (!['Network.webSocketFrameSent', 'Network.webSocketFrameReceived'].includes(method)) return;
    if (params.response.opcode !== 1) return;
    const raw = params.response.payloadData;
    if (!raw.startsWith('{')) return;
    const frame = JSON.parse(raw);
    const key = `${params.requestId}:${frame.id}`;
    if (method === 'Network.webSocketFrameSent' && frame.type === 'req') {
      sent[frame.method] = (sent[frame.method] ?? 0) + 1;
      if (frame.method === 'git.diff') diffRequests.add(key);
    } else if (
      method === 'Network.webSocketFrameReceived' &&
      ['res', 'event'].includes(frame.type)
    ) {
      receivedBytes += Buffer.byteLength(raw, 'utf8');
      if (frame.type === 'res' && diffRequests.has(key)) diffReplyAt ??= params.timestamp;
    }
  });
  try {
    await client.call('Page.enable');
    await client.call('Network.enable');
    await client.call('Performance.enable');
    const before = await client.call('Performance.getMetrics');
    const startedAt = before.metrics.find(({ name }) => name === 'Timestamp').value;
    armed = true;
    const url = new URL(tab.url);
    url.hash = route;
    await client.call('Page.navigate', { url: url.href });
    const rendered = await client.call('Runtime.evaluate', {
      expression: GATE_RENDER,
      awaitPromise: true,
      returnByValue: true,
    });
    assert(!rendered.exceptionDetails, 'Gate diff did not render');
    const after = await client.call('Performance.getMetrics');
    const renderedAt =
      after.metrics.find(({ name }) => name === 'NavigationStart').value +
      rendered.result.value.paintedAt / 1000;
    armed = false;
    const reads = [...artifacts.values()].filter((entry) => entry.runId === match.runId);
    const diff = reads.find((entry) => /\.diff$/u.test(entry.path ?? ''));
    const artifactBytes = reads.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    return {
      phase: 'gate',
      // Which read supplied the displayed diff: the live file diff, the package artifact, or
      // neither (held or already in memory).
      method: sent['git.diff'] ? 'git.diff' : diff ? 'run-artifact' : 'local',
      elapsedMs: Math.round((renderedAt - startedAt) * 1000),
      renderedMs: Math.round((renderedAt - startedAt) * 1000),
      ...(diff?.finishedAt === undefined
        ? {}
        : { diffReadMs: Math.round((diff.finishedAt - startedAt) * 1000) }),
      ...(diffReplyAt === undefined
        ? {}
        : { diffReplyMs: Math.round((diffReplyAt - startedAt) * 1000) }),
      receivedBytes,
      artifactBytes,
      totalBytes: receivedBytes + artifactBytes,
      artifactReads: reads.map(({ path, status, bytes, failed }) => ({
        path,
        status,
        bytes,
        ...(failed ? { failed } : {}),
      })),
      gatewayRequests: sent,
      timing: 'navigation to the rendered gate diff table, CDP monotonic timestamps',
      bytes:
        'received UTF-8 gateway application frames plus /api/run-artifact HTTP transfer bytes (encodedDataLength) through render; excludes Vite and websocket framing',
    };
  } finally {
    armed = false;
    client.close();
  }
}
