import { GatewayMethodError } from '../../core/method-error.js';

/** Exact receipts from one reviewed experiment. Admitting another requires a reviewed source change. */
export const TRIAGE_PILOT_RECEIPT_HASH =
  'afe213b7c88ed4e0b2a9d432144c9f8417f4cddfa778a0f48a766e09b5ca8862';

/** The exact admitted manifest contains only these eight artifacts. */
export const TRIAGE_PILOT_FILE_NAMES = [
  'receipt-manifest.json',
  'baseline-results.json',
  'candidate-results.json',
  'candidate-results.jsonl',
  'corpus-manifest.json',
  'evaluation.json',
  'report.md',
  'run.json',
  'source-manifest.json',
] as const;

export class TriagePilotObservationUnavailable extends GatewayMethodError {
  constructor() {
    super(
      'RESOURCE_OBSERVATION_UNAVAILABLE',
      'Triage evaluation source observation is unavailable.',
      {
        userAction: 'Repair the selected evaluation directory or restart the gateway.',
      },
    );
  }
}
