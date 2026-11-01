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
