import { useMemo } from 'react';

import type {
  EvidenceReviewJudgmentRow,
  EvidenceReviewModel,
} from '@farmslot/adapter-sdk/evidence';

import type { RunOutputReport } from '../hooks/useRunOutputReport';
import { reportArtifactResolver } from '../lib/document-html';

import { DocumentViewer } from './DocumentViewer';
import { TaskAcceptancePanel } from './TaskAcceptancePanel';

type VisualReview = React.ComponentProps<typeof TaskAcceptancePanel>['onRecordVisualReview'];

/**
 * A run's verified report with its recorded claims beneath it: the native counterpart of
 * Command Center's report lightbox. Links in an HTML report open the retained artifact.
 */
export function RunOutputReportViewer({
  report,
  evidenceModel,
  judgmentRows,
  visible = true,
  onRecordVisualReview,
  onOpenEvidence,
  onOpenArtifact,
}: {
  report: RunOutputReport;
  evidenceModel: EvidenceReviewModel | null | undefined;
  judgmentRows: readonly EvidenceReviewJudgmentRow[];
  visible?: boolean;
  onRecordVisualReview?: VisualReview;
  onOpenEvidence: (criterionId: string, path: string) => void;
  onOpenArtifact: (artifactPath: string) => void;
}) {
  const document = report.document;
  const links = useMemo(
    () =>
      document?.html
        ? {
            resolveArtifact: reportArtifactResolver(
              (evidenceModel?.report?.artifactManifest ?? []).map((file) => file.path),
              document.path,
            ),
            openArtifact: (path: string) => {
              report.close();
              onOpenArtifact(path);
            },
          }
        : undefined,
    [document, evidenceModel, onOpenArtifact, report],
  );
  return (
    <DocumentViewer
      visible={visible && Boolean(document)}
      title={document?.title ?? ''}
      body={document?.body ?? ''}
      html={links}
      onClose={report.close}
    >
      {document && evidenceModel?.claims.length ? (
        <TaskAcceptancePanel
          acceptanceStatus={null}
          evidenceModel={evidenceModel}
          judgmentRows={judgmentRows}
          onRecordVisualReview={onRecordVisualReview}
          onOpenEvidence={(criterionId, path) => {
            report.close();
            onOpenEvidence(criterionId, path);
          }}
        />
      ) : null}
    </DocumentViewer>
  );
}
