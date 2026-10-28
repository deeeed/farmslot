import type { SourceLoadEventPayload } from 'expo-video';

/** Match the exact source delivered to the player, including its resource credential. */
export function videoSourceLoadDurationMs(
  expectedUri: string,
  event: Pick<SourceLoadEventPayload, 'videoSource' | 'duration'>,
): number | null {
  const loadedUri =
    typeof event.videoSource === 'string'
      ? event.videoSource
      : typeof event.videoSource === 'object' && event.videoSource !== null
        ? event.videoSource.uri
        : undefined;
  return loadedUri === expectedUri && Number.isFinite(event.duration) && event.duration > 0
    ? event.duration * 1000
    : null;
}
