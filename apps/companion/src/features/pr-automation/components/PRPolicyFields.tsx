import React from 'react';
import { Text, View } from 'react-native';

import {
  isPRWorkspaceExecutionProfile,
  type PRExecutionProfile,
  type ProjectQaConfig,
  type PRReviewOptions,
  prReviewWorkflow,
  type ReviewContinuationContext,
  type ReviewMode,
  type ReviewRequestContext,
  type SlotStatus,
} from '@farmslot/protocol';
import type { ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import { prExecutionText, togglePRSlot, updatePRReviewOptions } from '../../../lib/pr-automation';
import { ReviewDispatchPicker } from '../../review-dispatch/ReviewDispatchPicker';
import { styles } from '../styles/pr-automation-styles';
import { usePRExecutionPicker } from '../use-pr-execution-picker';

import { PRButton, PRInput } from './PRControls';

export function PRReviewFields({
  value,
  onChange,
  disabled,
  qa,
}: {
  value: PRReviewOptions;
  onChange: (value: PRReviewOptions) => void;
  disabled: boolean;
  qa?: ProjectQaConfig;
}) {
  const runtime = prReviewWorkflow(value) === 'qa';
  const change = (patch: Partial<PRReviewOptions>) => onChange(updatePRReviewOptions(value, patch));
  return (
    <View style={styles.card}>
      <Text style={styles.muted}>Workflow</Text>
      <View style={styles.row}>
        {(['review', 'qa'] as const).map((workflow) => (
          <PRButton
            key={workflow}
            testID={`companion-pr-workflow-${workflow}`}
            label={workflow === 'qa' ? 'QA' : 'Review'}
            selected={prReviewWorkflow(value) === workflow}
            disabled={disabled}
            onPress={() => change({ workflow })}
          />
        ))}
      </View>
      {runtime ? (
        <>
          <Text style={styles.muted}>Farm QA profile</Text>
          <View style={styles.row}>
            <PRButton
              label="Farm default"
              selected={!value.qaProfileId}
              disabled={disabled}
              onPress={() => change({ qaProfileId: undefined, qaInputs: undefined })}
            />
            {qa?.profiles.map((profile) => (
              <PRButton
                key={profile.id}
                label={profile.title}
                selected={value.qaProfileId === profile.id}
                disabled={disabled}
                onPress={() => change({ qaProfileId: profile.id, qaInputs: undefined })}
              />
            ))}
          </View>
          <Text style={styles.muted}>
            QA executes the farm validation skill and requires runtime evidence.
          </Text>
        </>
      ) : (
        <>
          <Text style={styles.muted}>Publication</Text>
          <View style={styles.row}>
            {([undefined, true, false] as const).map((publishReview) => (
              <PRButton
                key={String(publishReview)}
                testID={`companion-pr-publication-${String(publishReview)}`}
                label={
                  publishReview === undefined
                    ? 'Inherit policy'
                    : publishReview
                      ? 'Publish review to PR'
                      : 'Farmslot results only'
                }
                selected={value.publishReview === publishReview}
                disabled={disabled}
                onPress={() => change({ publishReview })}
              />
            ))}
          </View>
        </>
      )}
    </View>
  );
}
export function PRExecutionFields({
  value,
  onChange,
  slots,
  project,
  disabled,
  reviewMode,
  onReviewModeChange,
  onPickerReady,
  reviewContext,
  reviewLineages,
  workflow,
}: {
  value: PRExecutionProfile;
  onChange: (value: PRExecutionProfile) => void;
  slots: SlotStatus[];
  project: string;
  disabled: boolean;
  reviewMode?: ReviewMode;
  onReviewModeChange?: (mode: ReviewMode, context: ReviewRequestContext | undefined) => void;
  onPickerReady?: (picker: ReviewDispatchViewModel | undefined) => void;
  reviewContext?: ReviewRequestContext;
  reviewLineages?: readonly ReviewContinuationContext[];
  workflow?: 'review' | 'qa';
}) {
  const { picker, resources, changed } = usePRExecutionPicker(
    value,
    onChange,
    reviewMode,
    onReviewModeChange,
    onPickerReady,
    reviewContext,
    reviewLineages,
    workflow,
  );
  const selection = (
    <ReviewDispatchPicker
      model={picker}
      review={reviewMode !== undefined}
      disabled={disabled}
      testID="companion-pr-execution"
      onChange={changed}
      renderRowResources={(row) =>
        !isPRWorkspaceExecutionProfile(value) && (
          <PRInput
            label="Limit model to slots, comma-separated"
            value={resources.get(row.id)?.allowedSlots?.join(',') ?? ''}
            disabled={disabled || !picker.valid}
            onChange={(text) => {
              resources.set(row.id, {
                ...resources.get(row.id),
                allowedSlots: text ? text.split(',') : undefined,
              });
              changed();
            }}
          />
        )
      }
    />
  );
  if (isPRWorkspaceExecutionProfile(value)) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Review workspace</Text>
        <Text style={styles.text}>{prExecutionText(value)}</Text>
        {selection}
      </View>
    );
  }
  const selected =
    value.slotPolicy.kind === 'exact' ? [value.slotPolicy.slotId] : value.slotPolicy.allowedSlots;
  const available = slots.filter((slot) => slot.project === project && !slot.missingFromPool);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>Allowed slots and models</Text>
      {!project && <Text style={styles.attention}>Choose a project to select its slots.</Text>}
      <View style={styles.row}>
        {available.map((slot) => (
          <PRButton
            key={slot.slot}
            testID={`companion-pr-slot-${slot.slot}`}
            label={`${slot.slot}${slot.enabled ? '' : ' (disabled)'}`}
            selected={selected.includes(slot.slot)}
            disabled={disabled}
            onPress={() => onChange(togglePRSlot(value, slot.slot))}
          />
        ))}
      </View>
      {selected
        .filter((id) => !available.some((slot) => slot.slot === id))
        .map((id) => (
          <PRButton
            key={id}
            label={`Remove unavailable slot ${id}`}
            disabled={disabled}
            onPress={() => onChange(togglePRSlot(value, id))}
          />
        ))}
      {selection}
      <Text style={styles.muted}>
        One allowed slot/model combination runs the work. The gateway reports unsupported choices;
        it cannot choose an unlisted fallback.
      </Text>
    </View>
  );
}
