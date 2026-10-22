import { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';

import type { EvidenceReviewJudgmentRow } from '@farmslot/adapter-sdk/evidence';
import { type Run, type RunDecision, type RunGateReadiness } from '@farmslot/protocol';
import {
  type PublicationGateAction,
  type PublicationGateClaim,
  publicationGateCriteria,
  publicationGateView,
  publicationReviewBlockingReason,
  type ReviewDispatchViewModel,
  reviewFallbackLine,
} from '@farmslot/review-dispatch';
import { gateClaimsHeight, publicationGateColors, skeletonTokens } from '@farmslot/theme';

import { AcceptanceClaimList } from '../../../components/AcceptanceClaimList';
import type {
  GateReviewAction,
  GateReviewSummary,
  GateReviewVerdict,
} from '../../../lib/gate-review';
import { fonts, radii, spacing } from '../../../lib/theme';
import { ReviewDispatchPicker } from '../../review-dispatch/ReviewDispatchPicker';
import { gateReviewStyles as styles } from '../styles/gate-review.styles';

import { GateClaimSkeleton } from './GateReviewSkeleton';

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
              {reviewFallbackLine(review.review) ? (
                <Text
                  style={styles.verdictModel}
                  testID={`companion-gate-review-fallback-${review.runner}`}
                >
                  {reviewFallbackLine(review.review)}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export function GateActions({
  run,
  decision,
  actions,
  sendingActionId,
  onResolve,
  reviewPicker,
  attestationReason,
  onAttestationReason,
  claims,
  judgmentRows,
  onRecordVisualReview,
  onRefreshPackage,
  pendingVisualClaimIds,
  readiness,
  onFocusClaim,
  showClaims = true,
  inlineBlockers = false,
  loading = false,
  disabled = false,
  reviewDisabled = false,
  acceptingFindings,
  onAcceptFindings,
}: {
  run?: Run | null;
  showClaims?: boolean;
  inlineBlockers?: boolean;
  loading?: boolean;
  disabled?: boolean;
  reviewDisabled?: boolean;
  claims?: readonly PublicationGateClaim[];
  judgmentRows?: readonly EvidenceReviewJudgmentRow[];
  onRecordVisualReview?: (
    id: string,
    verdict: 'confirmed' | 'rejected',
    reason?: string,
  ) => Promise<void>;
  onRefreshPackage?: () => void;
  pendingVisualClaimIds?: readonly string[];
  readiness?: RunGateReadiness;
  onFocusClaim?: (id: string) => void;
  attestationReason: string;
  onAttestationReason: (reason: string) => void;
  reviewPicker: ReviewDispatchViewModel;
  decision: RunDecision;
  actions: GateReviewAction[];
  sendingActionId: string | null;
  onResolve: (action: GateReviewAction, selectionData?: Record<string, unknown>) => void;
  /** Set by a host that starts accepting the findings elsewhere (the blocker list). */
  acceptingFindings?: boolean;
  onAcceptFindings?: () => void;
}) {
  const appearance = useColorScheme();
  const viewport = useWindowDimensions();
  const [attestingDecisionId, setAttestingDecisionId] = useState<string | null>(null);
  const [acceptingDecisionId, setAcceptingDecisionId] = useState<string | null>(null);
  const [judging, setJudging] = useState(false);
  const [moreActions, setMoreActions] = useState(false);
  const [reviewingRequest, setReviewingRequest] = useState(false);
  if (decision.resolvedAt) {
    return (
      <View style={styles.resolvedCard} testID="companion-gate-review-resolved">
        <Text style={styles.resolvedText}>
          {(run && publicationReviewBlockingReason(run)) ||
            `Resolved: ${decision.resolvedAction ?? 'resolved'} · ${new Date(decision.resolvedAt).toLocaleString()}`}
        </Text>
      </View>
    );
  }
  const view = publicationGateView({
    run,
    gate: decision,
    actions,
    claims,
    judgmentRows,
    pendingVisualClaimIds,
    readiness,
    reviewSummary:
      decision.payload?.kind === 'ready' ? decision.payload.gateSummary?.review : undefined,
    attestationReason,
    attesting: attestingDecisionId === decision.id,
    acceptingFindings: acceptingFindings ?? acceptingDecisionId === decision.id,
  });
  const accepting = view.approval?.id === view.acceptFindings?.id && Boolean(view.acceptFindings);
  const handled = (id: string) => inlineBlockers && view.blockerActionIds.includes(id);
  const declaredRows = publicationGateCriteria(
    decision.payload?.kind === 'ready' ? decision.payload : undefined,
  ).length;
  const rowCount = Math.max(view.claims.length, declaredRows);
  const palette = publicationGateColors[appearance === 'light' ? 'light' : 'dark'];
  const renderAction = (
    action: PublicationGateAction,
    primary = false,
    blockedByGate = primary,
  ) => {
    const actionDisabled =
      disabled ||
      judging ||
      Boolean(action.disabledReason) ||
      sendingActionId !== null ||
      (blockedByGate && Boolean(view.blockedReason)) ||
      (action.id === 'request-review' && reviewDisabled);
    const guarded = { ...action, disabledReason: action.disabledReason ?? null };
    if (action.id === 'request-review')
      return (
        <ReviewDispatchPicker
          key={action.id}
          model={reviewPicker}
          disabled={actionDisabled}
          testID="companion-publish-gate-review"
          action="request-review"
          actionLabel={action.label}
          triggerLabel={action.label}
          open={reviewingRequest}
          onOpenChange={(open) => {
            setReviewingRequest(open);
            if (open) {
              setAttestingDecisionId(null);
              setAcceptingDecisionId(null);
            }
          }}
          onInvoke={(_id, payload) => onResolve(guarded, { reviewRequest: payload })}
        />
      );
    return (
      <Pressable
        key={action.id}
        testID={`companion-gate-review-action-${action.id}`}
        accessibilityRole="button"
        accessibilityLabel={action.label}
        accessibilityState={{ disabled: actionDisabled }}
        disabled={actionDisabled}
        onPress={() => onResolve(guarded)}
        style={[
          gateStyles.button,
          {
            borderColor: palette.border,
            backgroundColor: primary ? palette.accent : palette.surface,
          },
          actionDisabled && gateStyles.disabled,
        ]}
      >
        <Text style={{ color: primary ? palette.onAccent : palette.text, fontWeight: '600' }}>
          {sendingActionId === action.id ? 'Submitting…' : action.label}
        </Text>
      </Pressable>
    );
  };
  return (
    <View
      testID="companion-gate-review-actions"
      style={[
        gateStyles.panel,
        { backgroundColor: palette.background, borderColor: palette.border },
      ]}
    >
      {!inlineBlockers ||
      !view.blockedReason ||
      judging ||
      sendingActionId ||
      accepting ||
      attestingDecisionId === decision.id ? (
        <Text
          testID="companion-gate-review-approve-reason"
          accessibilityRole="header"
          accessibilityLabel={view.status}
          numberOfLines={2}
          style={[gateStyles.status, { color: palette.text }]}
        >
          {judging
            ? 'Saving judgment and refreshing…'
            : sendingActionId === 'refresh-package'
              ? 'Refreshing…'
              : view.status}
        </Text>
      ) : null}
      {view.warnings.map((warning) => (
        <Text
          key={warning}
          testID="companion-gate-review-warning"
          style={[gateStyles.status, { color: palette.text }]}
        >
          {warning}
        </Text>
      ))}
      {showClaims && rowCount ? (
        <View accessibilityLabel="Acceptance judgments">
          <Text style={[gateStyles.label, { color: palette.text }]}>Acceptance judgments</Text>
          <ScrollView
            nestedScrollEnabled
            style={{ height: gateClaimsHeight(rowCount, viewport.height) }}
          >
            {loading && !view.claims.length
              ? Array.from({ length: rowCount }, (_, index) => (
                  <GateClaimSkeleton
                    key={index}
                    color={skeletonTokens.colors[appearance === 'light' ? 'light' : 'dark']}
                  />
                ))
              : null}
            <AcceptanceClaimList
              rows={view.claims}
              onFocus={onFocusClaim}
              onRecord={onRecordVisualReview}
              disabled={disabled || judging || sendingActionId !== null}
              onBusyChange={setJudging}
              testIDPrefix="gate-ac"
            />
          </ScrollView>
        </View>
      ) : null}
      {view.attestation && attestingDecisionId === decision.id ? (
        <View style={gateStyles.section} accessibilityLabel="Evidence attestation">
          <Text style={[gateStyles.label, { color: palette.text }]}>
            Reason for evidence policy attestation
          </Text>
          <TextInput
            testID="companion-evidence-attestation-reason"
            accessibilityLabel="Reason for evidence policy attestation"
            multiline
            value={attestationReason}
            editable={!disabled && sendingActionId === null}
            onChangeText={onAttestationReason}
            style={[
              gateStyles.input,
              {
                color: palette.text,
                borderColor: palette.border,
                backgroundColor: palette.surface,
              },
            ]}
          />
        </View>
      ) : null}
      {accepting ? (
        <View style={gateStyles.section} accessibilityLabel="Accept review findings">
          <Text style={[gateStyles.label, { color: palette.text }]}>Open review findings</Text>
          {view.findings.map((finding, index) => (
            <Text key={index} style={{ color: palette.text }}>
              {`${finding.file}${finding.line ? `:${finding.line}` : ''}  ${finding.description}`}
            </Text>
          ))}
          {view.combinedApproval ? (
            <View
              accessibilityLabel="Evidence policy gaps being attested"
              testID="companion-combined-evidence-gaps"
            >
              <Text style={[gateStyles.label, { color: palette.text }]}>
                Evidence policy gaps being attested
              </Text>
              {view.evidencePolicyReasons.map((reason, index) => (
                <Text key={index} style={{ color: palette.text }}>
                  {reason.message}
                </Text>
              ))}
            </View>
          ) : null}
          <Text style={[gateStyles.label, { color: palette.text }]}>
            {view.combinedApproval
              ? 'Reason for accepting findings and attesting evidence'
              : 'Reason for accepting these findings'}
          </Text>
          <TextInput
            testID="companion-accept-findings-reason"
            accessibilityLabel={
              view.combinedApproval
                ? 'Reason for accepting findings and attesting evidence'
                : 'Reason for accepting these findings'
            }
            multiline
            value={attestationReason}
            editable={!disabled && sendingActionId === null}
            onChangeText={onAttestationReason}
            style={[
              gateStyles.input,
              {
                color: palette.text,
                borderColor: palette.border,
                backgroundColor: palette.surface,
              },
            ]}
          />
        </View>
      ) : null}
      <View
        style={[
          gateStyles.section,
          { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
        ]}
        accessibilityLabel="Publication actions"
      >
        {view.refreshRequired && onRefreshPackage ? (
          <Pressable
            accessibilityRole="button"
            style={gateStyles.button}
            onPress={onRefreshPackage}
            disabled={disabled || judging || sendingActionId !== null}
          >
            <Text style={{ color: palette.text }}>Refresh package</Text>
          </Pressable>
        ) : null}
        {view.sendBack ? renderAction(view.sendBack, true, false) : null}
        {view.approval &&
        (!inlineBlockers || !view.blockedReason || accepting || attestingDecisionId === decision.id)
          ? renderAction(view.approval, true)
          : null}
        {view.primaryActions
          .filter((action) => !handled(action.id))
          .map((action) => renderAction(action))}
        {view.acceptFindings && !accepting && !handled(view.acceptFindings.id) ? (
          <Pressable
            accessibilityRole="button"
            accessibilityHint={view.acceptFindings.description}
            testID="companion-gate-review-accept-findings"
            style={gateStyles.button}
            onPress={() => {
              setReviewingRequest(false);
              if (onAcceptFindings) onAcceptFindings();
              else setAcceptingDecisionId(decision.id);
            }}
          >
            <Text style={{ color: palette.text }}>{view.acceptFindings.label}</Text>
          </Pressable>
        ) : null}
        {view.attestation || view.secondaryActions.length ? (
          <Pressable
            style={gateStyles.button}
            accessibilityRole="button"
            accessibilityState={{ expanded: moreActions }}
            testID="companion-gate-review-more-actions"
            onPress={() => setMoreActions(!moreActions)}
          >
            <Text style={{ color: palette.secondary }}>More actions</Text>
          </Pressable>
        ) : null}
        {moreActions ? (
          <View style={gateStyles.section}>
            {view.attestation && attestingDecisionId !== decision.id ? (
              <Pressable
                accessibilityRole="button"
                accessibilityHint={view.attestation.description}
                style={gateStyles.button}
                onPress={() => setAttestingDecisionId(decision.id)}
              >
                <Text style={{ color: palette.text }}>Attest evidence</Text>
              </Pressable>
            ) : null}
            {view.secondaryActions.map((action) => renderAction(action))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const gateStyles = StyleSheet.create({
  panel: { padding: spacing.md, borderTopWidth: 1, gap: spacing.md },
  status: { fontSize: fonts.sizeMd, fontWeight: '600' },
  label: { fontSize: fonts.sizeSm, fontWeight: '600' },
  button: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    alignItems: 'center',
  },
  disabled: { opacity: 0.65 },
  section: { gap: spacing.md },
  input: {
    minHeight: 72,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    textAlignVertical: 'top',
  },
});
