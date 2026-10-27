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

test('a new run revision re-reads evidence without discarding the current review draft', async () => {
  const view = Object.create(ReadyWorkspace.prototype) as InstanceType<typeof ReadyWorkspace>;
  const reasons = { otherClaim: 'Keep this unfinished reason' };
  Object.assign(view, {
    requestUpdate: () => undefined,
    runId: 'run-a',
    run: { updatedAt: 'new' },
    decision: { id: 'gate' },
    mockData: false,
    _evidenceRequest: 0,
    _evidenceScope: { runId: 'run-a', decisionId: 'gate', runUpdatedAt: 'old' },
    _evidenceLoaded: true,
    _visualReviewReasons: reasons,
    _claimOverrideId: 'otherClaim',
    _claimOverrideReason: 'Unfinished override',
    _lightboxOpen: true,
    _reviewEvidenceModel: () => ({}),
  });
  Object.defineProperty(view, 'isConnected', { value: true });
  const load: unknown = Reflect.get(view, '_loadReviewEvidence');
  assert.equal(typeof load, 'function');
  if (typeof load !== 'function') throw new Error('Expected the owning evidence reader');
  const before = reads;
  await load.call(view);
  assert.equal(reads, before + 1);
  assert.equal(Reflect.get(view, '_visualReviewReasons'), reasons);
  assert.equal(Reflect.get(view, '_claimOverrideReason'), 'Unfinished override');
  assert.equal(Reflect.get(view, '_claimOverrideId'), 'otherClaim');
  assert.equal(Reflect.get(view, '_lightboxOpen'), true);
  await load.call(view);
  assert.equal(reads, before + 1, 'An unchanged revision reuses the completed read');
});
