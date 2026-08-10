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
  type ConfigProjectsResult,
  type ConfigTemplateOptionsResult,
  type FleetStatusResult,
  type FlowType,
  Methods,
  type ProjectConfig,
  type ReviewLoopRequest,
  type TaskTemplateSelection,
} from '@farmslot/protocol';

import {
  PlanningChoices,
  PlanningField,
  PlanningSection,
  PlanningToggle,
} from '../features/planning/PlanningControls';
import { colors, fonts, radii, spacing } from '../lib/theme';
import { useConnectionStore } from '../store/connection';
import { useFilterStore } from '../store/filters';

import { FormSheetHeader } from './FormSheetHeader';

const FLOW_OPTIONS: readonly { value: FlowType; label: string }[] = [
  { value: 'fix-bug', label: 'Fix bug' },
  { value: 'dev', label: 'Dev' },
  { value: 'review-pr', label: 'Review PR' },
  { value: 'pr-complete', label: 'PR complete' },
  { value: 'update-branch', label: 'Update branch' },
];

const REVIEW_RUNNERS: readonly ReviewLoopRequest['runner'][] = [
  'same',
  'claude',
  'codex',
  'cursor',
  'grok',
  'opencode',
];

function csv(value: string): string[] | undefined {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length ? [...new Set(entries)] : undefined;
}

function projectRunnerOptions(project: ProjectConfig | undefined): string[] {
  return [
    ...new Set(
      Object.values(project?.defaults ?? {})
        .map((entry) => entry.runner)
        .filter(Boolean),
    ),
  ];
}

function projectModelOptions(project: ProjectConfig | undefined, runner: string): string[] {
  return [
    ...new Set(
      Object.values(project?.defaults ?? {})
        .filter((entry) => !runner || entry.runner === runner)
        .map((entry) => entry.model)
        .filter(Boolean),
    ),
  ];
}

