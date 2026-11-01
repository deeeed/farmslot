import { useMemo, useSyncExternalStore } from 'react';

import {
  type ArtifactHttpHeaders,
  artifactSource,
  heldArtifactsRevision,
  subscribeHeldArtifacts,
} from '../lib/artifact-url';

/**
 * An artifact's player or image source. It moves to the held file once the device holds it,
 * including when the held index is read after the first render (a cold offline start).
 */
export function useArtifactSource(
  uri: string,
  headers?: ArtifactHttpHeaders,
): ReturnType<typeof artifactSource> {
  const revision = useSyncExternalStore(
    subscribeHeldArtifacts,
    heldArtifactsRevision,
    heldArtifactsRevision,
  );
  // `revision` only invalidates the source: artifactSource reads the held index itself.
  return useMemo(() => artifactSource(uri, headers), [uri, headers, revision]);
}
