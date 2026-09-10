import React from 'react';
import { Text, View } from 'react-native';

import type { PRExecutionProfile, PRReviewOptions, SlotStatus } from '@farmslot/protocol';

import { newPRExecution, togglePRSlot } from '../../../lib/pr-automation';
import { styles } from '../styles/pr-automation-styles';

import { PRButton, PRInput } from './PRControls';

export function PRReviewFields({
  value,
  onChange,
  disabled,
}: {
  value: PRReviewOptions;
  onChange: (value: PRReviewOptions) => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.muted}>Reviewer session</Text>
      <View style={styles.row}>
        {(['resume', 'reset'] as const).map((sessionIntent) => (
          <PRButton
            key={sessionIntent}
            label={sessionIntent === 'resume' ? 'Continue' : 'Fresh'}
            disabled={disabled}
            selected={value.sessionIntent === sessionIntent}
            onPress={() => onChange({ ...value, sessionIntent })}
          />
        ))}
      </View>
      <Text style={styles.muted}>Review scope</Text>
      <View style={styles.row}>
        {(['incremental', 'full'] as const).map((scope) => (
          <PRButton
            key={scope}
            label={
              scope === 'incremental' ? 'Changes since last review' : 'Full independent review'
            }
            selected={value.scope === scope}
            disabled={disabled}
            onPress={() => onChange({ ...value, scope })}
          />
        ))}
      </View>
      <Text style={styles.muted}>Validation depth</Text>
      <View style={styles.row}>
        {(['static-code', 'full-live'] as const).map((validationDepth) => (
          <PRButton
            key={validationDepth}
            testID={`companion-pr-depth-${validationDepth}`}
            label={validationDepth === 'full-live' ? 'Review and live QA' : 'Static code'}
            selected={value.validationDepth === validationDepth}
            disabled={disabled}
            onPress={() => onChange({ ...value, validationDepth })}
          />
        ))}
      </View>
      <Text style={styles.muted}>When the saved reviewer is busy</Text>
      <View style={styles.row}>
        {(['wait', 'fresh'] as const).map((busySession) => (
          <PRButton
            key={busySession}
            label={busySession === 'wait' ? 'Wait for reviewer' : 'Allow fresh slot'}
            selected={(value.busySession ?? 'wait') === busySession}
            disabled={disabled}
            onPress={() => onChange({ ...value, busySession })}
          />
        ))}
      </View>
      <Text style={styles.muted}>
        Initial rounds and full reviews start fresh. Saved sessions do not reserve a slot between
        rounds.
      </Text>
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
