import { Pressable, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';

import { publicationGateColors } from '@farmslot/theme';

import { fonts, radii, spacing } from '../lib/theme';

/** A gate action that needs a written reason: title, why, the reason, confirm and cancel. */
export interface ReasonSheetProps {
  title: string;
  hint: string;
  label: string;
  placeholder: string;
  value: string;
  confirmLabel: string;
  cancelLabel: string;
  canConfirm: boolean;
  busy?: boolean;
  /** Prefix of the sheet's test ids: `<id>-reason`, `<id>-confirm`, `<id>-cancel`. */
  testID: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The one reason sheet the gate's criterion and review actions share, as on desktop. */
export function ReasonSheet(props: ReasonSheetProps) {
  const appearance = useColorScheme();
  const palette = publicationGateColors[appearance === 'light' ? 'light' : 'dark'];
  const confirmDisabled = Boolean(props.busy) || !props.canConfirm;
  return (
    <View
      accessibilityLabel={props.title}
      style={[styles.sheet, { borderColor: palette.border, backgroundColor: palette.surface }]}
    >
      <Text style={[styles.title, { color: palette.text }]}>{props.title}</Text>
      <Text style={{ color: palette.secondary }}>{props.hint}</Text>
      <Text style={[styles.label, { color: palette.text }]}>{props.label}</Text>
      <TextInput
        testID={`${props.testID}-reason`}
        accessibilityLabel={props.label}
        multiline
        value={props.value}
        editable={!props.busy}
        placeholder={props.placeholder}
        placeholderTextColor={palette.secondary}
        onChangeText={props.onChange}
        style={[
          styles.input,
          {
            color: palette.text,
            borderColor: palette.border,
            backgroundColor: palette.background,
          },
        ]}
      />
      <View style={styles.actions}>
        <Pressable
          testID={`${props.testID}-confirm`}
          accessibilityRole="button"
          accessibilityState={{ disabled: confirmDisabled }}
          disabled={confirmDisabled}
          onPress={props.onConfirm}
          style={[
            styles.button,
            { borderColor: palette.accent, backgroundColor: palette.accent },
            confirmDisabled && styles.disabled,
          ]}
        >
          <Text style={[styles.buttonText, { color: palette.onAccent }]}>{props.confirmLabel}</Text>
        </Pressable>
        <Pressable
          testID={`${props.testID}-cancel`}
          accessibilityRole="button"
          disabled={props.busy}
          onPress={props.onCancel}
          style={[styles.button, { borderColor: palette.border, backgroundColor: palette.surface }]}
        >
          <Text style={[styles.buttonText, { color: palette.text }]}>{props.cancelLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    gap: spacing.md,
    marginTop: spacing.sm,
    padding: spacing.lg,
    borderWidth: 1,
    borderRadius: radii.md,
  },
  title: { fontSize: fonts.sizeSm, fontWeight: '700' },
  label: { fontSize: fonts.sizeSm, fontWeight: '600' },
  input: {
    minHeight: 72,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    textAlignVertical: 'top',
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  button: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
  },
  buttonText: { fontWeight: '600' },
  disabled: { opacity: 0.65 },
});
