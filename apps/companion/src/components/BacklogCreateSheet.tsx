import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { type BacklogCreateResult, type BacklogListResult, Methods } from '@farmslot/protocol';

import { colors, fonts, radii, spacing } from '../lib/theme';
import { useConnectionStore } from '../store/connection';
import { useFilterStore } from '../store/filters';

interface BacklogCreateSheetProps {
  visible: boolean;
  onClose: () => void;
}

export function BacklogCreateSheet({ visible, onClose }: BacklogCreateSheetProps) {
  const insets = useSafeAreaInsets();
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const selectedProjects = useFilterStore((state) => state.filters.projects);
  const availableProjects = useFilterStore((state) => state.availableProjects);
  const suggestedProject = selectedProjects.length === 1 ? selectedProjects[0] : '';
  const [project, setProject] = useState(suggestedProject);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdLabel, setCreatedLabel] = useState<string | null>(null);
  const wasVisible = useRef(false);

  useEffect(() => {
    if (visible && !wasVisible.current) {
      setProject(suggestedProject);
      setTitle('');
      setNotes('');
      setError(null);
      setCreatedLabel(null);
    }
    wasVisible.current = visible;
  }, [suggestedProject, visible]);

  const submit = async () => {
    const normalizedProject = project.trim();
    const normalizedTitle = title.trim();
    if (!normalizedProject || !normalizedTitle) {
      setError('Project and title are required.');
      return;
    }
    if (!client || status !== 'connected') {
      setError('Connect to the gateway before creating backlog work.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const created = await client.request<BacklogCreateResult>(Methods.BACKLOG_CREATE, {
        project: normalizedProject,
        title: normalizedTitle,
        sourceKind: 'manual',
        flowType: 'dev',
        notes: notes.trim() || undefined,
        autoDispatch: false,
        status: 'candidate',
      });
      const listed = await client.request<BacklogListResult>(Methods.BACKLOG_LIST, {
        project: normalizedProject,
      });
      if (!listed.items.some((item) => item.id === created.item.id)) {
        throw new Error('The gateway created the item but did not return it from backlog.list.');
      }
      setCreatedLabel(created.item.sourceRef || created.item.id);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>Create backlog item</Text>
              <Text style={styles.subtitle}>Capture work now; dispatch stays off.</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={onClose}>
              <Text style={styles.close}>Close</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Project</Text>
            <TextInput
              testID="companion-backlog-project"
              style={styles.input}
              value={project}
              onChangeText={setProject}
              placeholder="farmslot-farm"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!submitting && !createdLabel}
            />
            {availableProjects.length > 0 ? (
              <View style={styles.projectChips}>
                {availableProjects.map((projectOption) => (
                  <Pressable
                    key={projectOption}
                    style={[
                      styles.projectChip,
                      project === projectOption && styles.projectChipSelected,
                    ]}
                    onPress={() => setProject(projectOption)}
                    disabled={submitting || Boolean(createdLabel)}
                  >
                    <Text
                      style={[
                        styles.projectChipText,
                        project === projectOption && styles.projectChipTextSelected,
                      ]}
                    >
                      {projectOption}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            <Text style={styles.label}>Title</Text>
            <TextInput
              testID="companion-backlog-title"
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="What needs to change?"
              placeholderTextColor={colors.textMuted}
              editable={!submitting && !createdLabel}
            />

            <Text style={styles.label}>Notes</Text>
            <TextInput
              testID="companion-backlog-notes"
              style={[styles.input, styles.notes]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Context, expected result, or evidence"
              placeholderTextColor={colors.textMuted}
              multiline
              textAlignVertical="top"
              editable={!submitting && !createdLabel}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}
            {createdLabel ? (
              <Text testID="companion-backlog-created" style={styles.success}>
                Created {createdLabel}. It is a candidate and was not dispatched.
              </Text>
            ) : null}

            <Pressable
              testID="companion-backlog-submit"
              style={[styles.submit, (submitting || Boolean(createdLabel)) && styles.disabled]}
              onPress={() => void submit()}
              disabled={submitting || Boolean(createdLabel)}
            >
              {submitting ? (
                <ActivityIndicator color={colors.bgBase} />
              ) : (
                <Text style={styles.submitText}>Create candidate</Text>
              )}
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: '#00000099',
  },
  sheet: {
    maxHeight: '92%',
    backgroundColor: colors.bgSurface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
  },
  handle: {
    alignSelf: 'center',
    width: 44,
    height: 4,
    marginTop: spacing.md,
    borderRadius: 2,
    backgroundColor: colors.bgCardHover,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.lg,
    padding: spacing.xl,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgCard,
  },
  headerCopy: { flex: 1, gap: spacing.sm },
  title: { color: colors.textPrimary, fontSize: fonts.sizeXl, fontWeight: '800' },
  subtitle: { color: colors.textSecondary, fontSize: fonts.sizeSm },
  close: { color: colors.accent, fontSize: fonts.sizeMd, fontWeight: '700' },
  form: { gap: spacing.md, padding: spacing.xl },
  label: {
    marginTop: spacing.sm,
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  input: {
    minHeight: 46,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    backgroundColor: colors.bgBase,
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
  },
  notes: { minHeight: 110 },
  projectChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  projectChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
  },
  projectChipSelected: { borderColor: colors.accent, backgroundColor: colors.accent + '20' },
  projectChipText: { color: colors.textSecondary, fontSize: fonts.sizeXs },
  projectChipTextSelected: { color: colors.accent },
  error: { color: colors.statusFail, fontSize: fonts.sizeSm },
  success: { color: colors.statusOk, fontSize: fonts.sizeSm, lineHeight: 19 },
  submit: {
    minHeight: 48,
    marginTop: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.accent,
  },
  disabled: { opacity: 0.5 },
  submitText: { color: colors.bgBase, fontSize: fonts.sizeMd, fontWeight: '800' },
});
