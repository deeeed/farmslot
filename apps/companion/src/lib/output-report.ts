/**
 * Read a run's retained output report (a QA run's findings, cases and coverage
 * gaps) through the shared evidence model, which checks the bytes against the
 * retained bundle before anything is shown.
 */
import {
  type EvidenceReviewModel,
  type EvidenceReviewReport,
  readEvidenceReviewReport,
} from '@farmslot/adapter-sdk/evidence';

import { artifactUrl } from './artifact-url';
import { gatewayFetch, type GatewayHttpAuthHeaders } from './gateway-http-auth';

export function readRunOutputReport(
  model: EvidenceReviewModel,
  {
    gatewayUrl,
    runId,
    authHeaders,
    signal,
  }: {
    gatewayUrl: string;
    runId: string;
    authHeaders: GatewayHttpAuthHeaders;
    signal?: AbortSignal;
  },
): Promise<EvidenceReviewReport> {
  return readEvidenceReviewReport(model, async (path) => {
    const response = await gatewayFetch(
      artifactUrl(
        gatewayUrl,
        runId,
        path,
        undefined,
        undefined,
        model.report?.artifactManifest.find((file) => file.path === path)?.bundleDigest,
      ),
      authHeaders,
      { signal },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  });
}

/** A QA worker writes report.html; it renders as a page rather than as text. */
export function isHtmlReport(path: string): boolean {
  return /\.html?$/i.test(path);
}
