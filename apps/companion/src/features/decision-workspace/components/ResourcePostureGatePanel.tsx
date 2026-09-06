/**
 * The four ADR-054 gate choices with the Gateway's effect preview (deliverable 8).
 *
 * The operator picks a choice; the Gateway answers through
 * `runtime.posture.preview` and that plan is what is shown before the decision is
 * resolved. Nothing here resolves policy. `free-slot` is offered exactly as the
 * Gateway defines it and its typed `park-ineligible` rejection is reported as a
 * block on that choice, distinct from a failed preview request, so the operator
 * knows whether to retry or to pick something else.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  gateParkGateNotice,
  gateParkSummaryLine,
  type GateParkView,
  type ResourcePostureGateChoice,
} from '@farmslot/protocol';

import {
  gateChoiceHelp,
  gateChoiceLabel,
  type PostureChoiceAvailability,
  postureChoiceHonored,
  postureChoicesApply,
  postureChoiceWithheldReason,
  postureGatePreviewLines,
  postureGatePreviewSummary,
  postureResolveBlock,
  RUN_POSTURE_GATE_CHOICES,
  type RunPostureGateState,
} from '../../../lib/run-posture-gate';
import { policySourceLabel, rejectionMessage } from '../../../lib/run-resource-posture';
import { colors, fonts, radii, spacing } from '../../../lib/theme';

export function ResourcePostureGatePanel({
  gate,
  availability,
  disabled,
  onSelect,
}: {
  gate: RunPostureGateState;
  availability: PostureChoiceAvailability;
  disabled: boolean;
  /** Selecting the current choice again clears it; the state machine owns that toggle. */
  onSelect: (choice: ResourcePostureGateChoice) => void;
}) {
  // Outside an operator wait the Gateway ignores a gate choice, and a decision
  // this client cannot resolve through `run.resolveDecision` has no way to carry
  // one. Either way there is nothing honest to offer, so the guard lives here
  // where no caller can bypass it.
  if (!postureChoicesApply(availability)) return null;

  const plan = gate.status === 'ready' ? gate.plan : undefined;
  const block = postureResolveBlock(gate, availability);
  return (
    <View style={styles.card} testID="companion-run-posture-gate">
      <Text style={styles.title}>Resource posture for this wait</Text>
      <View style={styles.choices}>
        {RUN_POSTURE_GATE_CHOICES.map((choice) => (
          <Pressable
            accessibilityLabel={gateChoiceHelp(choice)}
            accessibilityRole="button"
            accessibilityState={{ disabled, selected: gate.choice === choice }}
            disabled={disabled}
            key={choice}
            onPress={() => onSelect(choice)}
            style={[
              styles.choice,
              gate.choice === choice && styles.choiceSelected,
              disabled && styles.choiceDisabled,
            ]}
            testID={`companion-run-posture-choice-${choice}`}
          >
            <Text style={[styles.choiceText, gate.choice === choice && styles.choiceTextSelected]}>
              {gateChoiceLabel(choice)}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.muted} testID="companion-run-posture-choice-help">
        {gate.choice
          ? gateChoiceHelp(gate.choice)
          : "No choice selected — the run's own policy applies."}
      </Text>
      {gate.status === 'loading' ? (
        <Text style={styles.muted} testID="companion-run-posture-preview-loading">
          Asking the Gateway what this would do…
        </Text>
      ) : null}
      {gate.status === 'error' ? (
        <Text style={styles.failure} testID="companion-run-posture-preview-error">
          {gate.message ?? 'Posture preview failed.'}
        </Text>
      ) : null}
      {plan ? (
        <View style={styles.plan}>
          <Text style={styles.summary} testID="companion-run-posture-preview-summary">
            {postureGatePreviewSummary(plan)}
          </Text>
          {gate.choice && !plan.rejection && !postureChoiceHonored(plan, gate.choice) ? (
            <Text style={styles.muted} testID="companion-run-posture-preview-not-honored">
              The Gateway did not resolve this plan from the choice — it came from{' '}
              {policySourceLabel(plan.policySource)}. Resolving now applies that, not the choice
              above.
            </Text>
          ) : null}
          {postureGatePreviewLines(plan).map((line) => (
            <Text
              key={`${line.action}-${line.capabilityId}`}
              style={styles.line}
              testID={`companion-run-posture-preview-${line.action}-${line.capabilityId}`}
            >
              {line.action} {line.capabilityId} — {line.reason}
            </Text>
          ))}
          {plan.effects.length ? (
            <Text style={styles.line} testID="companion-run-posture-preview-effects">
              Release effects: {plan.effects.join('; ')}
            </Text>
          ) : null}
          {plan.rejection ? (
            <Text style={styles.blocked} testID="companion-run-posture-preview-rejection">
              {rejectionMessage(plan.rejection)}
            </Text>
          ) : null}
        </View>
      ) : null}
      {block.kind === 'rejected' || block.kind === 'request-failed' ? (
        <Text
          style={block.kind === 'rejected' ? styles.blocked : styles.failure}
          testID={`companion-run-posture-block-${block.kind}`}
        >
          {block.message}
        </Text>
      ) : null}
      {gate.appliedTransition?.rejection ? (
        <Text style={styles.blocked} testID="companion-run-posture-apply-rejection">
          {rejectionMessage(gate.appliedTransition.rejection)}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The notice for a selection that will not be forwarded.
 *
 * It lives outside the panel because the panel returns null in exactly the
 * situations this reports, which is how the selection came to be dropped
 * silently in the first place.
 */
export function ResourcePostureWithheldNotice({
  gate,
  availability,
}: {
  gate: RunPostureGateState;
  availability: PostureChoiceAvailability;
}) {
  const reason = postureChoiceWithheldReason(gate, availability);
  if (!reason) return null;
  return (
    <View style={styles.withheld} testID="companion-run-posture-withheld">
      <Text style={styles.blocked}>{reason}</Text>
    </View>
  );
}

/**
 * What the operator has to know before answering a gate on a parked run.
 *
 * It lives outside `ResourcePostureGatePanel` for the same reason the withheld
 * notice does, and more sharply: a `free-slot` park moves the run's posture to
 * `parked`, which is exactly when that panel returns null. Putting the notice
 * inside it would hide "answering restores the run first" in the one case where
 * it is the most important thing on the screen.
 */
export function RunGateParkNotice({ view }: { view: GateParkView | null }) {
  const notice = gateParkGateNotice(view);
  if (!view || !notice) return null;
  const blocked = notice.kind !== 'restore-first';
  return (
    <View
      style={[styles.withheld, !blocked && styles.parkNotice]}
      testID="companion-run-gate-park-notice"
    >
      <Text
        style={blocked ? styles.blocked : styles.muted}
        testID={`companion-run-gate-park-${notice.kind}`}
      >
        {notice.message}
      </Text>
      <Text style={styles.line} testID="companion-run-gate-park-summary">
        {gateParkSummaryLine(view)}
      </Text>
      {notice.refusal ? (
        <Text style={styles.blocked} testID="companion-run-gate-park-refusal">
          Last restore refused ({notice.refusal.code}): {notice.refusal.reason}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  blocked: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.lg,
    padding: spacing.lg,
  },
  choice: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  choiceDisabled: {
    opacity: 0.5,
  },
  choiceSelected: {
    borderColor: colors.accent,
  },
  choiceText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  choiceTextSelected: {
    color: colors.accent,
  },
  choices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  failure: {
    color: colors.statusFail,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  line: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  muted: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  parkNotice: {
    borderColor: colors.bgCardHover,
  },
  plan: {
    borderTopColor: colors.bgCardHover,
    borderTopWidth: 1,
    gap: spacing.xs,
    paddingTop: spacing.md,
  },
  summary: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  title: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  withheld: {
    backgroundColor: colors.bgCard,
    borderColor: colors.statusWarn + '55',
    borderRadius: radii.lg,
    borderWidth: 1,
    marginBottom: spacing.lg,
    padding: spacing.lg,
  },
});