function projectDefaultRunner(project: ProjectConfig | undefined, flowType: FlowType): string {
  const key = flowType.includes('review')
    ? 'review'
    : flowType.includes('fix')
      ? 'fix'
      : flowType.includes('dev')
        ? 'dev'
        : 'feature';
  return (
    project?.defaults[flowType]?.runner ??
    project?.defaults[key]?.runner ??
    project?.defaults.feature?.runner ??
    project?.defaults.dev?.runner ??
    project?.defaults.fix?.runner ??
    ''
  );
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
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [fleetSlots, setFleetSlots] = useState<FleetStatusResult['fleet']['slots']>([]);
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
  const [runner, setRunner] = useState(item?.runner ?? '');
  const [model, setModel] = useState(item?.model ?? '');
  const [effort, setEffort] = useState(item?.effort ?? '');
  const [taskTemplate, setTaskTemplate] = useState<TaskTemplateSelection | undefined>(
    item?.taskTemplate,
  );
  const [app, setApp] = useState(item?.app ?? '');
  const [prepareProfile, setPrepareProfile] = useState(item?.prepareProfile ?? '');
  const [mode, setMode] = useState<'' | 'interactive' | 'autonomous'>(item?.mode ?? '');
  const [devInteractiveProfile, setDevInteractiveProfile] = useState<
    '' | 'lightweight' | 'reviewed'
  >(item?.devInteractiveProfile ?? '');
  const [reviewPlan, setReviewPlan] = useState<ReviewLoopRequest[]>(item?.pendingReviewPlan ?? []);
  const [createReady, setCreateReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdLabel, setCreatedLabel] = useState<string | null>(null);

  const selectedProject = projects.find((candidate) => candidate.name === project);
  const runnerOptions = useMemo(() => projectRunnerOptions(selectedProject), [selectedProject]);
  const modelOptions = useMemo(
    () => projectModelOptions(selectedProject, runner),
    [runner, selectedProject],
  );
  const prepareProfiles = Object.entries(selectedProject?.prepare?.profiles ?? {}).map(
    ([value, profile]) => ({ value, label: profile.label ?? value }),
  );
  const slotOptions = useMemo(
    () =>
      fleetSlots
        .filter((slot) => slot.project === project && slot.enabled !== false)
        .map((slot) => slot.slot)
        .sort(),
    [fleetSlots, project],
  );

  useEffect(() => {
    let cancelled = false;
    if (!client || status !== 'connected') return;
    void Promise.all([
      client.request<ConfigProjectsResult>(Methods.CONFIG_PROJECTS, {}),
      client.request<FleetStatusResult>(Methods.FLEET_STATUS, {}),
    ])
      .then(([projectResult, fleetResult]) => {
        if (cancelled) return;
        const configured = [...projectResult.projects].sort((a, b) => a.name.localeCompare(b.name));
        setProjects(configured);
        setProject((current) => current || configured[0]?.name || '');
        setFleetSlots(fleetResult.fleet.slots);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, status]);

  useEffect(() => {
    let cancelled = false;
    if (!client || status !== 'connected' || !project) {
      setTemplateOptions([]);
      return;
    }
    void client
      .request<ConfigTemplateOptionsResult>(Methods.CONFIG_TEMPLATE_OPTIONS, { project, flowType })
      .then((result) => {
        if (cancelled) return;
        setTemplateOptions(result.options);
        setTaskTemplate((current) =>
          current && result.options.some((option) => option.fileName === current.fileName)
            ? current
            : undefined,
        );
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setTemplateOptions([]);
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, flowType, project, status]);

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
    const pendingReviewPlan = reviewPlan.length ? reviewPlan : undefined;
    setSubmitting(true);
    setError(null);
    try {
      const reviewDepth = pendingReviewPlan
        ? {
            minimumIndependentReviews: pendingReviewPlan.length,
            requireCrossRunner: pendingReviewPlan.some((loop) => {
              const workerRunner = runner || projectDefaultRunner(selectedProject, flowType);
              return Boolean(
                workerRunner && loop.runner !== 'same' && loop.runner !== workerRunner,
              );
            }),
            extraLoopsRequested: 0,
            requestedBy: 'dispatch' as const,
          }
        : item?.pendingReviewPlan?.length
          ? undefined
          : item?.reviewDepth;
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
        runner: runner || undefined,
        model: model.trim() || undefined,
        effort: effort.trim() || undefined,
        taskTemplate,
        app: app || undefined,
        prepareProfile: prepareProfile || undefined,
        mode: mode || undefined,
        devInteractiveProfile: devInteractiveProfile || undefined,
        reviewDepth,
        pendingReviewPlan,
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
          reviewDepth: common.reviewDepth ?? null,
          pendingReviewPlan: common.pendingReviewPlan ?? null,
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

  const addReview = () => {
    setReviewPlan((current) => [
      ...current,
      { order: current.length + 1, runner: 'codex', validationDepth: 'static-code' },
    ]);
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
        {runnerOptions.length ? (
          <PlanningChoices
            label="Configured runners"
            options={[
              { value: '', label: 'Default' },
              ...runnerOptions.map((value) => ({ value })),
            ]}
            value={runner}
            onChange={(value) => {
              setRunner(value);
              setModel('');
            }}
          />
        ) : null}
        <PlanningField
          label="Runner"
          value={runner}
          onChangeText={setRunner}
          placeholder="Project default or runner id"
        />
        {modelOptions.length ? (
          <PlanningChoices
            label="Configured models"
            options={[{ value: '', label: 'Default' }, ...modelOptions.map((value) => ({ value }))]}
            value={model}
            onChange={setModel}
          />
        ) : null}
        <PlanningField
          label="Model"
          value={model}
          onChangeText={setModel}
          placeholder="Runner default or model id"
        />
        <PlanningField
          label="Effort"
          value={effort}
          onChangeText={setEffort}
          placeholder="Runner default"
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
        summary={`${reviewPlan.length} additional review loop${reviewPlan.length === 1 ? '' : 's'}`}
      >
        {reviewPlan.map((loop, index) => (
          <View key={loop.order} style={styles.reviewCard}>
            <View style={styles.reviewHeader}>
              <Text style={styles.reviewTitle}>Review {index + 1}</Text>
              <Pressable
                onPress={() =>
                  setReviewPlan((current) =>
                    current
                      .filter((_, currentIndex) => currentIndex !== index)
                      .map((entry, currentIndex) => ({ ...entry, order: currentIndex + 1 })),
                  )
                }
              >
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            </View>
            <PlanningChoices
              label="Runner"
              options={REVIEW_RUNNERS.map((value) => ({ value }))}
              value={loop.runner}
              onChange={(value) =>
                setReviewPlan((current) =>
                  current.map((entry, currentIndex) =>
                    currentIndex === index ? { ...entry, runner: value } : entry,
                  ),
                )
              }
            />
            <PlanningChoices
              label="Depth"
              options={
                [
                  { value: 'static-code', label: 'Static' },
                  { value: 'full-live', label: 'Full live' },
                ] as const
              }
              value={loop.validationDepth ?? 'static-code'}
              onChange={(value) =>
                setReviewPlan((current) =>
                  current.map((entry, currentIndex) =>
                    currentIndex === index ? { ...entry, validationDepth: value } : entry,
                  ),
                )
              }
            />
            <PlanningField
              label="Model override"
              value={loop.model ?? ''}
              onChangeText={(value) =>
                setReviewPlan((current) =>
                  current.map((entry, currentIndex) =>
                    currentIndex === index ? { ...entry, model: value || null } : entry,
                  ),
                )
              }
              placeholder="Runner default"
            />
            <PlanningChoices
              label="Session"
              options={
                [
                  { value: '', label: 'Default' },
                  { value: 'resume', label: 'Reuse context' },
                  { value: 'reset', label: 'Fresh review' },
                ] as const
              }
              value={loop.sessionIntent ?? ''}
              onChange={(value) =>
                setReviewPlan((current) =>
                  current.map((entry, currentIndex) =>
                    currentIndex === index
                      ? { ...entry, sessionIntent: value || undefined }
                      : entry,
                  ),
                )
              }
            />
          </View>
        ))}
        <Pressable style={styles.addReview} onPress={addReview}>
          <Text style={styles.addReviewText}>+ Add independent review</Text>
        </Pressable>
      </PlanningSection>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {createdLabel ? (
        <Text style={styles.success}>
          {editing ? 'Saved' : 'Created'} {createdLabel}.
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
  reviewCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    gap: spacing.md,
    padding: spacing.md,
  },
  reviewHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  reviewTitle: { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '900' },
  remove: { color: colors.statusFail, fontSize: fonts.sizeXs, fontWeight: '800' },
  addReview: {
    alignItems: 'center',
    borderColor: colors.accent,
    borderRadius: radii.md,
    borderWidth: 1,
    padding: spacing.md,
  },
  addReviewText: { color: colors.accent, fontSize: fonts.sizeSm, fontWeight: '800' },
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
