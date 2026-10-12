import { useState } from 'react';
import { Text, View } from 'react-native';

import { REVIEW_POST_RECOMMENDATIONS, type Run } from '@farmslot/protocol';

import { DocumentViewer } from '../../components/DocumentViewer';
import { MobileDiffViewer } from '../../components/MobileDiffViewer';
import { PRButton, PRToggle } from '../pr-automation/components/PRControls';
import { styles } from '../pr-automation/styles/pr-automation-styles';

import { useReviewPublication } from './use-review-publication';

export function ReviewPublicationPanel({
  viewModel: vm,
  busy,
  error,
  disabled,
  retry,
  open,
  curation,
  source,
  toggleFinding,
  selectAll,
  setRecommendation,
  setIncludeEvidence,
  inspect,
  refresh,
  report,
}: ReturnType<typeof useReviewPublication>) {
  const [reportOpen, setReportOpen] = useState(false);
  if (!vm && !curation) return null;
  return (
    <View style={styles.card} testID={curation ? 'companion-review-curation' : undefined}>
      <Text style={styles.title}>{curation ? 'Review findings before posting' : vm?.label}</Text>
      {vm && (
        <Text style={styles.muted}>
          {[vm.account, vm.source, vm.state].filter(Boolean).join(' · ')}
        </Text>
      )}
      {(error || vm?.error) && <Text style={styles.error}>{error || vm?.error}</Text>}
      {curation && (
        <>
          <Text style={styles.muted}>Reviewed SHA: {curation.reviewedSha ?? 'Unavailable'}</Text>
          <Text style={styles.text} testID="companion-review-inclusion-count">
            {curation.includedCount}/{curation.findings.length} findings selected
          </Text>
          <Text style={styles.muted}>{curation.reportNote}</Text>
          <View style={styles.row}>
            <PRButton
              label="Select all"
              testID="companion-review-select-all"
              onPress={() => selectAll(true)}
              disabled={disabled}
            />
            <PRButton
              label="Select none"
              testID="companion-review-select-none"
              onPress={() => selectAll(false)}
              disabled={disabled}
            />
          </View>
          {curation.findings.map((finding) => (
            <View key={finding.index} style={styles.card}>
              <Text style={styles.text}>
                {finding.path}:{finding.line}
              </Text>
              <Text style={styles.muted}>{finding.severity}</Text>
              <Text style={styles.text}>{finding.body}</Text>
              <PRToggle
                label="Include finding"
                testID={`companion-review-include-${finding.index}`}
                value={finding.included}
                onChange={() => toggleFinding(finding.index)}
                disabled={disabled}
              />
              <PRButton
                label="Inspect reviewed line"
                testID={`companion-review-inspect-${finding.index}`}
                onPress={() => inspect(finding.index)}
                disabled={disabled}
              />
              {source?.index === finding.index && (
                <>
                  {source.loading && <Text style={styles.muted}>Loading reviewed source…</Text>}
                  {source.error && (
                    <>
                      <Text style={styles.muted}>Reviewed source unavailable: {source.error}</Text>
                      <PRButton
                        label="Retry reviewed source"
                        onPress={() => inspect(finding.index)}
                        disabled={disabled}
                      />
                    </>
                  )}
                  {source.context && (
                    <MobileDiffViewer
                      title={`${finding.path}:${finding.line} at reviewed SHA`}
                      reviewedSource={source.context}
                    />
                  )}
                </>
              )}
            </View>
          ))}
          <Text style={styles.muted}>Publication recommendation</Text>
          <View style={styles.row}>
            {REVIEW_POST_RECOMMENDATIONS.map((value) => (
              <PRButton
                key={value}
                label={value}
                testID={`companion-review-recommendation-${value}`}
                selected={curation.recommendation === value}
                onPress={() => setRecommendation(value)}
                disabled={disabled}
              />
            ))}
          </View>
          {curation.evidenceAvailable && (
            <PRToggle
              label="Include evidence"
              value={curation.includeEvidence}
              onChange={setIncludeEvidence}
              disabled={disabled}
            />
          )}
          <PRButton
            label="Read original report"
            testID="companion-review-report"
            onPress={() => setReportOpen(true)}
          />
          <PRButton
            label={busy ? 'Refreshing review…' : 'Refresh review'}
            testID="companion-review-refresh"
            onPress={refresh}
            disabled={busy || disabled}
          />
          <DocumentViewer
            visible={reportOpen}
            title="Original review report"
            body={report ?? ''}
            onClose={() => setReportOpen(false)}
          />
        </>
      )}
      {vm?.url && (
        <PRButton label="Open published review" onPress={open} disabled={busy || disabled} />
      )}
      {vm?.canRetry && (
        <PRButton
          label={busy ? 'Publishing…' : 'Retry publication'}
          onPress={retry}
          disabled={busy || disabled}
        />
      )}
    </View>
  );
}

export function ReviewPublication({ run }: { run: Run }) {
  const controller = useReviewPublication(run);
  return <ReviewPublicationPanel {...controller} />;
}
