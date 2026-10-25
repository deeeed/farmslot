import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  commandCenterUrlError,
  receiveSharedViewLink,
  resolveSharedViewLink,
  viewLinkFromRoute,
} from '../src/surfaces/view-links.js';

const base = 'https://cc.example.org/operations/';

test('a retained run links to that exact run without a live run or command context', () => {
  assert.deepEqual(
    resolveSharedViewLink(
      {
        companion: {
          pathname: '/workspace/run/saved-run/timeline',
          params: {},
        },
      },
      base,
    ),
    {
      status: 'available',
      route: '#run/saved-run?panel=timeline',
      url: 'https://cc.example.org/operations/#run/saved-run?panel=timeline&sharedView=1',
    },
  );
});

test('a selected native conversation preserves its node and session but no command lease or draft', () => {
  const result = resolveSharedViewLink(
    {
      companion: {
        pathname: '/native',
        params: {
          sessionObserved: '1',
          sessionId: 'old-session',
          executionNodeId: 'node-2',
          leaseId: 'current-lease',
          generation: '9',
          draft: 'private unsent instruction',
        },
      },
    },
    base,
  );
  assert.deepEqual(result, {
    status: 'available',
    route: '#native?sessionId=old-session&executionNodeId=node-2',
    url: 'https://cc.example.org/operations/#native?sessionId=old-session&executionNodeId=node-2&sharedView=1',
  });
});

test('a selected decision has an exact selector; unsupported file tabs cannot fall back to a run', () => {
  const decision = resolveSharedViewLink(
    { companion: { pathname: '/decision/decision-7', params: {} } },
    base,
  );
  assert.equal(
    decision.status === 'available' ? decision.route : null,
    '#decisions?gate=decision-7',
  );
  assert.equal(
    resolveSharedViewLink(
      { companion: { pathname: '/workspace/run/run-1/files', params: {} } },
      base,
    ).status,
    'unavailable',
  );
  assert.equal(
    resolveSharedViewLink({ companion: { pathname: '/settings', params: {} } }, base).status,
    'unavailable',
  );
});

test('unset web URL offers the named configuration reason', () => {
  assert.deepEqual(resolveSharedViewLink({ route: '#run/run-1' }), {
    status: 'unavailable',
    reason: 'web-url-unset',
    message: 'Web link unavailable: set the Command Center URL',
  });
});

test('web bases refuse loopback spellings, credentials and connection-bearing selectors', () => {
  for (const value of [
    'http://cc.example.org',
    'https://localhost',
    'https://local.localhost',
    'https://127.1',
    'https://2130706433',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://user:secret@cc.example.org',
    'https://cc.example.org/?token=secret',
    'https://cc.example.org/#fleet',
  ])
    assert.ok(commandCenterUrlError(value), value);
  assert.equal(commandCenterUrlError(base), null);
  for (const route of [
    '#run/run-1?draft=private',
    '#run/run-1?token=secret',
    '#run/run-1?tab=a&tab=b',
  ])
    assert.equal(resolveSharedViewLink({ route }, base).status, 'unavailable', route);
});

test('CC accepts only the explicitly bound gateway and consumes the web-only marker', () => {
  const deployment = { commandCenterUrl: base, gatewayUrls: ['wss://gateway.example.org/ws'] };
  const url = `${base}#run/run-1?sharedView=1`;
  assert.deepEqual(receiveSharedViewLink(url, 'wss://gateway.example.org/ws', deployment), {
    status: 'accepted',
    route: '#run/run-1',
  });
  assert.equal(
    receiveSharedViewLink(url, 'wss://another.example.org/ws', deployment).status,
    'refused',
  );
  assert.equal(
    receiveSharedViewLink(url, 'wss://gateway.example.org/ws', { ...deployment, gatewayUrls: [] })
      .status,
    'refused',
  );
  assert.equal(
    receiveSharedViewLink(
      `https://other.example.org/operations/#run/run-1?sharedView=1`,
      'wss://gateway.example.org/ws',
      deployment,
    ).status,
    'refused',
  );
  assert.equal(
    receiveSharedViewLink(
      url.replace('sharedView=1', 'sharedView=0'),
      'wss://gateway.example.org/ws',
      deployment,
    ).status,
    'refused',
  );
});

test('ordinary navigation retains current gateway selection and desktop copies exclude the web marker', () => {
  assert.deepEqual(
    receiveSharedViewLink(`${base}#slot/repeated-name`, 'ws://another-gateway:7801', {
      gatewayUrls: [],
    }),
    { status: 'ordinary' },
  );
  assert.equal(
    viewLinkFromRoute('#run/run-1?sharedView=1&step=compile'),
    'farmslot://view/#run/run-1?step=compile',
  );
});

