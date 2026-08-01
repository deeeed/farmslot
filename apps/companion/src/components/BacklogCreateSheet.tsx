import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import {
  Methods,
  type BacklogCreateResult,
  type ConfigProjectsResult,
} from '@farmslot/protocol';

import {
  buildBacklogCreateParams,
  resolveBacklogProject,
} from '../lib/backlog-create';
import { colors, fonts, radii, spacing, touchTargets } from '../lib/theme';
import { useConnectionStore } from '../store/connection';
import { useFilterStore } from '../store/filters';

export interface BacklogCreateSheetProps {
  open: boolean;
  onClose: () => void;
}

export function BacklogCreateSheet({ open, onClose }: BacklogCreateSheetProps) {
  const insets = useSafeAreaInsets();
  const client = useConnectionStore((s) => s.client);
  const status = useConnectionStore((s) => s.status);
  const selectedProjects = useFilterStore((s) => s.filters.projects);
  const availableProjects = useFilterStore((s) => s.availableProjects);

  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [projectChoices, setProjectChoices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const wasOpenRef = useRef(false);
  const projectRef = useRef<string | null>(null);
  projectRef.current = project;

  const resolvedDefault = useMemo(
    () =>
      resolveBacklogProject({
        selectedProjects,
        availableProjects: projectChoices.length > 0 ? projectChoices : availableProjects,
      }),
    [availableProjects, projectChoices, selectedProjects],
  );

  // Reset title/notes only on open transition — not when resolvedDefault changes mid-edit.
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setError('');
    setMessage('');
    setTitle('');
    setNotes('');
    setProject(
      resolveBacklogProject({
        selectedProjects,
        availableProjects,
      }),
    );
  }, [open, selectedProjects, availableProjects]);

  useEffect(() => {
    if (!open || !client || status !== 'connected') return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.request<ConfigProjectsResult>(Methods.CONFIG_PROJECTS, {});
        if (cancelled) return;
        const names = (result.projects ?? [])
          .map((p) => p.name)
          .filter((name): name is string => Boolean(name));
        setProjectChoices(names);
        // Seed project only when still unset — do not clobber operator chip selection.
        if (!projectRef.current) {
          setProject(
            resolveBacklogProject({
              selectedProjects,
              availableProjects: names.length > 0 ? names : availableProjects,
            }),
          );
        }
      } catch (err) {
        if (cancelled) return;
        // Keep filter-derived projects when config.projects is unavailable.
        setProjectChoices(availableProjects);
        if (!projectRef.current) {
          setProject(
            resolveBacklogProject({
              selectedProjects,
              availableProjects,
            }),
          );
        }
        setError(
          err instanceof Error
            ? `Could not load projects from gateway: ${err.message}`
            : 'Could not load projects from gateway.',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [availableProjects, client, open, selectedProjects, status]);

  const choices = projectChoices.length > 0 ? projectChoices : availableProjects;

  const onSubmit = useCallback(async () => {
    setError('');
    setMessage('');
    if (!client || status !== 'connected') {
      setError('Connect to a gateway before creating a backlog item.');
      return;
    }
    const selected = project ?? resolvedDefault;
    if (!selected) {
      setError(
        'Select a project. Use the Advanced filter bar project chips or pick one below when multiple projects are available.',
      );
      return;
    }
    let params;
    try {
      params = buildBacklogCreateParams({
        project: selected,
        title,
        notes,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(true);
    try {
      const result = await client.request<BacklogCreateResult>(Methods.BACKLOG_CREATE, params);
      setMessage(`Created backlog item ${result.item.id}`);
      setTitle('');
      setNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [client, notes, project, resolvedDefault, status, title]);

  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.xl }]}>
          <View style={styles.headerRow}>
            <Text style={styles.title}>Create backlog item</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close backlog create"
              testID="companion-backlog-create-close"
              style={styles.closeButton}
              onPress={onClose}
              hitSlop={8}
            >
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          <Text style={styles.subtitle}>
            Minimal create surface: title + notes. Project comes from the active mobile filter when
            exactly one project is selected, otherwise choose below.
          </Text>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.form}
          >
            <Text style={styles.label}>Project</Text>
            {choices.length === 0 ? (
              <Text style={styles.hint}>
                No projects loaded. Connect to the gateway or set a project filter first.
              </Text>
            ) : (
              <View style={styles.chipRow}>
                {choices.map((name) => {
                  const active = (project ?? resolvedDefault) === name;
                  return (
                    <Pressable
                      key={name}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => setProject(name)}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>{name}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            <Text style={styles.label}>Title</Text>
            <TextInput
              testID="companion-backlog-create-title"
              value={title}
              onChangeText={setTitle}
              placeholder="Short operator title"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              autoCapitalize="sentences"
              editable={!busy}
            />

            <Text style={styles.label}>Notes</Text>
            <TextInput
              testID="companion-backlog-create-notes"
              value={notes}
              onChangeText={setNotes}
              placeholder="Optional context for dispatch later"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, styles.notesInput]}
              multiline
              textAlignVertical="top"
              editable={!busy}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}
            {message ? <Text style={styles.success}>{message}</Text> : null}

            <Pressable
              testID="companion-backlog-create-submit"
              accessibilityRole="button"
              accessibilityLabel="Create backlog item"
              style={[styles.submit, busy && styles.submitDisabled]}
              onPress={() => {
                void onSubmit();
              }}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={colors.textPrimary} />
              ) : (
                <Text style={styles.submitText}>Create</Text>
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
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.bgSurface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    borderColor: colors.bgCardHover,
    borderWidth: 1,
    maxHeight: '88%',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  title: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: fonts.sizeLg,
    fontWeight: '800',
  },
  closeButton: {
    minHeight: touchTargets.primaryMinHeight,
    minWidth: touchTargets.primaryMinWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  closeText: {
    color: colors.accent,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 18,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  form: {
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  label: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  hint: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    minHeight: touchTargets.secondaryMinHeight,
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  chipActive: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '88',
  },
  chipText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  chipTextActive: {
    color: colors.accent,
  },
  input: {
    backgroundColor: colors.bgInput,
    borderColor: colors.bgCardHover,
    borderRadius: radii.md,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    minHeight: touchTargets.primaryMinHeight,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  notesInput: {
    minHeight: 96,
  },
  error: {
    color: colors.statusFail,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  success: {
    color: colors.statusOk,
    fontSize: fonts.sizeSm,
    fontWeight: '700',
  },
  submit: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.lg,
    justifyContent: 'center',
    minHeight: touchTargets.primaryMinHeight,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  submitDisabled: {
    opacity: 0.7,
  },
  submitText: {
    color: colors.bgBase,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
  },
});
