import { Pressable, Text, View } from 'react-native';

import type { RunResultsSummary } from '@farmslot/review-dispatch';

import { baseStyles } from '../../../lib/theme';
import { runDetailStyles as styles } from '../styles/run-detail.styles';

import { stepStatusColor } from './run-detail-panels';

/**
 * The run results card: the same title, badge and copy Command Center shows,
 * from the shared summary, with the run's retained report one tap away.
 */
export function RunResultsCard({
  summary,
  hasReport,
  captureError,
  loadingReport,
  onReadReport,
}: {
  summary: RunResultsSummary;
  /** The run retained a report; the shared model verifies it when it is opened. */
  hasReport: boolean;
  /** Why the worker's files could not be retrieved, shown as the shared empty message. */
  captureError?: string;
  loadingReport: boolean;
  onReadReport: () => void;
}) {
  const tone = stepStatusColor(summary.status);
  return (
    <View style={styles.workspaceCard} testID="companion-run-results">
      <View style={styles.workspaceHeader}>
        <Text style={styles.workspaceTitle}>{summary.title}</Text>
        <View style={[styles.workspaceBadge, { backgroundColor: tone + '22' }]}>
          <Text style={[styles.workspaceBadgeText, { color: tone }]}>{summary.badge}</Text>
        </View>
      </View>
      <Text style={styles.workspaceSummary}>{summary.copy}</Text>
      {captureError ? (
        <Text style={baseStyles.textMuted} testID="companion-run-results-capture-error">
          {summary.emptyMessage}
        </Text>
      ) : null}
      {hasReport ? (
        <Pressable
          style={[styles.focusedArtifactPrimaryButton, { alignSelf: 'flex-start' }]}
          onPress={onReadReport}
          disabled={loadingReport}
          accessibilityRole="button"
          testID="companion-run-results-read-report"
        >
          <Text style={styles.focusedArtifactPrimaryText}>
            {loadingReport ? 'Reading report…' : 'Read report'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
