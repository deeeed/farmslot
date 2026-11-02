import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import * as artifactUrl from '../lib/artifact-url';

import { mountHook } from './hook-harness.fixtures';

const GATEWAY = artifactUrl.artifactUrl(
  'ws://gw:7801',
  'run-1',
  'evidence/run.mp4',
  undefined,
  undefined,
  'bundle',
);
const HELD = 'file:///cache/evidence-media/scope/abc.mp4';

test('a video source moves to the held file when the index arrives after the first render', () => {
  const hook = mountHook<unknown[]>(
    new URL('./useArtifactSource.ts', import.meta.url),
    'useArtifactSource',
    {
      '../lib/artifact-url': artifactUrl,
    },
  );
  try {
    const render = () => hook.render(GATEWAY, undefined) as { uri: string };
    assert.equal(render().uri, GATEWAY, 'nothing held yet: the gateway URL');
    // A cold start: the holder's index is read after the screen first rendered.
    artifactUrl.setHeldArtifactLookup({
      subscribe: () => () => undefined,
      byPath: (runId, path, bundleDigest) =>
        runId === 'run-1' && path === 'evidence/run.mp4' && bundleDigest === 'bundle'
          ? HELD
          : undefined,
      byDigest: () => undefined,
    });
    assert.equal(render().uri, HELD);
  } finally {
    artifactUrl.setHeldArtifactLookup(undefined);
    hook.cleanup();
  }
});

test("a recipe run's video plays its held copy by digest, once the index arrives offline", () => {
  // The Files tab lists the video under its recipe run; the URL carries recipeRunId, so only the
  // manifest digest can find the held file.
  const recipeUrl = artifactUrl.artifactUrl(
    'ws://localhost:7801/ws',
    'run-1',
    'videos/recipe-run.mp4',
    '20261101082718242-33108',
    undefined,
    'bundle',
  );
  const sha256 = 'a'.repeat(64);
  const hook = mountHook<unknown[]>(
    new URL('./useArtifactSource.ts', import.meta.url),
    'useArtifactSource',
    { '../lib/artifact-url': artifactUrl },
  );
  try {
    const render = () => hook.render(recipeUrl, undefined, sha256) as { uri: string };
    assert.equal(render().uri, recipeUrl, 'a cold start before the index is read');
    artifactUrl.setHeldArtifactLookup({
      subscribe: () => () => undefined,
      byPath: () => undefined,
      byDigest: (digest) => (digest === sha256 ? HELD : undefined),
    });
    assert.equal(render().uri, HELD);
  } finally {
    artifactUrl.setHeldArtifactLookup(undefined);
    hook.cleanup();
  }
});
