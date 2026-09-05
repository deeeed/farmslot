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

import type { ResourcePosture, ResourcePostureGateChoice } from '@farmslot/protocol';

import {
  gateChoiceHelp,
  gateChoiceLabel,
  postureChoiceHonored,
  postureChoicesApply,
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
  runPosture,
  disabled,
  onSelect,
}: {
  gate: RunPostureGateState;
  runPosture: ResourcePosture | undefined;
  disabled: boolean;
  /** Selecting the current choice again clears it; the state machine owns that toggle. */
  onSelect: (choice: ResourcePostureGateChoice) => void;
}) {
  // Outside an operator wait the Gateway ignores a gate choice, so there is
  // nothing honest to offer. The guard lives here so no caller can bypass it.
  if (!postureChoicesApply(runPosture)) return null;

  const plan = gate.status === 'ready' ? gate.plan : undefined;
  const block = postureResolveBlock(gate);
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
});
