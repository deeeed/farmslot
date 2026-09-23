// Provider-neutral ui.scroll_to conformance. The fake provider below models one scroll surface
// in viewport coordinates; each scenario reproduces a failure class seen in real recipe runs.
// See test/fixtures/scroll-to-visible/README.md.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  type RecipeActionManifestDocument,
  UI_SCROLL_TO_PARAMS_SCHEMA,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../src/adapters/core.js';
import { createStandardUiAdapters, type UiActionTransport } from '../src/adapters/ui.js';
import { createRecipeRunner } from '../src/core/runner.js';
import {
  type UiRect,
  type UiScrollGeometry,
  type UiScrollSession,
  UiScrollToError,
  type UiScrollToObservation,
} from '../src/core/scroll-to.js';
import type { TraceEntry } from '../src/core/types.js';

const VIEWPORT: UiRect = { x: 0, y: 100, width: 400, height: 500 };

interface FakeElement {
  /** Position inside the scroll content. */
  top: number;
  /** Horizontal position inside the content; defaults to 16. */
  left?: number;
  height: number;
  /** False models a flattened Text node: present, but with no box. */
  measurable?: boolean;
}

interface FakeSurfaceOptions {
  elements: Record<string, FakeElement>;
  contentHeight?: number;
  occlusions?: UiRect[];
  surfaceMissing?: boolean;
  /** Called on every measurement; returns extra layout shift applied to all elements. */
  layoutShift?: () => number;
}

class FakeSurface {
  offset = { x: 0, y: 0 };
  scrollCalls: Array<{ x: number; y: number }> = [];
  readonly options: FakeSurfaceOptions;

  constructor(options: FakeSurfaceOptions) {
    this.options = options;
  }

  measure(target: string, anchor?: string): UiScrollGeometry {
    const shift = this.options.layoutShift?.() ?? 0;
    const rect = (id: string | undefined): { present: boolean; bounds: UiRect | null } => {
      const element = id ? this.options.elements[id] : undefined;
      if (!element) return { present: false, bounds: null };
      if (element.measurable === false) return { present: true, bounds: null };
      return {
        present: true,
        bounds: {
          x: VIEWPORT.x + (element.left ?? 16) - this.offset.x,
          y: VIEWPORT.y + element.top + shift - this.offset.y,
          width: 200,
          height: element.height,
        },
      };
    };
    const measuredTarget = rect(target);
    const measuredAnchor = anchor ? rect(anchor) : undefined;
    return {
      surface: this.options.surfaceMissing ? null : VIEWPORT,
      viewport: this.options.surfaceMissing ? null : VIEWPORT,
      offset: { ...this.offset },
      targetPresent: measuredTarget.present,
      targetBounds: measuredTarget.bounds,
      ...(measuredAnchor
        ? {
            visibilityAnchorPresent: measuredAnchor.present,
            visibilityAnchorBounds: measuredAnchor.bounds,
          }
        : {}),
      ...(this.options.occlusions ? { occlusions: this.options.occlusions } : {}),
    };
  }

  scrollTo(offset: { x: number; y: number }): void {
    this.scrollCalls.push(offset);
    const max = Math.max(0, (this.options.contentHeight ?? 5_000) - VIEWPORT.height);
    this.offset = { x: Math.max(0, offset.x), y: Math.min(Math.max(0, offset.y), max) };
  }
}

interface FakeProviderOptions {
  /** 'retained' reuses one warm session and releases the device lock after each node. */
  sessions: 'retained' | 'leaks-lock';
}

/** Native-style provider: one device lock, a warm transport, identity per session. */
function fakeProvider(surface: FakeSurface, options: FakeProviderOptions) {
  let lockHolder: string | undefined;
  let connections = 0;
  let retained: string | undefined;
  const transport: UiActionTransport = {
    async execute(action) {
      throw new Error(`fake provider only implements ui.scroll_to, not ${action}`);
    },
    async withScrollSession(request, _node, _context, use) {
      if (lockHolder) {
        throw new UiScrollToError(
          'SCROLL_SESSION_CONFLICT',
          `device is held by session ${lockHolder}.`,
          { backend: 'fake-native', sessionId: lockHolder },
        );
      }
      if (!retained || options.sessions === 'leaks-lock') {
        connections += 1;
        retained = `fake-session-${connections}`;
      }
      const sessionId = retained;
      lockHolder = sessionId;
      const session: UiScrollSession = {
        backend: 'fake-native',
        sessionId,
        async measure() {
          return surface.measure(request.targetTestId, request.visibilityAnchorTestId);
        },
        async scrollTo(offset) {
          surface.scrollTo(offset);
        },
      };
      try {
        return await use(session);
      } finally {
        if (options.sessions === 'retained') lockHolder = undefined;
      }
    },
  };
  return { transport, connections: () => connections };
}

