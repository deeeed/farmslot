import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  Methods,
  type RecipeRunArtifactGroup,
  type Run,
  validateVisualReviewFeedbackDocument,
  type VisualReviewSourceDocument,
} from '@farmslot/protocol';

import { artifactUrl } from '../../lib/artifact-url';
import type { GatewayClient } from '../../lib/gateway-client';
import { createVisualReviewGateway } from '../../lib/visual-review-gateway';

import {
  VisualReviewController,
  type VisualReviewDelivery,
  type VisualReviewReadyState,
} from './visual-review-controller';

const GATEWAY_URL = 'ws://gateway.test:8809/ws';
const AUTH = { Authorization: 'Bearer review-token' };
const SOURCE_PATH = 'artifacts/visual-review/visual-review-source.json';

const source: VisualReviewSourceDocument = {
  version: 1,
  kind: 'visual-review-source',
  id: 'farmslot-farm:companion-ux-catalog',
  title: 'Companion UX catalog',
  capturedAt: '2026-09-25T10:00:00.000Z',
  runId: 'run-origin',
  surfaces: [
    {
      id: 'capture-ready-gate',
      title: 'Ready Gate — full surface',
      captures: [
        {
          id: 'ios',
          platform: 'ios',
          image: { path: 'ios/11_ready_gate_full.png', width: 390, height: 2400 },
        },
      ],
    },
    ...(['evidence', 'diff', 'timeline'] as const).map((tab) => ({
      id: `capture-ready-${tab}`,
      title: `Ready Gate — ${tab}`,
      parentId: 'capture-ready-gate',
      captures: [{ id: 'ios', platform: 'ios', image: { path: `ios/${tab}.png` } }],
    })),
  ],
};

const hostRun = { id: 'run-host', slotId: 'slot-host' } as Run;
const originRun = { id: 'run-origin', slotId: 'slot-origin' } as Run;
const currentArtifacts = {
  id: 'current-artifacts',
  groupKind: 'current-artifacts',
  label: 'Current artifacts',
  status: 'available',
  artifactManifest: [
    { path: 'artifacts/recipe.json', purpose: 'recipe' },
    { path: SOURCE_PATH, purpose: 'json' },
    { path: 'artifacts/visual-review/ios/11_ready_gate_full.png', purpose: 'image' },
  ],
} as unknown as RecipeRunArtifactGroup;

interface Harness {
  controller: VisualReviewController;
  client: Pick<GatewayClient, 'request'>;
  requests: Array<{ method: string; params: unknown }>;
  fetched: Array<{ url: string; headers: unknown }>;
  deliveries: VisualReviewDelivery['status'][];
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function harness(
  options: {
    sourceText?: string;
    sendError?: Error;
    route?: { sourcePath?: string };
    originStatus?: Run['status'];
    holdSend?: Promise<void>;
    holdOriginRun?: Promise<void>;
  } = {},
): Harness {
  const requests: Harness['requests'] = [];
  const fetched: Harness['fetched'] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    fetched.push({ url, headers: init?.headers });
    return new Response(options.sourceText ?? JSON.stringify(source), { status: 200 });
  }) as typeof fetch;
  const client = {
    async request(method: string, params: unknown) {
      requests.push({ method, params });
      if (method === Methods.RUN_GET) {
        const { runId } = params as { runId: string };
        if (runId !== originRun.id) return { run: hostRun };
        await options.holdOriginRun;
        return {
          run: options.originStatus ? { ...originRun, status: options.originStatus } : originRun,
        };
      }
      if (method === Methods.RUN_RECIPE_RUNS_FOR_RUN) {
        return { recipeRuns: [currentArtifacts], selectedRecipeRunId: null };
      }
      if (method === Methods.TERMINAL_SEND) {
        if (options.sendError) throw options.sendError;
        await options.holdSend;
        return { sent: true };
      }
      throw new Error(`unexpected gateway method ${method}`);
    },
  } as Pick<GatewayClient, 'request'>;
  const controller = new VisualReviewController(
    { runId: hostRun.id, ...options.route },
    () => new Date('2026-09-25T11:00:00.000Z'),
  );
  const deliveries: Harness['deliveries'] = [];
  controller.subscribe(() => {
    const state = controller.getState();
    const status = state.status === 'ready' ? state.delivery.status : null;
    if (status && deliveries[deliveries.length - 1] !== status) deliveries.push(status);
  });
  controller.setGateway(createVisualReviewGateway(client, GATEWAY_URL, AUTH));
  return { controller, client, requests, fetched, deliveries };
}

