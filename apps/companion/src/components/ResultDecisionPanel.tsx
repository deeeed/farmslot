import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  resultDecisionActionReady,
  type ResultDecisionActionView,
  type ResultDecisionView,
} from '@farmslot/review-dispatch';

import { baseStyles, colors, fonts, radii, spacing } from '../lib/theme';

/**
 * A run held `needs-decision` (ADR-065 Amendment 7): why it stopped, its findings or
 * refused prerequisite, what it delivered, and the three actions from the shared view.
 * Unavailable actions stay visible with their reason; Accept takes a written reason.
 */
export function ResultDecisionPanel({
  view,
  disabled = false,
  onAction,
}: {
  view: ResultDecisionView;
  disabled?: boolean;
  onAction: (actionId: ResultDecisionActionView['id'], reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [showDetail, setShowDetail] = useState(true);
  useEffect(() => setReason(''), [view.decisionId]);
  return (
    <View testID="companion-result-decision">
      <Text style={styles.reason}>{view.reason}</Text>
      <Text style={baseStyles.textMuted}>
        {view.delivered.label} <Text style={styles.mono}>{view.delivered.value}</Text>
      </Text>
      {view.detail ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showDetail }}
            style={styles.toggle}
            onPress={() => setShowDetail((open) => !open)}
          >
            <Text style={styles.toggleText}>{view.detail.title}</Text>
          </Pressable>
          {showDetail
            ? view.detail.items.map((item, index) => (
                <Text key={`${item.location ?? ''}-${index}`} style={styles.item}>
                  {item.location ? <Text style={styles.mono}>{item.location} </Text> : null}
                  {item.description}
                </Text>
              ))
            : null}
        </>
      ) : null}
      {view.actions.map((action) => {
        const ready = !disabled && resultDecisionActionReady(action, reason);
        return (
          <View
            key={action.id}
            testID={`companion-result-action-${action.id}`}
            style={styles.action}
          >
            {action.available && action.requiresReason ? (
              <TextInput
                testID="companion-result-accept-reason"
                accessibilityLabel="Why accept this result"
                placeholder="Why accept this result"
                placeholderTextColor={colors.textMuted}
                value={reason}
                onChangeText={setReason}
                multiline
                style={styles.input}
              />
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={!ready}
              accessibilityState={{ disabled: !ready }}
              style={[
                styles.button,
                action.style === 'primary' && { backgroundColor: colors.accent },
                action.style === 'danger' && { backgroundColor: colors.statusFail },
                !ready && styles.disabled,
              ]}
              onPress={() => onAction(action.id, reason)}
            >
              <Text style={styles.buttonText}>{action.label}</Text>
            </Pressable>
            {action.available ? (
              action.note ? (
                <Text style={baseStyles.textMuted}>{action.note}</Text>
              ) : null
            ) : (
              <Text style={baseStyles.textMuted}>{action.unavailableReason}</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  reason: { color: colors.textPrimary, fontSize: fonts.sizeMd, marginBottom: spacing.sm },
  mono: { fontFamily: fonts.mono, color: colors.textSecondary },
  toggle: { minHeight: 44, justifyContent: 'center' },
  toggleText: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '700' },
  item: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.textMuted,
  },
  action: { marginTop: spacing.md, gap: spacing.sm },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.textMuted,
    borderRadius: radii.md,
    padding: spacing.md,
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
  },
  button: {
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
  },
  disabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontSize: fonts.sizeMd, fontWeight: '800' },
});
