import React from 'react';
import { Text, View } from 'react-native';

import {
  isPRWorkspaceExecutionProfile,
  type PRExecutionProfile,
  type ProjectQaConfig,
  type PRReviewOptions,
  prReviewWorkflow,
  type SlotStatus,
} from '@farmslot/protocol';

import {
  newPRExecution,
  prExecutionText,
  togglePRSlot,
  updatePRReviewOptions,
} from '../../../lib/pr-automation';
import { styles } from '../styles/pr-automation-styles';

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
          <Text style={styles.muted}>Reviewer session</Text>
          <View style={styles.row}>
            {(['resume', 'reset'] as const).map((sessionIntent) => (
              <PRButton
                key={sessionIntent}
                label={sessionIntent === 'resume' ? 'Continue' : 'Fresh'}
                selected={value.sessionIntent === sessionIntent}
                disabled={disabled}
                onPress={() => change({ sessionIntent })}
              />
            ))}
          </View>
          <Text style={styles.muted}>Review scope</Text>
          <View style={styles.row}>
            {(['incremental', 'full'] as const).map((scope) => (
              <PRButton
                key={scope}
                label={scope === 'full' ? 'Full independent review' : 'Changes since last review'}
                selected={value.scope === scope}
                disabled={disabled}
                onPress={() => change({ scope })}
              />
            ))}
          </View>
          <Text style={styles.muted}>When the saved reviewer is busy</Text>
          <View style={styles.row}>
            {(['wait', 'fresh'] as const).map((busySession) => (
              <PRButton
                key={busySession}
                label={busySession === 'wait' ? 'Wait for reviewer' : 'Allow fresh reviewer'}
                selected={(value.busySession ?? 'wait') === busySession}
                disabled={disabled}
                onPress={() => change({ busySession })}
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
}: {
  value: PRExecutionProfile;
  onChange: (value: PRExecutionProfile) => void;
  slots: SlotStatus[];
  project: string;
  disabled: boolean;
}) {
  if (isPRWorkspaceExecutionProfile(value)) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Review workspace</Text>
        <Text style={styles.text}>{prExecutionText(value)}</Text>
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
      {value.models.map((model, index) => {
        const update = (patch: Partial<typeof model>) =>
          onChange({
            ...value,
            models: value.models.map((item, i) => (i === index ? { ...item, ...patch } : item)),
          });
        return (
          <View key={index} style={styles.card}>
            <Text style={styles.muted}>
              {index === 0 ? 'Preferred model' : `Alternative ${index}`}
            </Text>
            <PRInput
              label="Runner"
              value={model.runner}
              disabled={disabled}
              onChange={(runner) => update({ runner })}
            />
            <PRInput
              label="Model"
              value={model.model}
              disabled={disabled}
              onChange={(model) => update({ model })}
            />
            <PRInput
              label="Reasoning effort, optional"
              value={model.effort ?? ''}
              disabled={disabled}
              onChange={(effort) => update({ effort: effort || undefined })}
            />
            <PRInput
              label="Limit model to slots, comma-separated"
              value={model.allowedSlots?.join(',') ?? ''}
              disabled={disabled}
              onChange={(text) =>
                update({
                  allowedSlots: text ? text.split(',') : undefined,
                })
              }
            />
            {value.models.length > 1 && (
              <PRButton
                label="Remove model alternative"
                disabled={disabled}
                onPress={() =>
                  onChange({ ...value, models: value.models.filter((_, i) => i !== index) })
                }
              />
            )}
          </View>
        );
      })}
      <PRButton
        label="Add model alternative"
        disabled={disabled}
        onPress={() =>
          onChange({ ...value, models: [...value.models, newPRExecution().models[0]] })
        }
      />
      <Text style={styles.muted}>
        One allowed slot/model combination runs the work. The gateway reports unsupported choices;
        it cannot choose an unlisted fallback.
      </Text>
    </View>
  );
}
