import { Image, type ImageProps } from 'react-native';

import { useArtifactImageSource } from '../hooks/useHeldContent';
import type { ArtifactHttpHeaders } from '../lib/artifact-url';

/** A run artifact image that renders held evidence bytes first, offline and online. */
export function ArtifactImage({
  artifact,
  uri,
  authHeaders,
  ...props
}: Omit<ImageProps, 'source'> & {
  artifact: { path: string; sha256?: string };
  uri: string;
  authHeaders?: ArtifactHttpHeaders;
}) {
  const source = useArtifactImageSource(uri, authHeaders, artifact);
  return <Image {...props} source={source} />;
}
