import { useState } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import type { ReviewRequestPayload, Run, RunDecision } from '@farmslot/protocol';
import {
  anotherReviewRoundView,
  type PublicationBlocker,
  type PublicationBlockerAction,
  type PublicationGateAction,
  publicationGateBlockers,
  publicationGateView,
  type ReviewDispatchViewModel,
  untestableOverrideView,
} from '@farmslot/review-dispatch';
import { publicationGateColors } from '@farmslot/theme';

import { ReasonSheet } from '../../../components/ReasonSheet';
import { fonts, radii, spacing } from '../../../lib/theme';
import { ReviewDispatchPicker } from '../../review-dispatch/ReviewDispatchPicker';

type Sheet =
  | { kind: 'skip-criterion'; claimId: string; text: string }
  | { kind: 'another-round'; text: string };

/**
 * What blocks publish, at the top of the gate: each blocker with its one plain action,
 * from the same shared rule as desktop.
 */
export function GateBlockers({
  run,
  decision,
  actions,
  evidenceModel,
  reviewer,
  busy = false,
  onSkip,
  acceptingFindings,
  onAcceptFindingsChange,
  onAnotherRound,
  reviewPicker,
  onRequestReview,
  onReviewEvidence,
}: {
  run?: Run | null;
  decision: RunDecision;
  actions: readonly PublicationGateAction[];
  evidenceModel?: EvidenceReviewModel | null;
  reviewer?: Parameters<EvidenceReviewModel['judgmentRows']>[0];
  busy?: boolean;
  onSkip: (claimId: string, reason: string) => Promise<void>;
  acceptingFindings: boolean;
  onAcceptFindingsChange: (accepting: boolean) => void;
  onAnotherRound: (brief: string) => Promise<void>;
  reviewPicker: ReviewDispatchViewModel;
  onRequestReview: (payload: ReviewRequestPayload) => void;
  onReviewEvidence: (claimId: string) => void;
}) {
  const appearance = useColorScheme();
  const palette = publicationGateColors[appearance === 'light' ? 'light' : 'dark'];
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [sending, setSending] = useState(false);
  const [findingKey, setFindingKey] = useState<string | null>(null);
  const [requestingReview, setRequestingReview] = useState(false);
  const payload = decision.payload?.kind === 'ready' ? decision.payload : undefined;
  const readiness = payload?.gateReadiness;
  const resolved = Boolean(decision.resolvedAt);
  const view = publicationGateView({
    run,
    gate: decision,
    actions,
    judgmentRows: evidenceModel?.judgmentRows(reviewer ?? null),
    pendingVisualClaimIds: evidenceModel?.pendingVisualClaimIds,
    readiness,
    resolved,
  });
  const blockers = publicationGateBlockers({
    view,
    readiness,
    gate: decision,
    resolved,
    canSkip: (claimId) => Boolean(evidenceModel?.claimOverrideCandidate(claimId)),
    budget: payload?.reviewRoundBudget,
  });
  if (!blockers.length) return null;
  const disabled = busy || sending;
  const send = async (work: () => Promise<void>) => {
    setSending(true);
    try {
      await work();
      setSheet(null);
    } finally {
      setSending(false);
    }
  };
  const choose = (blocker: PublicationBlocker, action: PublicationBlockerAction) => {
    if (action.kind === 'see-findings') {
      setFindingKey(findingKey === blocker.key ? null : blocker.key);
      return;
    }
    if (action.kind === 'review-evidence') {
      onReviewEvidence(action.claimId);
      return;
    }
    onAcceptFindingsChange(action.kind === 'accept-findings');
    setRequestingReview(false);
    if (action.kind === 'accept-findings') setSheet(null);
    else
      setSheet(
        action.kind === 'skip-criterion'
          ? { kind: 'skip-criterion', claimId: action.claimId, text: '' }
          : action.kind === 'another-round'
            ? { kind: 'another-round', text: '' }
            : null,
      );
  };
  const renderSheet = (blocker: PublicationBlocker) => {
    const action = blocker.actions.find((entry) => entry.kind === sheet?.kind);
    if (acceptingFindings || !sheet || !action || sheet.kind !== action.kind) return null;
    const change = (text: string) => setSheet({ ...sheet, text });
    if (sheet.kind === 'skip-criterion' && action.kind === 'skip-criterion') {
      if (sheet.claimId !== action.claimId) return null;
      const skip = untestableOverrideView(sheet.claimId, sheet.text);
      return (
        <ReasonSheet
          title={skip.title}
          hint={skip.hint}
          label={skip.reasonLabel}
          placeholder={skip.placeholder}
          value={sheet.text}
          confirmLabel={skip.confirm}
          cancelLabel={skip.cancel}
          canConfirm={skip.canConfirm}
          busy={disabled}
          testID="companion-blocker-skip"
          onChange={change}
          onConfirm={() => void send(() => onSkip(sheet.claimId, sheet.text))}
          onCancel={() => setSheet(null)}
        />
      );
    }
    if (sheet.kind !== 'another-round' || !payload?.reviewRoundBudget) return null;
    const round = anotherReviewRoundView(payload.reviewRoundBudget, sheet.text);
    return (
      <ReasonSheet
        title={round.title}
        hint={round.hint}
        label={round.reasonLabel}
        placeholder={round.placeholder}
        value={sheet.text}
        confirmLabel={round.confirm}
        cancelLabel={round.cancel}
        canConfirm={round.canConfirm}
        busy={disabled}
        testID="companion-blocker-round"
        onChange={change}
        onConfirm={() => void send(() => onAnotherRound(sheet.text))}
        onCancel={() => setSheet(null)}
      />
    );
  };
  return (
    <View
      testID="companion-gate-blockers"
      accessibilityLabel="What's blocking publish"
      style={[styles.panel, { borderColor: palette.border, backgroundColor: palette.background }]}
    >
      <Text style={[styles.title, { color: palette.warning }]}>What&apos;s blocking publish</Text>
      {blockers.map((blocker) => (
        <View key={blocker.key} style={styles.row}>
          <Text style={{ color: palette.text }}>{blocker.message}</Text>
          {blocker.findings.map((finding, index) => (
            <Text key={index} style={{ color: palette.text }}>
              {finding.summary}
            </Text>
          ))}
          <View style={styles.actions}>
            {blocker.actions.map((action) =>
              action.kind === 'request-review' ? (
                <ReviewDispatchPicker
                  key={action.kind}
                  model={reviewPicker}
                  disabled={disabled}
                  triggerLabel={action.label}
                  open={requestingReview}
                  onOpenChange={(open) => {
                    setRequestingReview(open);
                    if (open) {
                      setSheet(null);
                      onAcceptFindingsChange(false);
                    }
                  }}
                  action="request-review"
                  actionLabel="Request review"
                  testID="companion-blocker-review-picker"
                  onInvoke={(_action, payload) => onRequestReview(payload)}
                />
              ) : (
                <Pressable
                  key={action.kind}
                  accessibilityRole="button"
                  testID={`companion-blocker-${action.kind}`}
                  disabled={disabled}
                  onPress={() => choose(blocker, action)}
                  style={[
                    styles.action,
                    { borderColor: palette.border, backgroundColor: palette.surface },
                    disabled && styles.disabled,
                  ]}
                >
                  <Text style={[styles.actionLabel, { color: palette.text }]}>{action.label}</Text>
                </Pressable>
              ),
            )}
          </View>
          {findingKey === blocker.key
            ? blocker.findings.map((finding, index) => (
                <Text key={index} style={{ color: palette.text }}>
                  {finding.file}
                  {finding.line ? `:${finding.line}` : ''}
                  {' · '}
                  {finding.description}
                </Text>
              ))
            : null}
          {renderSheet(blocker)}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: spacing.md, padding: spacing.lg, borderBottomWidth: 1 },
  title: { fontSize: fonts.sizeSm, fontWeight: '700' },
  row: { gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  action: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderRadius: radii.md,
  },
  actionLabel: { fontWeight: '600' },
  disabled: { opacity: 0.65 },
});
