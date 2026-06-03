import { assertArtifactOnlyTaskGuard } from '../tasks/artifact-only-guard.js';

export function assertArtifactOnlyEvalTaskGuard(markdown: string): void {
  try {
    assertArtifactOnlyTaskGuard(markdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.replace('Artifact-only task guard failed:', 'Artifact-only eval task guard failed:'),
    );
  }
}
