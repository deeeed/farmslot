import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  BACKLOG_SOURCE_KINDS,
  type BacklogCreateResult,
  type BacklogItem,
  type BacklogListResult,
  type BacklogSourceKind,
  type BacklogUpdateResult,
  type ConfigTemplateOptionsResult,
  type FlowType,
  Methods,
  type TaskTemplateSelection,
} from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';
import { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import {
  PlanningChoices,
  PlanningField,
  PlanningSection,
  PlanningToggle,
} from '../features/planning/PlanningControls';
import { ReviewDispatchPicker } from '../features/review-dispatch/ReviewDispatchPicker';
import { useConfigurationProjects } from '../hooks/useConfigurationProjects';
import { useResourceQuery } from '../hooks/useResourceQuery';
import { backlogExecutionDefaults } from '../lib/backlog-review-dispatch';
import { colors, fonts, radii, spacing } from '../lib/theme';
import { useConnectionStore } from '../store/connection';
import { useFilterStore } from '../store/filters';
import { useFleetStore } from '../store/fleet';

import { FormSheetHeader } from './FormSheetHeader';

const FLOW_OPTIONS: readonly { value: FlowType; label: string }[] = [
  { value: 'fix-bug', label: 'Fix bug' },
  { value: 'dev', label: 'Dev' },
  { value: 'review-pr', label: 'Review PR' },
  { value: 'pr-complete', label: 'PR complete' },
  { value: 'update-branch', label: 'Update branch' },
];

function csv(value: string): string[] | undefined {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length ? [...new Set(entries)] : undefined;
}

export function BacklogCreateForm({
  item,
  onSaved,
}: {
  item?: BacklogItem;
  onSaved?: (item: BacklogItem) => void;
} = {}) {
  const editing = Boolean(item);
  const insets = useSafeAreaInsets();
  const client = useConnectionStore((state) => state.client);
  const status = useConnectionStore((state) => state.status);
  const selectedProjects = useFilterStore((state) => state.filters.projects);
  const initialSelectedProject = useRef(
    item?.project ?? (selectedProjects.length === 1 ? selectedProjects[0] : ''),
  );
  const projectsObservation = useConfigurationProjects();
  const projects = useMemo(
    () =>
      [...(projectsObservation.data?.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [projectsObservation.data],
  );
  const fleetSlots = useFleetStore((state) => state.fleet?.slots);
  const [templateOptions, setTemplateOptions] = useState<ConfigTemplateOptionsResult['options']>(
    [],
  );
  const [project, setProject] = useState(initialSelectedProject.current);
  const [title, setTitle] = useState(item?.title ?? '');
  const [sourceKind, setSourceKind] = useState<BacklogSourceKind>(item?.sourceKind ?? 'manual');
  const [sourceRef, setSourceRef] = useState(item?.sourceRef ?? '');
  const [sourceUrl, setSourceUrl] = useState(item?.sourceUrl ?? '');
  const [flowType, setFlowType] = useState<FlowType>(item?.flowType ?? 'dev');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [tags, setTags] = useState(item?.tags?.join(', ') ?? '');
  const [roadmapItemId, setRoadmapItemId] = useState(item?.roadmapItemId ?? '');
  const [specPath, setSpecPath] = useState(item?.specPath ?? '');
  const [priority, setPriority] = useState(String(item?.priority ?? 10));
  const [allowedSlots, setAllowedSlots] = useState<string[]>(item?.allowedSlots ?? []);
  const [autoDispatch, setAutoDispatch] = useState(item?.autoDispatch ?? false);
  const [multiPr, setMultiPr] = useState(item?.multiPr ?? false);
  const [taskTemplate, setTaskTemplate] = useState<TaskTemplateSelection | undefined>(
    item?.taskTemplate,
  );
  const [app, setApp] = useState(item?.app ?? '');
  const [prepareProfile, setPrepareProfile] = useState(item?.prepareProfile ?? '');
  const [mode, setMode] = useState<'' | 'interactive' | 'autonomous'>(item?.mode ?? '');
  const [devInteractiveProfile, setDevInteractiveProfile] = useState<
    '' | 'lightweight' | 'reviewed'
  >(item?.devInteractiveProfile ?? '');
  const [createReady, setCreateReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdLabel, setCreatedLabel] = useState<string | null>(null);

  const selectedProject = projects.find((candidate) => candidate.name === project);
  const executionPicker = useMemo(
    () =>
      new ReviewDispatchViewModel({
        context: {
          allowedActions: ['configure'],
          defaults: backlogExecutionDefaults(selectedProject, flowType, item),
          allowSequence: false,
          reviewContext: flowType === 'review-pr' ? item?.reviewContext : undefined,
        },
      }),
    [selectedProject, flowType, item],
  );
  const [reviewPicker] = useState(
    () =>
      new ReviewDispatchViewModel({
        context: {
          allowedActions: ['configure'],
          allowSequence: true,
          allowEmpty: true,
          reviewContext: item?.reviewSequenceContext,
        },
        sequence: item?.reviewSequence ?? [],
      }),
  );
  const [, refreshPicker] = useState(0);
  const prepareProfiles = Object.entries(selectedProject?.prepare?.profiles ?? {}).map(
    ([value, profile]) => ({ value, label: profile.label ?? value }),
  );
  const slotOptions = useMemo(
    () =>
      (fleetSlots ?? [])
        .filter((slot) => slot.project === project && slot.enabled !== false)
        .map((slot) => slot.slot)
        .sort(),
    [fleetSlots, project],
  );

  const templateQuery = useMemo(
    () =>
      project
        ? resourceQuery<ConfigTemplateOptionsResult>(Methods.CONFIG_TEMPLATE_OPTIONS, {
            project,
            flowType,
          })
        : undefined,
    [project, flowType],
  );
  const templateObservation = useResourceQuery(templateQuery);
  useEffect(() => {
    setProject((current) => current || projects[0]?.name || '');
  }, [projects]);
  useEffect(() => {
    const options = templateObservation.data?.options ?? [];
    setTemplateOptions(options);
    setTaskTemplate((current) =>
      current && options.some((option) => option.fileName === current.fileName)
        ? current
        : undefined,
    );
  }, [templateObservation.data]);

  const submit = async () => {
    if (!project.trim() || !title.trim()) {
      setError('Project and title are required.');
      return;
    }
    if (!client || status !== 'connected') {
      setError('Connect to the gateway before creating backlog work.');
      return;
    }
    const parsedPriority = Number(priority);
    if (!Number.isFinite(parsedPriority) || parsedPriority < 1) {
      setError('Priority must be a positive number.');
      return;
    }
    if (sourceKind !== 'manual' && !sourceRef.trim()) {
      setError(`${sourceKind === 'jira' ? 'Jira' : 'GitHub'} items require a source ref.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const execution = executionPicker.toSelection();
      const {
        reviewSequence,
        reviewPolicy: selectedReviewPolicy,
        reviewSequenceContext,
      } = reviewPicker.toDispatchOptions();
      const reviewPolicy =
        selectedReviewPolicy ?? (item?.reviewSequence?.length ? undefined : item?.reviewPolicy);
      const common = {
        title: title.trim(),
        sourceKind,
        sourceRef: sourceRef.trim() || undefined,
        sourceUrl: sourceUrl.trim() || undefined,
        flowType,
        notes: notes.trim() || undefined,
        tags: csv(tags),
        roadmapItemId: roadmapItemId.trim() || undefined,
        specPath: specPath.trim() || undefined,
        priority: parsedPriority,
        allowedSlots: allowedSlots.length ? allowedSlots : undefined,
        autoDispatch,
        multiPr: multiPr || undefined,
        runner: execution.runner,
        model: execution.model ?? undefined,
        effort: execution.effort ?? undefined,
        taskTemplate,
        app: app || undefined,
        prepareProfile: prepareProfile || undefined,
        mode: mode || undefined,
        devInteractiveProfile: devInteractiveProfile || undefined,
        reviewMode: flowType === 'review-pr' ? execution.mode : undefined,
        reviewPolicy,
        reviewContext: flowType === 'review-pr' ? executionPicker.toReviewContext() : undefined,
        reviewSequenceContext,
        reviewSequence: reviewSequence.length ? reviewSequence : undefined,
      };
      if (item) {
        const updated = await client.request<BacklogUpdateResult>(Methods.BACKLOG_UPDATE, {
          itemId: item.id,
          ...common,
          sourceRef: sourceRef.trim(),
          sourceUrl: common.sourceUrl ?? null,
          notes: common.notes ?? null,
          tags: common.tags ?? null,
          roadmapItemId: common.roadmapItemId ?? null,
          specPath: common.specPath ?? null,
          allowedSlots: common.allowedSlots ?? null,
          multiPr: common.multiPr ?? null,
          runner: common.runner ?? null,
          model: common.model ?? null,
          effort: common.effort ?? null,
          taskTemplate: common.taskTemplate ?? null,
          app: common.app ?? null,
          prepareProfile: common.prepareProfile ?? null,
          mode: common.mode ?? null,
          devInteractiveProfile: common.devInteractiveProfile ?? null,
          reviewMode: common.reviewMode ?? null,
          reviewPolicy: common.reviewPolicy ?? null,
          reviewSequence: common.reviewSequence ?? null,
          reviewContext: common.reviewContext ?? null,
          reviewSequenceContext: common.reviewSequenceContext ?? null,
        });
        setCreatedLabel(updated.item.sourceRef || updated.item.id);
        onSaved?.(updated.item);
        return;
      }
      const created = await client.request<BacklogCreateResult>(Methods.BACKLOG_CREATE, {
        project: project.trim(),
        ...common,
        status: createReady ? 'ready' : 'candidate',
      });
      const listed = await client.request<BacklogListResult>(Methods.BACKLOG_LIST, {
        project: project.trim(),
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

  const toggleSlot = (slotId: string) => {
    setAllowedSlots((current) =>
      current.includes(slotId) ? current.filter((entry) => entry !== slotId) : [...current, slotId],
    );
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + spacing.xl }]}
      keyboardShouldPersistTaps="handled"
    >
      <FormSheetHeader title={editing ? 'Edit backlog item' : 'Create backlog item'} />
      <PlanningSection
        title="Basics"
        summary="Identity, scope, source, and task spec"
        initiallyOpen
      >
        {editing ? (
          <PlanningField
            label="Project"
            value={project}
            onChangeText={setProject}
            editable={false}
          />
        ) : (
          <PlanningChoices
            label="Project"
            options={projects.map((entry) => ({ value: entry.name }))}
            value={project}
            onChange={(value) => {
              setProject(value);
              setAllowedSlots([]);
            }}
          />
        )}
        <PlanningField
          label="Title"
          testID="companion-backlog-title"
          value={title}
          onChangeText={setTitle}
          placeholder="What needs to change?"
        />
        <PlanningChoices
          label="Source"
          options={BACKLOG_SOURCE_KINDS.map((value) => ({ value }))}
          value={sourceKind}
          onChange={setSourceKind}
        />
        <PlanningField
          label="Source ref"
          value={sourceRef}
          onChangeText={setSourceRef}
          placeholder="Blank allocates a new manual ref"
        />
        <PlanningField
          label="Source URL"
          value={sourceUrl}
          onChangeText={setSourceUrl}
          placeholder="https://…"
          keyboardType="url"
        />
        <PlanningChoices
          label="Flow"
          options={FLOW_OPTIONS}
          value={flowType}
          onChange={setFlowType}
        />
        <PlanningField
          label="Notes"
          value={notes}
          onChangeText={setNotes}
          placeholder="Context, expected result, or evidence"
          multiline
        />
        <PlanningField
          label="Tags"
          value={tags}
          onChangeText={setTags}
          placeholder="#perps, #regression"
        />
        <PlanningField
          label="Roadmap item"
          value={roadmapItemId}
          onChangeText={setRoadmapItemId}
          placeholder="ri_…"
        />
        <PlanningField
          label="Spec path"
          value={specPath}
          onChangeText={setSpecPath}
          placeholder=".backlog/specs/…md"
        />
      </PlanningSection>

      <PlanningSection
        title="Dispatch"
        summary="Priority, slot, template, runtime, and prepare policy"
      >
        <PlanningField
          label="Priority"
          value={priority}
          onChangeText={setPriority}
          keyboardType="numeric"
        />
        {!editing ? (
          <PlanningChoices
            label="Create as"
            options={
              [
                { value: 'candidate', label: 'Candidate' },
                { value: 'ready', label: 'Ready' },
              ] as const
            }
            value={createReady ? 'ready' : 'candidate'}
            onChange={(value) => setCreateReady(value === 'ready')}
          />
        ) : null}
        <PlanningToggle
          label="Dispatch when ready"
          detail="Let project auto-dispatch policy enqueue this item."
          value={autoDispatch}
          onChange={setAutoDispatch}
        />
        <PlanningToggle
          label="Multi-PR delivery"
          detail="Return to ready after a linked run; close explicitly after the final slice."
          value={multiPr}
          onChange={setMultiPr}
        />
        {slotOptions.length ? (
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Allowed slots</Text>
            <View style={styles.chips}>
              {slotOptions.map((slotId) => (
                <Pressable
                  key={slotId}
                  style={[styles.chip, allowedSlots.includes(slotId) && styles.chipSelected]}
                  onPress={() => toggleSlot(slotId)}
                >
                  <Text
                    style={[
                      styles.chipText,
                      allowedSlots.includes(slotId) && styles.chipTextSelected,
                    ]}
                  >
                    {slotId}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
        {selectedProject?.apps?.length ? (
          <PlanningChoices
            label="App"
            options={[
              { value: '', label: 'Default' },
              ...selectedProject.apps.map((value) => ({ value })),
            ]}
            value={app}
            onChange={setApp}
          />
        ) : null}
        <PlanningChoices
          label="Mode"
          options={
            [
              { value: '', label: 'Default' },
              { value: 'autonomous', label: 'Autonomous' },
              { value: 'interactive', label: 'Interactive' },
            ] as const
          }
          value={mode}
          onChange={setMode}
        />
        <ReviewDispatchPicker
          model={executionPicker}
          review={flowType === 'review-pr'}
          testID="companion-backlog-execution"
          disabled={submitting}
        />
        {templateOptions.length ? (
          <PlanningChoices
            label="Task template"
            options={[
              { value: '', label: 'Configured default' },
              ...templateOptions.map((option) => ({ value: option.fileName, label: option.label })),
            ]}
            value={taskTemplate?.fileName ?? ''}
            onChange={(fileName) => {
              const selected = templateOptions.find((option) => option.fileName === fileName);
              setTaskTemplate(
                selected ? { fileName, variant: selected.variant ?? null } : undefined,
              );
            }}
          />
        ) : null}
        {prepareProfiles.length ? (
          <PlanningChoices
            label="Prepare profile"
            options={[{ value: '', label: 'Project default' }, ...prepareProfiles]}
            value={prepareProfile}
            onChange={setPrepareProfile}
          />
        ) : null}
        {flowType === 'dev' && mode === 'interactive' ? (
          <PlanningChoices
            label="Interactive profile"
            options={
              [
                { value: '', label: 'Default' },
                { value: 'lightweight' },
                { value: 'reviewed' },
              ] as const
            }
            value={devInteractiveProfile}
            onChange={setDevInteractiveProfile}
          />
        ) : null}
      </PlanningSection>

      <PlanningSection
        title="Publication review"
        testID="companion-backlog-review-section"
        summary={`${reviewPicker.rows.length} review${reviewPicker.rows.length === 1 ? '' : 's'}`}
      >
        <ReviewDispatchPicker
          model={reviewPicker}
          testID="companion-backlog-review"
          disabled={submitting}
          onChange={() => refreshPicker((current) => current + 1)}
        />
        <Text style={styles.chipText}>
          Static review. Run runtime validation separately with QA.
        </Text>
      </PlanningSection>

      {projectsObservation.status === 'stale' && projectsObservation.observedAt ? (
        <Text>
          Saved projects,{' '}
          {Math.max(0, Math.floor((Date.now() - projectsObservation.observedAt) / 1000))}s old.
          Actions wait for a current read.
        </Text>
      ) : null}
      {error || projectsObservation.error || templateObservation.error ? (
        <Text style={styles.error}>
          {error || projectsObservation.error?.message || templateObservation.error?.message}
        </Text>
      ) : null}
      {createdLabel ? (
        <Text style={styles.success}>
          {editing ? 'Saved' : 'Created'} {createdLabel}.
        </Text>
      ) : null}
      <Pressable
        testID="companion-backlog-submit"
        style={[
          styles.submit,
          (submitting || Boolean(createdLabel) || status !== 'connected') && styles.disabled,
        ]}
        onPress={() => void submit()}
        disabled={submitting || Boolean(createdLabel) || status !== 'connected'}
      >
        {submitting ? (
          <ActivityIndicator color={colors.bgBase} />
        ) : (
          <Text style={styles.submitText}>
            {editing
              ? 'Save dispatch parameters'
              : `Create ${createReady ? 'ready item' : 'candidate'}`}
          </Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bgBase, flex: 1 },
  form: { gap: spacing.lg, padding: spacing.xl },
  fieldGroup: { gap: spacing.sm },
  label: {
    color: colors.textSecondary,
    fontFamily: fonts.mono,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderColor: colors.bgCardHover,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipSelected: { backgroundColor: colors.accent + '20', borderColor: colors.accent },
  chipText: { color: colors.textMuted, fontSize: fonts.sizeXs },
  chipTextSelected: { color: colors.accent },
  error: { color: colors.statusFail, fontSize: fonts.sizeSm },
  success: { color: colors.statusOk, fontSize: fonts.sizeSm },
  submit: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    justifyContent: 'center',
    minHeight: 48,
  },
  disabled: { opacity: 0.5 },
  submitText: { color: colors.bgBase, fontSize: fonts.sizeMd, fontWeight: '900' },
});
