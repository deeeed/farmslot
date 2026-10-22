import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, View } from 'react-native';

import { REVIEW_POST_RECOMMENDATIONS, type Run } from '@farmslot/protocol';
import { runReviewerView } from '@farmslot/review-dispatch';

import { DocumentViewer } from '../../components/DocumentViewer';
import { MobileDiffViewer } from '../../components/MobileDiffViewer';
import { PRButton, PRToggle } from '../pr-automation/components/PRControls';
import { styles } from '../pr-automation/styles/pr-automation-styles';

import { type ReviewPublicationContext, useReviewPublication } from './use-review-publication';

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
  saved,
  savedLoading,
  savedOffline,
  savedError,
  readSaved,
  context,
  viewIdentity,
}: ReturnType<typeof useReviewPublication>) {
  const [reportOpen, setReportOpen] = useState<string | null>(null);
  if (!vm && !curation && !saved && !savedLoading && !savedOffline && !savedError) return null;
  return (
    <View
      style={styles.card}
      testID={curation ? 'companion-review-curation' : 'companion-saved-review'}
    >
      <Text style={styles.title}>
        {curation
          ? 'Review findings before posting'
          : saved || savedLoading || savedOffline || savedError
            ? 'Saved review'
            : vm?.label}
      </Text>
      {vm && (
        <Text style={styles.muted}>
          {[vm.account, vm.source, vm.state].filter(Boolean).join(' · ')}
        </Text>
      )}
      {(error || vm?.error) && <Text style={styles.error}>{error || vm?.error}</Text>}
      {savedLoading && <Text style={styles.muted}>Loading full saved review…</Text>}
      {savedOffline && <Text style={styles.muted}>Connect to load the saved review.</Text>}
      {savedError && <Text style={styles.muted}>Saved review unavailable: {savedError}</Text>}
      {saved && (
        <>
          <Text selectable style={styles.text} testID="companion-saved-review-verdict">
            Saved verdict: {saved.verdict ?? 'Not recorded in this legacy review'}
          </Text>
          <Text selectable style={styles.muted} testID="companion-saved-review-sha">
            Reviewed SHA: {saved.reviewedSha ?? 'Not recorded in this legacy review'}
          </Text>
          <Text style={styles.text} testID="companion-saved-review-receipt">
            {saved.confirmedEvent
              ? `Confirmed publication event: ${saved.confirmedEvent}`
              : 'No confirmed publication receipt'}
          </Text>
          {saved.requestedRecommendation !== null && (
            <Text style={styles.muted}>
              Requested publication recommendation: {saved.requestedRecommendation}
            </Text>
          )}
          {saved.requestedFindingCount !== null && (
            <Text style={styles.muted}>
              Requested findings: {saved.requestedFindingCount}. Provider acceptance count is not
              recorded.
            </Text>
          )}
          {saved.report ? (
            <PRButton
              label="Read saved report"
              testID="companion-saved-review-report"
              onPress={() => setReportOpen(viewIdentity)}
            />
          ) : (
            <Text style={styles.muted}>Report not recorded in this legacy review.</Text>
          )}
        </>
      )}
      {(saved || savedError) && (
        <PRButton
          label="Refresh saved review"
          testID="companion-saved-review-refresh"
          onPress={readSaved}
          disabled={disabled || savedLoading}
        />
      )}
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
            onPress={() => setReportOpen(viewIdentity)}
          />
          <PRButton
            label={busy ? 'Refreshing review…' : 'Refresh review'}
            testID="companion-review-refresh"
            onPress={refresh}
            disabled={busy || disabled}
          />
        </>
      )}
      {vm?.url && (
        <PRButton label="Open published review" onPress={open} disabled={busy || disabled} />
      )}
      {context === 'publication' && vm?.canRetry && (
        <PRButton
          label={busy ? 'Publishing…' : 'Retry publication'}
          onPress={retry}
          disabled={busy || disabled}
        />
      )}
      <DocumentViewer
        visible={reportOpen === viewIdentity && Boolean(curation || saved?.report)}
        title={curation ? 'Original review report' : 'Saved review report'}
        body={curation ? (report ?? '') : (saved?.report ?? '')}
        onClose={() => setReportOpen(null)}
      />
    </View>
  );
}

export function ReviewPublication({
  run,
  context = 'publication',
}: {
  run: Run;
  context?: ReviewPublicationContext;
}) {
  const controller = useReviewPublication(run, undefined, undefined, context);
  return <ReviewPublicationPanel {...controller} />;
}

export function AskReviewer({ run }: { run: Run | null }) {
  const router = useRouter();
  const reviewer = run ? runReviewerView(run) : null;
  return (
    <PRButton
      label="Ask reviewer"
      testID="companion-ask-reviewer"
      disabled={!reviewer || Boolean(reviewer.disabledReason)}
      onPress={() => {
        if (!run || !reviewer?.context || !reviewer.target || reviewer.disabledReason) return;
        router.push({
          pathname: reviewer.target.slotId
            ? '/workspace/slot/[slotId]/terminal'
            : '/run-terminal/[runId]',
          params: { ...reviewer.target, contextId: reviewer.context.id },
        });
      }}
    />
  );
}