async function ready(controller: VisualReviewController): Promise<VisualReviewReadyState> {
  for (let attempt = 0; attempt < 20 && controller.getState().status === 'loading'; attempt++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const state = controller.getState();
  assert.equal(state.status, 'ready', JSON.stringify(state));
  return state as VisualReviewReadyState;
}

function draftSomeFeedback(controller: VisualReviewController): void {
  controller.setSurfaceNote('Ready Gate summary is too dense.');
  controller.selectSurface('capture-ready-evidence');
  controller.addAnnotation({ shape: 'point', x: 0.5, y: 0.5 });
  const pointId = (controller.getState() as VisualReviewReadyState).selectedAnnotationId!;
  controller.updateAnnotation(pointId, { body: 'Badge overlaps the title.' });
}

test('loads a schema-valid source and its images through the run artifact path', async () => {
  const { controller, requests, fetched } = harness();
  const state = await ready(controller);

  assert.deepEqual(
    requests.map(({ method }) => method),
    [Methods.RUN_GET, Methods.RUN_RECIPE_RUNS_FOR_RUN],
  );
  assert.deepEqual(fetched, [
    { url: artifactUrl(GATEWAY_URL, hostRun.id, SOURCE_PATH), headers: AUTH },
  ]);
  assert.equal(state.source.id, source.id);
  assert.equal(state.targetRunId, 'run-origin');
  assert.equal(state.surfaceId, 'capture-ready-gate');
  const gateCapture = state.captures['capture-ready-gate\u0000ios'];
  assert.equal(gateCapture.artifactPath, 'artifacts/visual-review/ios/11_ready_gate_full.png');
  assert.deepEqual(gateCapture.image, {
    uri: `${artifactUrl(GATEWAY_URL, hostRun.id, gateCapture.artifactPath)}&token=review-token`,
    headers: AUTH,
  });
  assert.equal(
    state.captures['capture-ready-timeline\u0000ios'].artifactPath,
    'artifacts/visual-review/ios/timeline.png',
  );
});

test('reports a missing or invalid source instead of rendering an empty review', async () => {
  const missing = harness({ route: { sourcePath: 'artifacts/other/visual-review-source.json' } });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(missing.controller.getState(), {
    status: 'error',
    message:
      'Run run-host has no visual review source at artifacts/other/visual-review-source.json.',
  });

  const invalid = harness({ sourceText: JSON.stringify({ ...source, surfaces: [] }) });
  for (let attempt = 0; attempt < 5; attempt++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(invalid.controller.getState(), {
    status: 'error',
    message: `${SOURCE_PATH} is not a visual review source: source.surfaces must be a non-empty array`,
  });
});

test('surface navigation keeps notes and annotations on every surface', async () => {
  const { controller } = harness();
  await ready(controller);
  draftSomeFeedback(controller);
  controller.selectSurface('capture-ready-diff');
  controller.addAnnotation({ shape: 'area', x: 0.1, y: 0.2, width: 0.4, height: 0.3 });
  controller.selectSurface('capture-ready-timeline');
  controller.selectSurface('capture-ready-gate');

  const state = controller.getState() as VisualReviewReadyState;
  assert.equal(state.draft.surfaceNotes['capture-ready-gate'], 'Ready Gate summary is too dense.');
  assert.deepEqual(
    state.draft.annotations.map(({ id, surfaceId, shape, color }) => ({
      id,
      surfaceId,
      shape,
      color,
    })),
    [
      { id: 'annotation-1', surfaceId: 'capture-ready-evidence', shape: 'point', color: '#5855ee' },
      { id: 'annotation-2', surfaceId: 'capture-ready-diff', shape: 'area', color: '#e84a8a' },
    ],
  );
  assert.equal(state.selectedAnnotationId, null);
});

test('select, move, recolor, and remove edit only the chosen annotation', async () => {
  const { controller } = harness();
  await ready(controller);
  controller.selectSurface('capture-ready-diff');
  controller.addAnnotation({ shape: 'area', x: 0.5, y: 0.5, width: 0.3, height: 0.2 });
  controller.addAnnotation({ shape: 'point', x: 0.2, y: 0.2 });
  controller.selectAnnotation('annotation-1');
  controller.moveAnnotation('annotation-1', { x: 0.5, y: -0.1 });
  controller.updateAnnotation('annotation-1', { body: 'Group rows', color: '#20b486' });
  controller.removeAnnotation('annotation-2');

  const state = controller.getState() as VisualReviewReadyState;
  assert.equal(state.selectedAnnotationId, 'annotation-1');
  assert.equal(state.draft.annotations.length, 1);
  const [area] = state.draft.annotations;
  assert.equal(area.shape, 'area');
  assert.ok(Math.abs(area.x - 0.7) < 1e-9, 'area stays inside the image');
  assert.ok(Math.abs(area.y - 0.4) < 1e-9);
  assert.equal(area.color, '#20b486');
  assert.equal(area.body, 'Group rows');
});

test('accepted delivery sends the portable document to the originating run worker', async () => {
  const { controller, requests, deliveries } = harness();
  await ready(controller);
  draftSomeFeedback(controller);
  const before = (controller.getState() as VisualReviewReadyState).draft;

  await controller.submit();

  const state = controller.getState() as VisualReviewReadyState;
  assert.deepEqual(deliveries, ['idle', 'pending', 'accepted']);
  assert.deepEqual(state.delivery, {
    status: 'accepted',
    targetRunId: 'run-origin',
    settledAt: '2026-09-25T11:00:00.000Z',
  });
  assert.equal(state.draft, before, 'accepted delivery is not approval and keeps the draft');
  const sends = requests.filter(({ method }) => method === Methods.TERMINAL_SEND);
  assert.equal(sends.length, 1);
  const params = sends[0].params as { slotId: string; runId: string; text: string; enter: boolean };
  assert.equal(params.slotId, 'slot-origin');
  assert.equal(params.runId, 'run-origin');
  assert.equal(params.enter, true);
  assert.doesNotMatch(params.text, /\n/u);
  const sent = JSON.parse(params.text.slice(params.text.indexOf('{')));
  assert.deepEqual(validateVisualReviewFeedbackDocument(sent).errors, []);
  assert.deepEqual(sent, controller.exportDocument());
  assert.deepEqual(
    requests.map(({ method }) => method),
    [Methods.RUN_GET, Methods.RUN_RECIPE_RUNS_FOR_RUN, Methods.RUN_GET, Methods.TERMINAL_SEND],
  );
});

test("failed delivery reports status: 'failed', keeps the draft, and resolves nothing", async () => {
  const { controller, requests, deliveries } = harness({
    sendError: new Error('Cannot send semantic input: the owning runner context is unavailable'),
  });
  await ready(controller);
  draftSomeFeedback(controller);
  const before = (controller.getState() as VisualReviewReadyState).draft;

  await controller.submit();

  const state = controller.getState() as VisualReviewReadyState;
  assert.deepEqual(deliveries, ['idle', 'pending', 'failed']);
  assert.deepEqual(state.delivery, {
    status: 'failed',
    targetRunId: 'run-origin',
    message: 'Cannot send semantic input: the owning runner context is unavailable',
  });
  assert.equal(state.draft, before);
  const methods = new Set(requests.map(({ method }) => method));
  assert.deepEqual(
    [...methods],
    [Methods.RUN_GET, Methods.RUN_RECIPE_RUNS_FOR_RUN, Methods.TERMINAL_SEND],
  );
  for (const forbidden of [
    Methods.RUN_RESOLVE_DECISION,
    Methods.RUN_FORCE_COMPLETE,
    Methods.RUN_REFRESH_PUBLISH_PACKAGE,
  ]) {
    assert.equal(methods.has(forbidden), false, `${forbidden} must never be called`);
  }

  controller.updateAnnotation('annotation-1', { body: 'Badge overlaps the title (retry).' });
  assert.equal(
    (controller.getState() as VisualReviewReadyState).draft.annotations[0].body,
    'Badge overlaps the title (retry).',
  );
});

test('empty feedback is not sent', async () => {
  const { controller, requests } = harness();
  await ready(controller);
  controller.addAnnotation({ shape: 'point', x: 0.1, y: 0.1 });

  await controller.submit();

  assert.deepEqual((controller.getState() as VisualReviewReadyState).delivery, {
    status: 'failed',
    targetRunId: 'run-origin',
    message: 'Add a note or a described annotation before sending.',
  });
  assert.equal(
    requests.some(({ method }) => method === Methods.TERMINAL_SEND),
    false,
  );
});

test('editing after an accepted send marks the draft as not yet delivered', async () => {
  const { controller } = harness();
  await ready(controller);
  draftSomeFeedback(controller);
  await controller.submit();
  controller.selectSurface('capture-ready-diff');
  assert.equal((controller.getState() as VisualReviewReadyState).delivery.status, 'accepted');

  controller.setSurfaceNote('One more thing.');

  assert.deepEqual((controller.getState() as VisualReviewReadyState).delivery, { status: 'idle' });
});

test('feedback too large for one worker message fails before sending', async () => {
  const { controller, requests } = harness();
  await ready(controller);
  controller.setSurfaceNote('é'.repeat(8_000));

  await controller.submit();

  const { delivery } = controller.getState() as VisualReviewReadyState;
  assert.equal(delivery.status, 'failed');
  assert.match(
    (delivery as { message: string }).message,
    /is \d+ bytes; worker messages are limited to 15000\. Export the JSON/u,
  );
  assert.equal(
    requests.some(({ method }) => method === Methods.TERMINAL_SEND),
    false,
  );
});

test('reconnecting with the same credentials keeps the draft and refreshes image sources', async () => {
  const { controller, client } = harness();
  const loaded = await ready(controller);
  draftSomeFeedback(controller);
  const draft = (controller.getState() as VisualReviewReadyState).draft;

  controller.setGateway(null);
  controller.setGateway(createVisualReviewGateway({ ...client }, GATEWAY_URL, { ...AUTH }));

  const state = controller.getState() as VisualReviewReadyState;
  assert.equal(state.draft, draft);
  assert.equal(state.gatewayConnectionId, loaded.gatewayConnectionId);
  assert.notEqual(state.captures, loaded.captures);
  assert.equal(state.gatewayConnectionId.includes('review-token'), false);
});

test('replacing the credentials on the same profile reloads the review', async () => {
  const { controller, client } = harness();
  const loaded = await ready(controller);
  draftSomeFeedback(controller);

  controller.setGateway(
    createVisualReviewGateway(client, GATEWAY_URL, { Authorization: 'Bearer replaced' }),
  );
  assert.equal(controller.getState().status, 'loading');
  const state = await ready(controller);

  assert.notEqual(state.gatewayConnectionId, loaded.gatewayConnectionId);
  assert.equal(state.gatewayConnectionId.includes('replaced'), false);
  assert.deepEqual(state.draft.annotations, []);
});

test('switching to another gateway reloads the review from it', async () => {
  const { controller, client, requests } = harness();
  await ready(controller);
  draftSomeFeedback(controller);
  const before = requests.length;

  controller.setGateway(createVisualReviewGateway(client, 'ws://gateway.other:9000/ws', AUTH));
  assert.equal(controller.getState().status, 'loading');
  const state = await ready(controller);

  assert.ok(state.gatewayConnectionId.startsWith('|ws://gateway.other:9000/ws|'));
  assert.deepEqual(state.draft.annotations, []);
  assert.ok(requests.slice(before).some(({ method }) => method === Methods.RUN_GET));
});

test('disconnecting during a load drops the stale response', async () => {
  const { controller } = harness();
  controller.setGateway(null);
  for (let attempt = 0; attempt < 20; attempt++)
    await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.getState().status, 'loading');
});

test('edits made while a send is pending leave the draft unsent', async () => {
  let release!: () => void;
  const { controller } = harness({ holdSend: new Promise<void>((resolve) => (release = resolve)) });
  await ready(controller);
  draftSomeFeedback(controller);

  const sending = controller.submit();
  for (let attempt = 0; attempt < 5; attempt++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal((controller.getState() as VisualReviewReadyState).delivery.status, 'pending');
  controller.setSurfaceNote('Added while sending.');
  release();
  await sending;

  assert.deepEqual((controller.getState() as VisualReviewReadyState).delivery, { status: 'idle' });
});

test('a finished run does not take feedback', async () => {
  const { controller, requests } = harness({ originStatus: 'done' });
  await ready(controller);
  draftSomeFeedback(controller);

  await controller.submit();

  assert.deepEqual((controller.getState() as VisualReviewReadyState).delivery, {
    status: 'failed',
    targetRunId: 'run-origin',
    message: 'Run run-origin is done; its worker no longer takes input.',
  });
  assert.equal(
    requests.some(({ method }) => method === Methods.TERMINAL_SEND),
    false,
  );
});

test('switching profiles on the same gateway URL reloads the review', async () => {
  const { controller, client } = harness();
  await ready(controller);
  draftSomeFeedback(controller);

  controller.setGateway(createVisualReviewGateway(client, GATEWAY_URL, AUTH, 'other-principal'));
  const state = await ready(controller);

  assert.ok(state.gatewayConnectionId.startsWith(`other-principal|${GATEWAY_URL}|`));
  assert.deepEqual(state.draft.annotations, []);
});

test('a profile switch while sending never sends through the new connection', async () => {
  let release!: () => void;
  const { controller, client, requests } = harness({
    holdOriginRun: new Promise<void>((resolve) => (release = resolve)),
  });
  await ready(controller);
  draftSomeFeedback(controller);

  const sending = controller.submit();
  controller.setGateway(createVisualReviewGateway(client, GATEWAY_URL, AUTH, 'other-principal'));
  release();
  await sending;

  assert.equal(
    requests.some(({ method }) => method === Methods.TERMINAL_SEND),
    false,
  );
});

test('a same-credential reconnect while sending still delivers', async () => {
  let release!: () => void;
  const { controller, client } = harness({
    holdOriginRun: new Promise<void>((resolve) => (release = resolve)),
  });
  await ready(controller);
  draftSomeFeedback(controller);

  const sending = controller.submit();
  controller.setGateway(null);
  controller.setGateway(createVisualReviewGateway({ ...client }, GATEWAY_URL, { ...AUTH }));
  release();
  await sending;

  assert.equal((controller.getState() as VisualReviewReadyState).delivery.status, 'accepted');
});
