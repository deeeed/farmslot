import { Ionicons } from '@expo/vector-icons';
import React, { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, fonts, radii, spacing } from '../../lib/theme';

export function PlanningSection({
  title,
  summary,
  initiallyOpen = false,
  children,
}: {
  title: string;
  summary?: string;
  initiallyOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View style={styles.section}>
      <Pressable style={styles.sectionHeader} onPress={() => setOpen((current) => !current)}>
        <View style={styles.sectionCopy}>
          <Text style={styles.sectionTitle}>{title}</Text>
          {summary ? <Text style={styles.sectionSummary}>{summary}</Text> : null}
        </View>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.accent} />
      </Pressable>
      {open ? <View style={styles.sectionBody}>{children}</View> : null}
    </View>
  );
}

export function PlanningField({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  keyboardType,
  editable = true,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  keyboardType?: 'default' | 'numeric' | 'url';
  editable?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.multiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        keyboardType={keyboardType}
        autoCapitalize="none"
        autoCorrect={false}
        editable={editable}
      />
    </View>
  );
}

export function PlanningChoices<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.choices}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value || '__default'}
              style={[styles.choice, selected && styles.choiceSelected]}
              onPress={() => onChange(option.value)}
            >
              <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>
                {option.label ?? (option.value || 'default')}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function PlanningToggle({
  label,
  detail,
  value,
  onChange,
}: {
  label: string;
  detail?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Pressable style={styles.toggle} onPress={() => onChange(!value)}>
      <Ionicons
        name={value ? 'checkbox' : 'square-outline'}
        size={21}
        color={value ? colors.accent : colors.textMuted}
      />
      <View style={styles.toggleCopy}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {detail ? <Text style={styles.toggleDetail}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: colors.bgSurface,
    borderColor: colors.bgCardHover,
    borderRadius: radii.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
  },
  sectionCopy: { flex: 1, gap: spacing.xs },
  sectionTitle: { color: colors.textPrimary, fontSize: fonts.sizeMd, fontWeight: '900' },
  sectionSummary: { color: colors.textMuted, fontSize: fonts.sizeXs, lineHeight: 15 },
  sectionBody: {
    borderTopColor: colors.bgCardHover,
    borderTopWidth: 1,
    gap: spacing.lg,
    padding: spacing.lg,
  },
  field: { gap: spacing.sm },
  label: {
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  multiline: { minHeight: 108 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: {
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  choiceSelected: { backgroundColor: colors.accent + '20', borderColor: colors.accent },
  choiceText: { color: colors.textMuted, fontSize: fonts.sizeXs, fontWeight: '700' },
  choiceTextSelected: { color: colors.accent },
  toggle: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.md },
  toggleCopy: { flex: 1, gap: spacing.xs },
  toggleLabel: { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '800' },
  toggleDetail: { color: colors.textMuted, fontSize: fonts.sizeXs, lineHeight: 16 },
});
