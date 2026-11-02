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
import { type GatewayHttpAuthHeaders } from './gateway-http-auth';

export function readRunOutputReport(
  model: EvidenceReviewModel,
  {
    gatewayUrl,
    runId,
    authHeaders,
    signal,
    readArtifact,
  }: {
    gatewayUrl: string;
    runId: string;
    authHeaders: GatewayHttpAuthHeaders;
    signal?: AbortSignal;
    readArtifact: (url: string, headers: GatewayHttpAuthHeaders, init?: RequestInit) => Promise<Response>;
  },
): Promise<EvidenceReviewReport> {
  return readEvidenceReviewReport(model, async (path) => {
    const response = await readArtifact(
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
