import { useMemo, useSyncExternalStore } from 'react';

import {
  type ArtifactHttpHeaders,
  artifactSource,
  heldArtifactFile,
  heldArtifactsRevision,
  subscribeHeldArtifacts,
} from '../lib/artifact-url';

/**
 * An artifact's player or image source. It moves to the held file once the device holds it,
 * including when the held index is read after the first render (a cold offline start). With the
 * manifest's sha256 the held file is found by content, whichever recipe run or package lists it.
 */
export function useArtifactSource(
  uri: string,
  headers?: ArtifactHttpHeaders,
  sha256?: string,
): ReturnType<typeof artifactSource> {
  const revision = useSyncExternalStore(
    subscribeHeldArtifacts,
    heldArtifactsRevision,
    heldArtifactsRevision,
  );
  // `revision` only invalidates the source: the lookups read the held index themselves.
  return useMemo(() => {
    const held = sha256 ? heldArtifactFile(sha256) : undefined;
    return held ? { uri: held } : artifactSource(uri, headers);
  }, [uri, headers, sha256, revision]);
}
