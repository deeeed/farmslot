import { Image, Pressable, ScrollView, Text, View } from 'react-native';

import type { RunDecision } from '@farmslot/protocol';
import type { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import { type ArtifactHttpHeaders, artifactSource } from '../../../lib/artifact-url';
import type {
  GateReviewAction,
  GateReviewSummary,
  GateReviewVerdict,
} from '../../../lib/gate-review';
import { ReviewDispatchPicker } from '../../review-dispatch/ReviewDispatchPicker';
import { gateReviewStyles as styles } from '../styles/gate-review.styles';
import type { GateReviewEvidenceThumb } from '../use-gate-review-controller';

/** Entry from run detail and the decision workspace into the gate review. */
export function GateReviewEntryCard({ onOpen, testID }: { onOpen: () => void; testID: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="Open the publish gate review"
      onPress={onOpen}
      style={({ pressed }) => [styles.entryCard, pressed && styles.pressed]}
    >
      <View style={styles.entryText}>
        <Text style={styles.entryTitle}>Publish gate open</Text>
        <Text style={styles.entryHint}>Summary, review verdicts, criteria and evidence</Text>
      </View>
      <Text style={styles.entryArrow}>›</Text>
    </Pressable>
  );
}

function Meta({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View style={styles.meta}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} testID={testID} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export function GateSummaryCard({ summary }: { summary: GateReviewSummary }) {
  return (
    <View style={styles.summaryCard} testID="companion-gate-review-summary">
      <Text style={styles.kind}>Publish gate</Text>
      <Text style={styles.title}>{summary.title}</Text>
      <View style={styles.metaGrid}>
        <Meta label="Target" value={summary.target ?? '-'} />
        <Meta label="Branch" value={summary.branch ?? '-'} />
        <Meta label="Files" value={summary.files === null ? '-' : String(summary.files)} />
        <View style={styles.meta}>
          <Text style={styles.metaLabel}>Lines</Text>
          {summary.additions === null || summary.deletions === null ? (
            <Text style={styles.metaValue}>-</Text>
          ) : (
            <Text style={styles.metaValue} testID="companion-gate-review-diffstat">
              <Text style={styles.additions}>+{summary.additions}</Text>{' '}
              <Text style={styles.deletions}>−{summary.deletions}</Text>
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

export function GateReviewVerdicts({ reviews }: { reviews: GateReviewVerdict[] }) {
  return (
    <View style={styles.section} testID="companion-gate-review-verdicts">
      <Text style={styles.sectionTitle}>Review verdicts</Text>
      {reviews.length === 0 ? (
        <Text style={styles.muted}>No review has finished yet.</Text>
      ) : (
        <View style={styles.verdictRow}>
          {reviews.map((review) => (
            <View
              key={review.id}
              style={[styles.verdictCard, { borderColor: review.color + '80' }]}
              testID={`companion-gate-review-verdict-${review.runner}`}
            >
              <Text style={styles.verdictRunner}>{review.runner}</Text>
              {review.model ? <Text style={styles.verdictModel}>{review.model}</Text> : null}
              <Text style={[styles.verdictLabel, { color: review.color }]}>{review.label}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const THUMB_KIND_LABELS = { image: 'IMAGE', video: 'VIDEO', document: 'TEXT' } as const;

export function GateEvidenceStrip({
  items,
  authHeaders,
  onOpen,
}: {
  items: GateReviewEvidenceThumb[];
  authHeaders: ArtifactHttpHeaders;
  onOpen: (criterionId: string, path: string) => void;
}) {
  return (
    <View style={styles.section} testID="companion-gate-review-evidence-strip">
      <Text style={styles.sectionTitle}>Evidence</Text>
      {items.length === 0 ? (
        <Text style={styles.muted}>No acceptance evidence recorded.</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.strip}>
            {items.map((item, index) => (
              <Pressable
                key={item.path}
                testID={`companion-gate-review-evidence-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.name} evidence for ${item.criterionId}`}
                onPress={() => onOpen(item.criterionId, item.path)}
                style={({ pressed }) => [styles.thumb, pressed && styles.pressed]}
              >
                <View style={styles.thumbMedia}>
                  {item.mediaType === 'image' ? (
                    <Image
                      source={artifactSource(item.uri, authHeaders)}
                      style={styles.thumbMedia}
                      resizeMode="cover"
                    />
                  ) : (
                    <Text style={styles.thumbKind}>{THUMB_KIND_LABELS[item.mediaType]}</Text>
                  )}
                </View>
                <Text style={styles.thumbCaption} numberOfLines={2}>
                  {item.criterionId} · {item.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

/** Which publish approvals are withheld and why; nothing when none is. */
export function PublishGuardNotice({
  actions,
  testID,
}: {
  actions: GateReviewAction[];
  testID: string;
}) {
  const withheld = actions.filter((action) => action.disabledReason);
  if (withheld.length === 0) return null;
  return (
    <View style={styles.guardCard} testID={testID}>
      <Text style={styles.guardTitle}>Publish approval is disabled</Text>
      {withheld.map((action) => (
        <Text key={action.id} style={styles.guardText}>
          • {action.label}: {action.disabledReason}
        </Text>
      ))}
    </View>
  );
}

export function GateActions({
  decision,
  actions,
  sendingActionId,
  onResolve,
  reviewPicker,
}: {
  reviewPicker: ReviewDispatchViewModel;
  decision: RunDecision;
  actions: GateReviewAction[];
  sendingActionId: string | null;
  onResolve: (action: GateReviewAction, selectionData?: Record<string, unknown>) => void;
}) {
  if (decision.resolvedAt) {
    return (
      <View style={styles.resolvedCard} testID="companion-gate-review-resolved">
        <Text style={styles.resolvedText}>
          Resolved: {decision.resolvedAction ?? 'resolved'} ·{' '}
          {new Date(decision.resolvedAt).toLocaleString()}
        </Text>
      </View>
    );
  }
  return (
    <View testID="companion-gate-review-actions">
      <PublishGuardNotice actions={actions} testID="companion-gate-review-approve-reason" />
      {actions.map((action) => {
        const disabled = Boolean(action.disabledReason) || sendingActionId !== null;
        if (action.id === 'request-review')
          return (
            <ReviewDispatchPicker
              key={action.id}
              model={reviewPicker}
              disabled={disabled}
              testID="companion-publish-gate-review"
              action="request-review"
              actionLabel={action.label}
              onInvoke={(_actionId, payload) => onResolve(action, { reviewRequest: payload })}
            />
          );
        return (
          <Pressable
            key={action.id}
            testID={`companion-gate-review-action-${action.id}`}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => onResolve(action)}
            style={[
              styles.actionButton,
              action.style === 'primary' && styles.actionPrimary,
              action.style === 'danger' && styles.actionDanger,
              disabled && styles.actionDisabled,
            ]}
          >
            <Text style={styles.actionText}>
              {sendingActionId === action.id ? `Sending ${action.label}…` : action.label}
            </Text>
            {action.description ? (
              <Text style={styles.actionDescription}>{action.description}</Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
