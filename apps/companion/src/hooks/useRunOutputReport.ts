import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import { isHtmlArtifactPath } from '@farmslot/review-dispatch';

import type { GatewayHttpAuthHeaders } from '../lib/gateway-http-auth';
import { readRunOutputReport } from '../lib/output-report';

export interface RunOutputDocument {
  title: string;
  body: string;
  path: string;
  html: boolean;
}

interface ScopedRunOutputDocument {
  identity: string;
  value: RunOutputDocument;
}

export interface RunOutputReport {
  document: RunOutputDocument | null;
  loading: boolean;
  open: () => Promise<void>;
  close: () => void;
}

/** Opens a run's retained report once it is verified; every screen that reads a report uses this. */
export function useRunOutputReport({
  evidenceModel,
  runId,
  gatewayUrl,
  authHeaders,
  contextKey,
}: {
  evidenceModel: EvidenceReviewModel | null | undefined;
  runId: string | null | undefined;
  gatewayUrl: string;
  authHeaders: GatewayHttpAuthHeaders;
  contextKey?: string;
}): RunOutputReport {
  const [document, setDocument] = useState<ScopedRunOutputDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const identity = JSON.stringify([
    gatewayUrl,
    runId,
    contextKey,
    evidenceModel?.report?.manifestDigest,
    evidenceModel?.report?.reportPath,
  ]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  useEffect(() => {
    abortRef.current?.abort();
    setDocument(null);
    setLoading(false);
    return () => abortRef.current?.abort();
  }, [identity]);
  const open = useCallback(async () => {
    if (!evidenceModel || !runId || currentIdentity.current !== identity) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const report = await readRunOutputReport(evidenceModel, {
        gatewayUrl,
        runId,
        authHeaders,
        signal: controller.signal,
      });
      if (!controller.signal.aborted && currentIdentity.current === identity)
        setDocument({
          identity,
          value: {
            title: report.caption,
            body: report.body,
            path: report.path,
            html: isHtmlArtifactPath(report.path),
          },
        });
    } catch (error) {
      if (!controller.signal.aborted && currentIdentity.current === identity)
        Alert.alert('Report unavailable', error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted && currentIdentity.current === identity) setLoading(false);
    }
  }, [authHeaders, evidenceModel, gatewayUrl, runId, identity]);
  const close = useCallback(() => setDocument(null), []);
  return {
    document: document?.identity === identity ? document.value : null,
    loading,
    open,
    close,
  };
}
