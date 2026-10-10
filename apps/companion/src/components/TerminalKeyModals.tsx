import React, { useState } from 'react';
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { RUNNER_MOBILE_KEY_PROFILES, type RunnerMobileKeyProfile } from '@farmslot/protocol';

import {
  MAX_TERMINAL_CUSTOM_KEY_LABEL_LENGTH,
  MAX_TERMINAL_CUSTOM_KEYS,
  type ResolvedRunnerKeyProfile,
  TERMINAL_KEY_PALETTE,
} from '../lib/terminal-controls';
import { colors, fonts, radii, spacing } from '../lib/theme';
import { useTerminalPrefsStore } from '../store/terminal-prefs';

const PALETTE_LABELS = new Map(TERMINAL_KEY_PALETTE.map((entry) => [entry.id, entry.label]));
const PROFILES: readonly RunnerMobileKeyProfile[] = Object.values(RUNNER_MOBILE_KEY_PROFILES);

function paletteTestId(id: string): string {
  return `terminal-custom-key-palette-${id.replace('+', '-')}`;
}

function ModalCard({
  title,
  onClose,
  closeTestID,
  children,
}: {
  title: string;
  onClose: () => void;
  closeTestID: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable style={styles.card} onPress={(event) => event.stopPropagation()}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable testID={closeTestID} onPress={onClose} hitSlop={8}>
            <Text style={styles.close}>Close</Text>
          </Pressable>
        </View>
        {children}
      </Pressable>
    </Pressable>
  );
}

/** Picks the runner key row for one pane. Auto clears the saved choice. */
export function RunnerKeyProfilePicker({
  visible,
  resolved,
  onClose,
  onSelect,
}: {
  visible: boolean;
  resolved: ResolvedRunnerKeyProfile;
  onClose: () => void;
  onSelect: (runnerId: string | null) => void;
}) {
  const saved = resolved.source === 'saved' ? resolved.runnerId : null;
  const options = [
    { id: null, title: 'Auto', meta: 'Linked run, then pane process' },
    ...PROFILES.map((profile) => ({
      id: profile.runnerId,
      title: profile.label,
      meta: `${profile.keys.length} key${profile.keys.length === 1 ? '' : 's'}`,
    })),
  ];
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <ModalCard title="Runner keys" onClose={onClose} closeTestID="terminal-runner-profile-close">
        <ScrollView style={styles.list}>
          {options.map((option) => (
            <Pressable
              key={option.id ?? 'auto'}
              testID={`terminal-runner-profile-option-${option.id ?? 'auto'}`}
              style={[styles.item, option.id === saved && styles.itemActive]}
              onPress={() => onSelect(option.id)}
            >
              <Text style={styles.itemTitle}>{option.title}</Text>
              <Text style={styles.itemMeta}>{option.meta}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </ModalCard>
    </Modal>
  );
}

/** Adds and deletes the device-level keys shown in every terminal's Yours row. */
export function CustomTerminalKeysModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const customKeys = useTerminalPrefsStore((s) => s.customKeys);
  const addCustomKey = useTerminalPrefsStore((s) => s.addCustomKey);
  const deleteCustomKey = useTerminalPrefsStore((s) => s.deleteCustomKey);
  const [label, setLabel] = useState('');
  const [sequence, setSequence] = useState<string | null>(null);
  const [danger, setDanger] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const failure = addCustomKey({ label, sequence: sequence ?? '', danger });
    setError(failure);
    if (failure) return;
    setLabel('');
    setSequence(null);
    setDanger(false);
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <ModalCard title="Your keys" onClose={onClose} closeTestID="terminal-custom-keys-close">
        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {customKeys.map((key, index) => (
            <View key={key.label} style={[styles.item, styles.keyItem]}>
              <Text style={[styles.itemTitle, key.danger && styles.dangerText]}>
                {key.label} · {PALETTE_LABELS.get(key.sequence)}
              </Text>
              <Pressable
                testID={`terminal-custom-key-delete-${index}`}
                onPress={() => deleteCustomKey(key.label)}
                hitSlop={8}
              >
                <Text style={styles.deleteText}>Delete</Text>
              </Pressable>
            </View>
          ))}
          {customKeys.length < MAX_TERMINAL_CUSTOM_KEYS ? (
            <View style={styles.form}>
              <TextInput
                testID="terminal-custom-key-label"
                style={styles.input}
                value={label}
                onChangeText={setLabel}
                placeholder="Label"
                placeholderTextColor={colors.textMuted}
                maxLength={MAX_TERMINAL_CUSTOM_KEY_LABEL_LENGTH}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={styles.palette}>
                {TERMINAL_KEY_PALETTE.map((entry) => (
                  <Pressable
                    key={entry.id}
                    testID={paletteTestId(entry.id)}
                    style={[styles.paletteKey, sequence === entry.id && styles.paletteKeyActive]}
                    onPress={() => {
                      Keyboard.dismiss();
                      setSequence(entry.id);
                    }}
                  >
                    <Text style={styles.paletteText}>{entry.label}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.formActions}>
                <Pressable
                  testID="terminal-custom-key-danger"
                  accessibilityRole="switch"
                  accessibilityState={{ checked: danger }}
                  style={[styles.paletteKey, danger && styles.dangerToggleActive]}
                  onPress={() => setDanger(!danger)}
                >
                  <Text style={[styles.paletteText, danger && styles.dangerText]}>
                    {danger ? 'Danger on' : 'Danger off'}
                  </Text>
                </Pressable>
                <Pressable testID="terminal-custom-key-add" style={styles.addButton} onPress={add}>
                  <Text style={styles.addText}>Add key</Text>
                </Pressable>
              </View>
              {error ? <Text style={styles.error}>{error}</Text> : null}
            </View>
          ) : (
            <Text style={styles.itemMeta}>Delete a key to add another.</Text>
          )}
        </ScrollView>
      </ModalCard>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    flex: 1,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    backgroundColor: colors.bgSurface,
    borderColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    maxHeight: '80%',
    padding: spacing.md,
    width: '100%',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  title: {
    color: colors.textPrimary,
    fontSize: fonts.sizeLg,
    fontWeight: '600',
  },
  close: {
    color: colors.accent,
    fontSize: 13,
  },
  list: {
    marginTop: spacing.xs,
  },
  item: {
    backgroundColor: colors.bgBase,
    borderColor: colors.bgCard,
    borderRadius: radii.lg,
    borderWidth: 1,
    marginBottom: spacing.xs,
    padding: spacing.md,
  },
  itemActive: {
    borderColor: colors.statusOk,
  },
  keyItem: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  itemTitle: {
    color: colors.textPrimary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeMd,
    fontWeight: '600',
  },
  itemMeta: {
    color: colors.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
    marginTop: 2,
  },
  deleteText: {
    color: colors.statusFail,
    fontSize: 13,
    fontWeight: '700',
  },
  form: {
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  input: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  palette: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  paletteKey: {
    alignItems: 'center',
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    minWidth: 40,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  paletteKeyActive: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent,
  },
  paletteText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  formActions: {
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  dangerToggleActive: {
    backgroundColor: colors.statusFail + '20',
    borderColor: colors.statusFail + '70',
  },
  dangerText: { color: colors.statusFail },
  addButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    flexGrow: 1,
    paddingVertical: spacing.sm,
  },
  addText: {
    color: colors.bgBase,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  error: {
    color: colors.statusFail,
    fontSize: fonts.sizeSm,
  },
});