test('artifact links preserve the selected file and criterion rather than opening the run summary', () => {
  const result = resolveSharedViewLink(
    {
      companion: {
        pathname: '/evidence/run-1',
        params: {},
        artifactSelection: {
          runId: 'run-1',
          path: 'captures/after image.png',
          criterionId: 'AC-2',
          traceIndex: 7,
        },
      },
    },
    base,
  );
  assert.equal(result.status, 'available');
  if (result.status !== 'available') return;
  const url = new URL(result.url);
  const [route, query] = url.hash.split('?');
  const params = new URLSearchParams(query);
  assert.equal(route, '#run/run-1');
  assert.equal(params.get('artifactRun'), 'run-1');
  assert.equal(params.get('artifact'), 'captures/after image.png');
  assert.equal(params.get('artifactAc'), 'AC-2');
  assert.equal(params.get('artifactTrace'), '7');
});

test('recipe evidence requires its observed slot and never substitutes a current run', () => {
  const selection = {
    runId: 'saved-run',
    path: 'captures/after.png',
    recipeRunId: 'recipe:recorded-1',
  };
  assert.equal(
    resolveSharedViewLink(
      { companion: { pathname: '/artifacts', params: {}, artifactSelection: selection } },
      base,
    ).status,
    'unavailable',
  );
  const result = resolveSharedViewLink(
    {
      companion: {
        pathname: '/artifacts',
        params: {},
        artifactSelection: { ...selection, slotId: 'saved-slot' },
      },
    },
    base,
  );
  assert.equal(result.status, 'available');
  if (result.status !== 'available') return;
  const [route, query] = new URL(result.url).hash.split('?');
  const params = new URLSearchParams(query);
  assert.equal(route, '#slot/saved-slot');
  assert.equal(params.get('runId'), 'saved-run');
  assert.equal(params.get('recipeRun'), 'recipe:recorded-1');
  assert.equal(params.get('recipeArtifact'), 'captures/after.png');
  assert.equal(params.get('recipeViewer'), '1');
  for (const path of ['../private', '/private', 'https://elsewhere/file']) {
    assert.equal(
      resolveSharedViewLink(
        {
          companion: {
            pathname: '/artifacts',
            params: {},
            artifactSelection: { ...selection, path, slotId: 'saved-slot' },
          },
        },
        base,
      ).status,
      'unavailable',
    );
  }
});

test('worker terminals share only the explicit observed target fields, with no voice intent or unsent text', () => {
  const worker = {
    nodeId: 'node-3',
    session: 'my worker',
    target: '%8',
    paneId: '%8',
    secret: 'not-view-data',
  };
  const result = resolveSharedViewLink(
    {
      companion: {
        pathname: '/terminal/worker',
        params: { draft: 'private', voiceStart: '1' },
        workerSelection: worker,
      },
    },
    base,
  );
  assert.equal(result.status, 'available');
  if (result.status !== 'available') return;
  const params = new URLSearchParams(new URL(result.url).hash.split('?')[1]);
  assert.deepEqual(JSON.parse(params.get('worker') ?? ''), {
    nodeId: 'node-3',
    session: 'my worker',
    target: '%8',
    paneId: '%8',
  });
  assert.equal(params.has('draft'), false);
  assert.equal(params.has('voiceStart'), false);
  assert.equal(
    resolveSharedViewLink(
      { companion: { pathname: '/terminal/worker', params: { nodeId: 'node-3' } } },
      base,
    ).status,
    'unavailable',
  );
});

test('displayed filters and historical terminal context survive without current-command fields', () => {
  const result = resolveSharedViewLink(
    {
      companion: {
        pathname: '/run-terminal/retained-run',
        params: { contextId: 'review-2', leaseId: 'private' },
        projects: ['project-a'],
        machines: ['node-3'],
      },
    },
    base,
  );
  assert.equal(result.status, 'available');
  if (result.status !== 'available') return;
  const params = new URLSearchParams(new URL(result.url).hash.split('?')[1]);
  assert.equal(params.get('run'), 'retained-run');
  assert.equal(params.get('contextId'), 'review-2');
  assert.equal(params.get('projects'), 'project-a');
  assert.equal(params.get('machines'), 'node-3');
  assert.equal(params.has('leaseId'), false);
});

test('local-only selections refuse sharing without a parent fallback', () => {
  for (const pathname of [
    '/settings',
    '/connection',
    '/filters',
    '/run-filters',
    '/workers',
    '/advanced',
    '/pr-automation',
    '/copilot',
    '/workspace/run/run-1/files',
    '/workspace/run/run-1/diff',
    '/visual-review/run-1',
    '/evidence/run-1',
  ]) {
    assert.equal(
      resolveSharedViewLink({ companion: { pathname, params: {} } }, base).status,
      'unavailable',
      pathname,
    );
  }
  const result = resolveSharedViewLink(
    {
      companion: {
        pathname: '/family/family-1',
        params: {},
        unavailableMessage:
          'Web link unavailable: this family section has no exact Command Center view.',
      },
    },
    base,
  );
  assert.deepEqual(result, {
    status: 'unavailable',
    reason: 'unsupported-view',
    message: 'Web link unavailable: this family section has no exact Command Center view.',
  });
});
