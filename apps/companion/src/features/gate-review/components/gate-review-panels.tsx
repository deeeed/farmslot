import { Pressable, Text, TextInput, View } from 'react-native';

import {
  APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION,
  isValidEvidenceAttestationReason,
  type RunDecision,
} from '@farmslot/protocol';
import type { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import type {
  GateReviewAction,
  GateReviewSummary,
  GateReviewVerdict,
} from '../../../lib/gate-review';
import { ReviewDispatchPicker } from '../../review-dispatch/ReviewDispatchPicker';
import { gateReviewStyles as styles } from '../styles/gate-review.styles';

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

export function GateSummaryCard({
  summary,
  onOpenLog,
}: {
  summary: GateReviewSummary;
  onOpenLog: (path: string) => void;
}) {
  return (
    <View style={styles.summaryCard} testID="companion-gate-review-summary">
      <Text style={styles.kind}>Publish gate</Text>
      <Text style={styles.title}>{summary.title}</Text>
      {(summary.deterministicChecks ?? []).map((check) => (
        <View key={`${check.checklist}:${check.stepNumber}`} testID="companion-ci-parity-record">
          <Text style={styles.sectionTitle}>CI parity</Text>
          <Text style={styles.metaValue}>{check.command ?? check.reference}</Text>
          <Text style={styles.metaValue}>
            {check.status} · exit {check.exitCode ?? '-'}
          </Text>
          {check.message ? <Text style={styles.muted}>{check.message}</Text> : null}
          {check.logPath ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="View CI parity log"
              onPress={() => onOpenLog(check.logPath!)}
            >
              <Text style={styles.metaValue}>View log</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
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

export function PublishGuardNotice({
  actions,
  testID,
  attestationReason = '',
  onAttestationReason,
}: {
  actions: GateReviewAction[];
  testID: string;
  attestationReason?: string;
  onAttestationReason?: (reason: string) => void;
}) {
  const withheld = actions.filter((action) => action.disabledReason);
  const attestation =
    onAttestationReason &&
    actions.some((action) => action.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION);
  if (withheld.length === 0 && !attestation) return null;
  return (
    <View style={styles.guardCard} testID={testID}>
      {attestation ? (
        <>
          <Text style={styles.guardText}>Reason for evidence policy attestation</Text>
          <TextInput
            testID="companion-evidence-attestation-reason"
            accessibilityLabel="Reason for evidence policy attestation"
            multiline
            value={attestationReason}
            onChangeText={onAttestationReason}
            style={[styles.guardText, { borderWidth: 1, padding: 8 }]}
          />
        </>
      ) : null}
      {withheld.length ? <Text style={styles.guardTitle}>Publish approval is disabled</Text> : null}
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
  attestationReason,
  onAttestationReason,
}: {
  attestationReason: string;
  onAttestationReason: (reason: string) => void;
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
      <PublishGuardNotice
        actions={actions}
        testID="companion-gate-review-approve-reason"
        attestationReason={attestationReason}
        onAttestationReason={onAttestationReason}
      />
      {actions.map((action) => {
        const disabled =
          Boolean(action.disabledReason) ||
          sendingActionId !== null ||
          (action.id === APPROVE_PUBLISH_EVIDENCE_ATTESTED_ACTION &&
            !isValidEvidenceAttestationReason(attestationReason));
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
