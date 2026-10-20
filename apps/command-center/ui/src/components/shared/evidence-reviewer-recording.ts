/** What the review needs from an evidence model to match a recording to the files shown. */
export interface ReviewRecordings<T extends { videoPath: string }> {
  readonly recordings: readonly T[];
  artifactPath(path: string): string;
}

/** The model's recording shown under a file path, when the path is one of them. */
export function modelRecording<T extends { videoPath: string }>(
  model: ReviewRecordings<T>,
  path: string,
): T | undefined {
  return model.recordings.find((entry) => model.artifactPath(entry.videoPath) === path);
}

/**
 * A video from another recipe run than the model's, whose trace markers would not
 * match. Unknown, so false, until the model has its recordings.
 */
export function isForeignRecording<T extends { videoPath: string }>(
  model: ReviewRecordings<T>,
  path: string,
): boolean {
  return model.recordings.length > 0 && !modelRecording(model, path);
}