const manifest: RecipeActionManifestDocument = {
  $schema: RECIPE_ACTION_MANIFEST_SCHEMA_URL,
  actions: {
    'ui.scroll_to': {
      description: 'Bring a proof target into the HUD-safe viewport.',
      schema: UI_SCROLL_TO_PARAMS_SCHEMA as unknown as Record<string, unknown>,
      examples: [
        {
          action: 'ui.scroll_to',
          intent: 'The History row is reviewable.',
          surface_test_id: 'orders',
          target_test_id: 'history',
          next: 'done',
        },
      ],
    },
    end: { description: 'Finish.', examples: [{ action: 'end', status: 'pass' }] },
  },
};

const FAST_SETTLE = { timeout_ms: 200, interval_ms: 5, stable_samples: 2 };

async function runScrollRecipe(
  transport: UiActionTransport,
  nodes: Array<Record<string, unknown>>,
): Promise<{ status: string; trace: TraceEntry[]; summary: Record<string, unknown> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-scroll-to-'));
  try {
    const graph: Record<string, Record<string, unknown>> = {};
    nodes.forEach((node, index) => {
      graph[`scroll-${index + 1}`] = {
        action: 'ui.scroll_to',
        intent: 'The proof row is reviewable.',
        surface_test_id: 'orders',
        settle: FAST_SETTLE,
        ...node,
        next: index + 1 < nodes.length ? `scroll-${index + 2}` : 'done',
      };
    });
    graph.done = { action: 'end', status: 'pass' };
    const runner = createRecipeRunner({
      actionManifest: manifest,
      adapters: [
        ...createStandardUiAdapters({ transport, actions: ['ui.scroll_to'] }),
        ...createStandardCoreAdapters({ actions: ['end'] }),
      ],
      defaultSource: { kind: 'operator', trust: 'trusted', name: 'scroll conformance' },
    });
    const artifactsDir = path.join(root, 'artifacts');
    const result = await runner.run({
      recipeDocument: {
        $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
        description: 'ui.scroll_to conformance scenario.',
        workflow: { entry: 'scroll-1', nodes: graph },
      },
      artifactsDir,
      projectRoot: root,
    });
    return {
      status: result.status,
      trace: JSON.parse(await readFile(result.tracePath, 'utf8')) as TraceEntry[],
      summary: JSON.parse(await readFile(result.summaryPath, 'utf8')) as Record<string, unknown>,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function scrollOutput(entry: TraceEntry | undefined): UiScrollToObservation {
  assert.ok(entry?.ok, `expected a passing node, got ${JSON.stringify(entry)}`);
  return entry.output as UiScrollToObservation;
}

async function expectFailure(
  surface: FakeSurface,
  node: Record<string, unknown>,
  code: string,
): Promise<UiScrollToObservation> {
  const { transport } = fakeProvider(surface, { sessions: 'retained' });
  const { status, trace, summary } = await runScrollRecipe(transport, [node]);
  assert.equal(status, 'fail');
  const failed = trace.find((entry) => entry.nodeId === 'scroll-1');
  assert.equal(failed?.ok, false);
  assert.equal(failed?.cause_class, 'harness');
  assert.equal(failed?.error_code, code);
  assert.match(failed?.error ?? '', new RegExp(`^${code}: `, 'u'));
  assert.deepEqual(summary.cause_counts, { subject: 0, harness: 1, environment: 0, unknown: 0 });
  const details = failed?.error_details as UiScrollToObservation;
  assert.equal(details.surfaceTestId, 'orders');
  assert.equal(details.targetTestId, node.target_test_id);
  assert.equal(details.backend, 'fake-native');
  assert.ok(details.sessionId, 'failure keeps the session identity');
  return details;
}

test('already-visible target is a no-op: no movement, no settlement, verified visible', async () => {
  const surface = new FakeSurface({ elements: { history: { top: 120, height: 40 } } });
  const { transport } = fakeProvider(surface, { sessions: 'retained' });
  const { status, trace } = await runScrollRecipe(transport, [
    { target_test_id: 'history', align: 'center' },
  ]);
  assert.equal(status, 'pass');
  const output = scrollOutput(trace[0]);
  assert.equal(output.alreadyVisible, true);
  assert.equal(output.scrolled, false);
  assert.deepEqual(output.settlement, { status: 'skipped', samples: 0, elapsedMs: 0 });
  assert.deepEqual(output.before, output.after);
  assert.deepEqual(output.offset, { x: 0, y: 0 });
  assert.equal(output.finalVisible, true);
  assert.deepEqual(surface.scrollCalls, []);
});

test('far target scrolls once, records full geometry, and settles inside the viewport', async () => {
  const surface = new FakeSurface({ elements: { history: { top: 2_000, height: 40 } } });
  const { transport } = fakeProvider(surface, { sessions: 'retained' });
  const { status, trace } = await runScrollRecipe(transport, [
    { target_test_id: 'history', align: 'center' },
  ]);
  assert.equal(status, 'pass');
  const output = scrollOutput(trace[0]);
  assert.equal(output.backend, 'fake-native');
  assert.equal(output.sessionId, 'fake-session-1');
  assert.equal(output.measuredBy, 'target');
  assert.deepEqual(output.viewport, VIEWPORT);
  assert.deepEqual(output.safeViewport, VIEWPORT);
  assert.deepEqual(output.before?.offset, { x: 0, y: 0 });
  // The row centre (100 + 2000 + 20 = 2120) moves to the viewport centre (350): 2120 - 350.
  assert.deepEqual(output.offset, { x: 0, y: 1_770 });
  assert.deepEqual(output.after?.offset, { x: 0, y: 1_770 });
  assert.deepEqual(output.after?.targetBounds, { x: 16, y: 330, width: 200, height: 40 });
  assert.equal(output.scrolled, true);
  assert.equal(output.alreadyVisible, false);
  assert.equal(output.settlement?.status, 'settled');
  assert.equal(output.finalVisible, true);
  assert.equal(surface.scrollCalls.length, 1);
});

test('flattened Text target succeeds through a measurable anchor and stays asserted present', async () => {
  const surface = new FakeSurface({
    elements: {
      'validation-text': { top: 1_500, height: 0, measurable: false },
      'validation-row': { top: 1_490, height: 48 },
    },
  });
  const { transport } = fakeProvider(surface, { sessions: 'retained' });
  const { status, trace } = await runScrollRecipe(transport, [
    {
      target_test_id: 'validation-text',
      visibility_anchor_test_id: 'validation-row',
      align: 'start',
    },
  ]);
  assert.equal(status, 'pass');
  const output = scrollOutput(trace[0]);
  assert.equal(output.measuredBy, 'visibility_anchor');
  assert.equal(output.visibilityAnchorTestId, 'validation-row');
  assert.equal(output.after?.targetPresent, true);
  assert.equal(output.after?.targetBounds, null);
  assert.deepEqual(output.after?.visibilityAnchorBounds, {
    x: 16,
    y: VIEWPORT.y,
    width: 200,
    height: 48,
  });
  assert.equal(output.finalVisible, true);
});

test('the anchor never stands in for a missing semantic target', async () => {
  const surface = new FakeSurface({ elements: { 'validation-row': { top: 1_490, height: 48 } } });
  const details = await expectFailure(
    surface,
    { target_test_id: 'validation-text', visibility_anchor_test_id: 'validation-row' },
    'SCROLL_TARGET_MISSING',
  );
  assert.equal(details.before?.targetPresent, false);
  assert.deepEqual(details.viewport, VIEWPORT);
});

test('HUD occlusion shrinks the safe viewport so the target rests above the HUD', async () => {
  const hud = { x: 0, y: 520, width: 400, height: 80 };
  const surface = new FakeSurface({
    elements: { filters: { top: 450, height: 40 } },
    occlusions: [hud],
  });
  const { transport } = fakeProvider(surface, { sessions: 'retained' });
  const { status, trace } = await runScrollRecipe(transport, [
    { target_test_id: 'filters', align: 'nearest' },
  ]);
  assert.equal(status, 'pass');
  const output = scrollOutput(trace[0]);
  // Row sits at y 550-590: inside the raw viewport (100-600) but under the HUD (520-600).
  assert.deepEqual(output.before?.targetBounds, { x: 16, y: 550, width: 200, height: 40 });
  assert.deepEqual(output.safeViewport, { x: 0, y: 100, width: 400, height: 420 });
  assert.deepEqual(output.occlusions, [hud]);
  assert.equal(output.alreadyVisible, false);
  const after = output.after?.targetBounds;
  assert.ok(
    after && after.y + after.height <= hud.y,
    `row ended under the HUD: ${JSON.stringify(after)}`,
  );
});

test('a corner card only blocks targets it covers; it does not shrink the whole viewport', async () => {
  const card = { x: 300, y: 500, width: 100, height: 100 };
  const surface = new FakeSurface({
    elements: { filters: { top: 450, height: 40 }, badge: { top: 430, height: 40 } },
    occlusions: [card],
  });
  const { transport } = fakeProvider(surface, { sessions: 'retained' });
  const { trace } = await runScrollRecipe(transport, [{ target_test_id: 'filters' }]);
  const output = scrollOutput(trace[0]);
  // The 16-216px wide row at y 550-590 sits beside the card (x 300+), so it is already visible.
  assert.deepEqual(output.safeViewport, VIEWPORT);
  assert.equal(output.alreadyVisible, true);

  const wide = new FakeSurface({
    elements: { filters: { top: 450, height: 40 } },
    occlusions: [{ x: 100, y: 500, width: 100, height: 100 }],
  });
  const narrowOverRow = fakeProvider(wide, { sessions: 'retained' });
  const covered = await runScrollRecipe(narrowOverRow.transport, [
    { target_test_id: 'filters', align: 'center' },
  ]);
  const moved = scrollOutput(covered.trace[0]);
  assert.equal(moved.alreadyVisible, false, 'a card over the row forces a move');
  assert.equal(moved.finalVisible, true);
});

test('default nearest alignment moves a target out from under a corner card', async () => {
  const surface = new FakeSurface({
    elements: { filters: { top: 300, height: 40 } },
    occlusions: [{ x: 100, y: 390, width: 100, height: 60 }],
  });
  const { transport } = fakeProvider(surface, { sessions: 'retained' });
  const { status, trace } = await runScrollRecipe(transport, [{ target_test_id: 'filters' }]);
  assert.equal(status, 'pass', JSON.stringify(trace[0]));
  const output = scrollOutput(trace[0]);
  // Row at y 400-440 sits inside the viewport but under the card (390-450): move it to end at 390.
  assert.deepEqual(output.before?.targetBounds, { x: 16, y: 400, width: 200, height: 40 });
  assert.deepEqual(output.offset, { x: 0, y: 50 });
  assert.deepEqual(output.after?.targetBounds, { x: 16, y: 350, width: 200, height: 40 });
  assert.equal(output.finalVisible, true);
});

test('card clearance stays inside the safe viewport and clears every card', async () => {
  const cases: Array<{ label: string; top: number; cards: UiRect[]; align?: string }> = [
    // Row 550-590 under a card at 540-580 near the bottom edge: moving down would leave the viewport.
    { label: 'bottom edge', top: 450, cards: [{ x: 100, y: 540, width: 100, height: 40 }] },
    {
      label: 'bottom edge, align end',
      top: 450,
      cards: [{ x: 100, y: 540, width: 100, height: 40 }],
      align: 'end',
    },
    // Row 400-440 between two cards (380-410, 430-460): a single nudge lands under the first.
    {
      label: 'two cards',
      top: 300,
      cards: [
        { x: 100, y: 380, width: 100, height: 30 },
        { x: 100, y: 430, width: 100, height: 30 },
      ],
    },
    {
      label: 'two cards, align center',
      top: 1_200,
      cards: [
        { x: 100, y: 330, width: 100, height: 30 },
        { x: 100, y: 360, width: 100, height: 30 },
      ],
      align: 'center',
    },
    // Row 150-190 at offset 0 under a card at 140-170: resting below the card needs offset -20,
    // which the surface cannot reach; resting above it (offset 50) can.
    { label: 'top edge', top: 50, cards: [{ x: 100, y: 140, width: 100, height: 30 }] },
  ];
  for (const scenario of cases) {
    const surface = new FakeSurface({
      elements: { filters: { top: scenario.top, height: 40 } },
      occlusions: scenario.cards,
    });
    const { transport } = fakeProvider(surface, { sessions: 'retained' });
    const { status, trace } = await runScrollRecipe(transport, [
      { target_test_id: 'filters', ...(scenario.align ? { align: scenario.align } : {}) },
    ]);
    assert.equal(status, 'pass', `${scenario.label}: ${JSON.stringify(trace[0])}`);
    const after = scrollOutput(trace[0]).after?.targetBounds;
    assert.ok(after, scenario.label);
    assert.ok(after.y >= VIEWPORT.y && after.y + after.height <= VIEWPORT.y + VIEWPORT.height);
    for (const card of scenario.cards) {
      assert.ok(
        after.y + after.height <= card.y || after.y >= card.y + card.height,
        `${scenario.label}: row ${JSON.stringify(after)} under card ${JSON.stringify(card)}`,
      );
    }
  }
});

test('card clearance uses the position after the horizontal move', async () => {
  // Row at x 450-650 is right of the 400px viewport; the horizontal move lands it at x 200-400,
  // exactly under a card at x 250-400, y 240-300.
  const card = { x: 250, y: 240, width: 150, height: 60 };
  const surface = new FakeSurface({
    elements: { filters: { top: 150, left: 450, height: 40 } },
    occlusions: [card],
  });
  const { transport } = fakeProvider(surface, { sessions: 'retained' });
  const { status, trace } = await runScrollRecipe(transport, [{ target_test_id: 'filters' }]);
  assert.equal(status, 'pass', JSON.stringify(trace[0]));
  const after = scrollOutput(trace[0]).after?.targetBounds;
  assert.equal(after?.x, 200);
  assert.ok(after && (after.y + after.height <= card.y || after.y >= card.y + card.height));
});

test('viewport_policy full keeps the raw viewport and treats the row under the HUD as visible', async () => {
  const surface = new FakeSurface({
    elements: { filters: { top: 450, height: 40 } },
    occlusions: [{ x: 0, y: 520, width: 400, height: 80 }],
  });
  const { transport } = fakeProvider(surface, { sessions: 'retained' });
  const { trace } = await runScrollRecipe(transport, [
    { target_test_id: 'filters', viewport_policy: 'full' },
  ]);
  const output = scrollOutput(trace[0]);
  assert.deepEqual(output.safeViewport, VIEWPORT);
  assert.equal(output.alreadyVisible, true);
});

test('continuously changing layout fails with SCROLL_SETTLEMENT_TIMEOUT instead of passing', async () => {
  let tick = 0;
  const surface = new FakeSurface({
    elements: { history: { top: 2_000, height: 40 } },
    layoutShift: () => (tick++ % 2) * 24,
  });
  const details = await expectFailure(
    surface,
    { target_test_id: 'history', settle: { timeout_ms: 60, interval_ms: 5 } },
    'SCROLL_SETTLEMENT_TIMEOUT',
  );
  assert.equal(details.settlement?.status, 'timeout');
  assert.ok((details.settlement?.samples ?? 0) > 2);
  assert.ok(details.after?.targetBounds, 'last measured bounds are preserved');
  assert.equal(details.scrolled, true);
});

test('layout that shifts once and then settles passes with the settled geometry', async () => {
  let measurements = 0;
  const surface = new FakeSurface({
    elements: { history: { top: 2_000, height: 40 } },
    // Skeleton rows collapse right after the move: measurement 2 (first post-scroll) is stale.
    layoutShift: () => (++measurements === 2 ? 30 : 0),
  });
  const { transport } = fakeProvider(surface, { sessions: 'retained' });
  const { status, trace } = await runScrollRecipe(transport, [
    { target_test_id: 'history', align: 'center' },
  ]);
  assert.equal(status, 'pass');
  const output = scrollOutput(trace[0]);
  assert.equal(output.settlement?.status, 'settled');
  assert.ok((output.settlement?.samples ?? 0) >= 3);
  assert.deepEqual(output.after?.targetBounds, { x: 16, y: 330, width: 200, height: 40 });
});

test('settle timeout_ms 0 still takes stable_samples measurements before judging', async () => {
  const surface = new FakeSurface({ elements: { history: { top: 2_000, height: 40 } } });
  const { transport } = fakeProvider(surface, { sessions: 'retained' });
  const { status, trace } = await runScrollRecipe(transport, [
    { target_test_id: 'history', settle: { timeout_ms: 0, interval_ms: 1, stable_samples: 2 } },
  ]);
  assert.equal(status, 'pass', JSON.stringify(trace[0]));
  assert.equal(scrollOutput(trace[0]).settlement?.samples, 2);
});

test('retained session is reused across nodes without self-locking', async () => {
  const surface = new FakeSurface({
    elements: { active: { top: 900, height: 40 }, history: { top: 2_400, height: 40 } },
  });
  const provider = fakeProvider(surface, { sessions: 'retained' });
  const { status, trace } = await runScrollRecipe(provider.transport, [
    { target_test_id: 'active' },
    { target_test_id: 'history' },
    { target_test_id: 'active' },
  ]);
  assert.equal(status, 'pass', JSON.stringify(trace));
  assert.deepEqual(
    trace.map((entry) => (entry.output as UiScrollToObservation | undefined)?.sessionId),
    ['fake-session-1', 'fake-session-1', 'fake-session-1', undefined],
  );
  assert.equal(provider.connections(), 1);
});

test('a provider that keeps its lock fails the next node with SCROLL_SESSION_CONFLICT', async () => {
  const surface = new FakeSurface({
    elements: { active: { top: 900, height: 40 }, history: { top: 2_400, height: 40 } },
  });
  const provider = fakeProvider(surface, { sessions: 'leaks-lock' });
  const { status, trace } = await runScrollRecipe(provider.transport, [
    { target_test_id: 'active' },
    { target_test_id: 'history' },
  ]);
  assert.equal(status, 'fail');
  const failed = trace.find((entry) => entry.nodeId === 'scroll-2');
  assert.equal(failed?.cause_class, 'harness');
  assert.equal(failed?.error_code, 'SCROLL_SESSION_CONFLICT');
  assert.deepEqual(failed?.error_details, {
    surfaceTestId: 'orders',
    targetTestId: 'history',
    align: 'nearest',
    viewportPolicy: 'hud_safe',
    scrolled: false,
    alreadyVisible: false,
    backend: 'fake-native',
    sessionId: 'fake-session-1',
  });
});

test('missing surface fails with SCROLL_SURFACE_MISSING', async () => {
  const surface = new FakeSurface({
    elements: { history: { top: 2_000, height: 40 } },
    surfaceMissing: true,
  });
  const details = await expectFailure(
    surface,
    { target_test_id: 'history' },
    'SCROLL_SURFACE_MISSING',
  );
  assert.equal(details.before?.targetPresent, true);
});

test('box-less target without an anchor fails with SCROLL_TARGET_NOT_MEASURABLE', async () => {
  const surface = new FakeSurface({
    elements: { 'validation-text': { top: 1_500, height: 0, measurable: false } },
  });
  const details = await expectFailure(
    surface,
    { target_test_id: 'validation-text' },
    'SCROLL_TARGET_NOT_MEASURABLE',
  );
  assert.equal(details.before?.targetPresent, true);
  assert.equal(details.before?.targetBounds, null);
});

test('target the surface cannot bring into view fails with SCROLL_TARGET_NOT_VISIBLE', async () => {
  // Content ends at 1200px, so the surface cannot move the 2000px row into view.
  const surface = new FakeSurface({
    elements: { history: { top: 2_000, height: 40 } },
    contentHeight: 1_200,
  });
  const details = await expectFailure(
    surface,
    { target_test_id: 'history' },
    'SCROLL_TARGET_NOT_VISIBLE',
  );
  assert.equal(details.finalVisible, false);
  assert.deepEqual(details.after?.offset, { x: 0, y: 700 });
  assert.deepEqual(details.safeViewport, VIEWPORT);
});

test('verify_visible false records the verdict without failing the node', async () => {
  const surface = new FakeSurface({
    elements: { history: { top: 2_000, height: 40 } },
    contentHeight: 1_200,
  });
  const { transport } = fakeProvider(surface, { sessions: 'retained' });
  const { status, trace } = await runScrollRecipe(transport, [
    { target_test_id: 'history', verify_visible: false },
  ]);
  assert.equal(status, 'pass');
  assert.equal(scrollOutput(trace[0]).finalVisible, false);
});

test('a transport without withScrollSession fails closed with SCROLL_UNSUPPORTED', async () => {
  const transport: UiActionTransport = {
    async execute() {
      return { ok: true };
    },
  };
  const { status, trace } = await runScrollRecipe(transport, [{ target_test_id: 'history' }]);
  assert.equal(status, 'fail');
  assert.equal(trace[0]?.cause_class, 'harness');
  assert.equal(trace[0]?.error_code, 'SCROLL_UNSUPPORTED');
});
