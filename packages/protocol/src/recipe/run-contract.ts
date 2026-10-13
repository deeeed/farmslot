/** Gateway-created runs require selected-attempt recorded evidence from this version. */
export const RECORDED_EVIDENCE_RUN_CONTRACT_VERSION = 1;

export type RecordedEvidenceReadFailureCode =
  | 'evidence-selection-missing'
  | 'evidence-selection-invalid'
  | 'evidence-package-unverifiable'
  | 'evidence-contract-unsupported';

export class RecordedEvidenceReadError extends Error {
  constructor(
    readonly code: RecordedEvidenceReadFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RecordedEvidenceReadError';
  }
}
