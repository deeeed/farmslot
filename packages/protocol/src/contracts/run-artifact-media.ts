/** POST to a retained video artifact URL to issue a short-lived playback URL. */
export const RUN_ARTIFACT_MEDIA_GRANT_PARAM = 'mediaGrant';

export interface RunArtifactMediaGrant {
  url: string;
}
