import React, { useState } from 'react';
import {
  ActivityIndicator,
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

import { FormSheetHeader } from './FormSheetHeader';

export function BacklogCreateForm() {
  const insets = useSafeAreaInsets();
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const selectedProjects = useFilterStore((state) => state.filters.projects);
  const availableProjects = useFilterStore((state) => state.availableProjects);
  const [project, setProject] = useState(selectedProjects.length === 1 ? selectedProjects[0] : '');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdLabel, setCreatedLabel] = useState<string | null>(null);

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
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + spacing.xl }]}
      keyboardShouldPersistTaps="handled"
    >
      <FormSheetHeader title="Create backlog item" />
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
              style={[styles.projectChip, project === projectOption && styles.projectChipSelected]}
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
          Created {createdLabel} as a candidate.
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
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bgBase, flex: 1 },
  form: { gap: spacing.md, padding: spacing.xl },
  label: {
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
    marginTop: spacing.sm,
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    minHeight: 46,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  notes: { minHeight: 110 },
  projectChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  projectChip: {
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  projectChipSelected: { backgroundColor: colors.accent + '20', borderColor: colors.accent },
  projectChipText: { color: colors.textSecondary, fontSize: fonts.sizeXs },
  projectChipTextSelected: { color: colors.accent },
  error: { color: colors.statusFail, fontSize: fonts.sizeSm },
  success: { color: colors.statusOk, fontSize: fonts.sizeSm, lineHeight: 19 },
  submit: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    justifyContent: 'center',
    marginTop: spacing.md,
    minHeight: 48,
  },
  disabled: { opacity: 0.5 },
  submitText: { color: colors.bgBase, fontSize: fonts.sizeMd, fontWeight: '800' },
});
