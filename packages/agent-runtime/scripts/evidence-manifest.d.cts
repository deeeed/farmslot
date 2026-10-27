export function validateEvidenceManifest(value: unknown): string[];
export function normalizeArtifactPath(value: unknown, mediaOnly?: boolean): string | null;
export interface EvidenceManifestArtifacts {
  refs: Set<string> | null;
  issues: string[];
}
export function evidenceManifestArtifacts(
  value: unknown,
  artifactRoot: string,
  fileExists: (path: string) => boolean,
): EvidenceManifestArtifacts;
