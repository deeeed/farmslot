import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let reads = 0;
// Rendering the diff widget is outside this evidence-read regression.
mock.module('../diff-viewer/diff-review.js', { namedExports: {} });
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      request: async () => {
        reads++;
        return { selectedRecipeRunId: null };
      },
      onConnectionChange: () => () => undefined,
      subscribe: () => () => undefined,
    },
  },
});
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: new URL('http://localhost/'),
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { location: new URL('http://localhost/') },
});
const { ReadyWorkspace } = await import('./ready-workspace.js');

test('a new run revision re-reads evidence without discarding the current review draft', () => {
  const view = Object.create(ReadyWorkspace.prototype) as InstanceType<typeof ReadyWorkspace>;
  const decision = { id: 'gate', payload: { kind: 'ready' } };
  // The shared evidence observation owns the read; a run revision delivers its new source.
  let evidence = {
    belongsToWorkspace: true,
    state: { status: 'ready', data: { selectedRecipeRunId: 'recipe-old' } },
  };
  const built: unknown[] = [];
  Object.assign(view, {
    requestUpdate: () => undefined,
    runId: 'run-a',
    slotId: 'slot-a',
    decision,
    mockData: false,
    _queries: {
      get evidence() {
        return evidence;
      },
      decision,
    },
    _reviewEvidenceModel: (...args: unknown[]) => {
      built.push(args);
      return {};
    },
  });
  Object.defineProperty(view, '_usesMockData', { value: false });
  Object.defineProperty(view, 'isConnected', { value: true });
  view._sharedWorkspaceQueriesChanged();
  assert.equal(built.length, 1);

  const reasons = { otherClaim: 'Keep this unfinished reason' };
  Object.assign(view, {
    _visualReviewReasons: reasons,
    _claimOverrideId: 'otherClaim',
    _claimOverrideReason: 'Unfinished override',
    _lightboxOpen: true,
  });
  evidence = {
    belongsToWorkspace: true,
    state: { status: 'ready', data: { selectedRecipeRunId: 'recipe-new' } },
  };
  view._sharedWorkspaceQueriesChanged();
  assert.equal(built.length, 2, 'The new revision rebuilds evidence from the shared read');
  assert.equal(Reflect.get(view, '_evidenceRecipeRunId'), 'recipe-new');
  assert.equal(Reflect.get(view, '_visualReviewReasons'), reasons);
  assert.equal(Reflect.get(view, '_claimOverrideReason'), 'Unfinished override');
  assert.equal(Reflect.get(view, '_claimOverrideId'), 'otherClaim');
  assert.equal(Reflect.get(view, '_lightboxOpen'), true);

  view._sharedWorkspaceQueriesChanged();
  assert.equal(built.length, 2, 'An unchanged revision reuses the completed read');
  assert.equal(reads, 0, 'Evidence is never read around the shared observation');
});
