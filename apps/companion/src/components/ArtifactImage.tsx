import { useEffect, useState } from 'react';
import { Image, type ImageProps } from 'react-native';

import {
  type ArtifactImageState,
  forgetArtifactImage,
  reportArtifactImage,
} from '../farmslot/d12-native-proof';
import { useArtifactImageSource } from '../hooks/useHeldContent';
import type { ArtifactHttpHeaders } from '../lib/artifact-url';

let mounts = 0;

/** A run artifact image that renders held evidence bytes first, offline and online. */
export function ArtifactImage({
  artifact,
  uri,
  authHeaders,
  onLoad,
  onError,
  ...props
}: Omit<ImageProps, 'source'> & {
  artifact: { path: string; sha256?: string };
  uri: string;
  authHeaders?: ArtifactHttpHeaders;
}) {
  const { source, read } = useArtifactImageSource(uri, authHeaders, artifact);
  const [mountId] = useState(() => ++mounts);
  // The native outcome for the source it belongs to; a new source starts loading again.
  const [shown, setShown] = useState<{ source: typeof source; loaded: boolean }>();
  const state: ArtifactImageState =
    read === 'mismatch'
      ? 'mismatch'
      : read === 'unavailable'
        ? 'failed'
        : shown && shown.source === source
          ? shown.loaded
            ? 'loaded'
            : 'failed'
          : 'loading';
  const id = artifact.sha256 ?? artifact.path;
  useEffect(() => {
    if (__DEV__) reportArtifactImage({ id, state, mountId });
  }, [id, mountId, state]);
  useEffect(() => () => forgetArtifactImage(mountId), [mountId]);
  return (
    <Image
      {...props}
      source={source}
      onLoad={(event) => {
        setShown({ source, loaded: true });
        onLoad?.(event);
      }}
      onError={(event) => {
        setShown({ source, loaded: false });
        onError?.(event);
      }}
    />
  );
}
