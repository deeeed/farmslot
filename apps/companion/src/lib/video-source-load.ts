import type { SourceLoadEventPayload, VideoPlayer } from 'expo-video';

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

export interface LoadedVideoSource {
  player: VideoReadySource;
  uri: string;
  durationMs: number;
}

type VideoReadySource = Pick<VideoPlayer, 'status'> & {
  addListener(event: 'statusChange', listener: () => void): { remove(): void };
};

export function observeLoadedVideoReady(
  player: VideoReadySource,
  expectedUri: string,
  loaded: LoadedVideoSource | null,
  onReady: (durationMs: number) => void,
): (() => void) | undefined {
  if (loaded?.uri !== expectedUri || loaded.player !== player) return;
  let active = true;
  const syncReady = () => {
    if (active && player.status === 'readyToPlay') onReady(loaded.durationMs);
  };
  // Metadata can arrive before buffering finishes. The ready event still
  // matters when the duration stays the same.
  const status = player.addListener('statusChange', syncReady);
  syncReady();
  return () => {
    active = false;
    status.remove();
  };
}

export interface RecordingSeekIdentity {
  player: object;
  sourceUri: string;
  recording: string;
  atMs: number;
}

export function sameRecordingSeek(
  previous: RecordingSeekIdentity | null | undefined,
  current: RecordingSeekIdentity,
): boolean {
  return (
    previous?.player === current.player &&
    previous.sourceUri === current.sourceUri &&
    previous.recording === current.recording &&
    previous.atMs === current.atMs
  );
}
