/** Portable evidence validation; importing this entry does not load capture or filesystem code. */
export { validateRecordedEvidencePackage } from './package.js';
export type {
  RecordedEvidencePackageReadCheck,
  RecordedEvidencePackageReadResult,
} from './read-package.js';
export type { RecordedEvidencePackageInput } from '@farmslot/protocol';

/** Node-only package reader; portable validator imports do not load filesystem code. */
export async function readRecordedEvidencePackage(
  artifactDir: string,
): Promise<import('./read-package.js').RecordedEvidencePackageReadResult> {
  const reader = await import('./read-package.js');
  return reader.readRecordedEvidencePackage(artifactDir);
}
