import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { REVIEW_MODES } from '@farmslot/protocol';
import {
  type ReviewDispatchAction,
  type ReviewDispatchRow,
  type ReviewDispatchViewModel,
} from '@farmslot/review-dispatch';

import { colors, fonts, radii, spacing } from '../../lib/theme';

import { useReviewDispatchCatalog } from './use-review-dispatch-catalog';

type ReviewRequestPayload = ReturnType<ReviewDispatchViewModel['toRequestPayload']>;

export function ReviewDispatchPicker({
  model,
  disabled = false,
  review = true,
  testID = 'companion-review-dispatch',
  onChange,
  action,
  actionLabel,
  onInvoke,
  renderRowResources,
  discover = true,
}: {
  model: ReviewDispatchViewModel;
  disabled?: boolean;
  review?: boolean;
  testID?: string;
  onChange?: () => void;
  action?: ReviewDispatchAction;
  actionLabel?: string;
  onInvoke?: (action: ReviewDispatchAction, payload: ReviewRequestPayload) => void;
  renderRowResources?: (row: ReviewDispatchRow, index: number) => React.ReactNode;
  discover?: boolean;
}) {
  const { error, change } = useReviewDispatchCatalog(model, onChange, discover);
  const [otherModels, setOtherModels] = useState<Record<string, boolean>>({});
  const [modelFilters, setModelFilters] = useState<Record<string, string>>({});
  return (
    <View style={styles.picker} testID={testID}>
      {model.rows.map((row, index) => {
        const runner = model.catalog.runners.find((entry) => entry.id === row.selection.runner);
        const customKey = `${row.id}:${row.selection.runner}`;
        const customModel =
          row.selection.model !== null &&
          !runner?.models.some((option) => option.id === row.selection.model);
        const showOtherModel = Boolean(otherModels[customKey] || customModel);
        return (
          <View style={styles.card} key={row.id} testID={`${testID}-row-${index}`}>
            <View style={styles.row}>
              <Text style={styles.title}>
                {review ? 'Review' : 'Execution'} {index + 1}
              </Text>
              {model.context.allowSequence && (
                <>
                  <Choice
                    label="Move up"
                    disabled={disabled || index === 0}
                    onPress={() => change(() => model.moveRow(row.id, index - 1))}
                  />
                  <Choice
                    label="Move down"
                    disabled={disabled || index === model.rows.length - 1}
                    onPress={() => change(() => model.moveRow(row.id, index + 1))}
                  />
                  <Choice
                    label="Remove"
                    disabled={disabled || !model.canRemoveRow}
                    onPress={() => change(() => model.removeRow(row.id))}
                  />
                </>
              )}
            </View>
            <Text style={styles.label}>Runner</Text>
            <View style={styles.row}>
              {model.catalog.runners.map((runner) => (
                <Choice
                  key={runner.id}
                  label={runner.label ?? runner.id}
                  testID={`${testID}-runner-${index}-${runner.id}`}
                  selected={row.selection.runner === runner.id}
                  disabled={disabled}
                  onPress={() => change(() => model.setRunner(row.id, runner.id))}
                />
              ))}
            </View>
            <View style={styles.modelEffort}>
              <View style={styles.field}>
                <Text style={styles.label}>Model</Text>
                {runner && runner.models.length > 8 && (
                  <TextInput
                    accessibilityLabel="Filter models"
                    style={styles.input}
                    placeholder="Filter models"
                    placeholderTextColor={colors.textMuted}
                    value={modelFilters[customKey] ?? ''}
                    editable={!disabled}
                    onChangeText={(value) =>
                      setModelFilters((current) => ({ ...current, [customKey]: value }))
                    }
                  />
                )}
                <View style={styles.row}>
                  <Choice
                    label={`Runner default: ${runner?.defaultModel ?? 'automatic'}`}
                    testID={`${testID}-model-${index}-default`}
                    selected={row.selection.model === null}
                    disabled={disabled}
                    onPress={() =>
                      change(() => {
                        setOtherModels((current) => ({ ...current, [customKey]: false }));
                        model.setModel(row.id, null);
                      })
                    }
                  />
                  {(runner?.models ?? [])
                    .filter((choice) =>
                      (choice.label ?? choice.id)
                        .toLowerCase()
                        .includes((modelFilters[customKey] ?? '').toLowerCase()),
                    )
                    .map((choice) => (
                      <Choice
                        key={choice.id}
                        label={choice.label ?? choice.id}
                        testID={`${testID}-model-${index}-${choice.id}`}
                        selected={row.selection.model === choice.id}
                        disabled={disabled}
                        onPress={() =>
                          change(() => {
                            setOtherModels((current) => ({ ...current, [customKey]: false }));
                            model.setModel(row.id, choice.id);
                          })
                        }
                      />
                    ))}
                </View>
                {runner?.allowCustomModels && (
                  <Choice
                    label="Other model"
                    testID={`${testID}-other-model-${index}`}
                    selected={showOtherModel}
                    disabled={disabled}
                    onPress={() =>
                      setOtherModels((current) => ({
                        ...current,
                        [customKey]: !current[customKey],
                      }))
                    }
                  />
                )}
                {runner?.allowCustomModels && showOtherModel && (
                  <TextInput
                    testID={`${testID}-custom-model-${index}`}
                    style={styles.input}
                    value={row.selection.model ?? ''}
                    placeholder="Runner default or model id"
                    placeholderTextColor={colors.textMuted}
                    editable={!disabled}
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={(value) => change(() => model.setModel(row.id, value || null))}
                  />
                )}
              </View>
              <View style={styles.field}>
                <Text style={styles.label}>Effort</Text>
                <View style={styles.row}>
                  {(runner ? model.effortChoices(row.id) : []).map((choice) => (
                    <Choice
                      key={choice.value ?? 'default'}
                      label={choice.label}
                      testID={`${testID}-effort-${index}-${choice.value ?? 'default'}`}
                      selected={row.selection.effort === choice.value}
                      disabled={disabled}
                      onPress={() => change(() => model.setEffort(row.id, choice.value))}
                    />
                  ))}
                </View>
              </View>
            </View>
            {renderRowResources?.(row, index)}
            {review && (
              <>
                <Text style={styles.label}>Review mode</Text>
                <View style={styles.row}>
                  {REVIEW_MODES.map((mode) => (
                    <Choice
                      key={mode}
                      label={mode.toUpperCase()}
                      testID={`${testID}-mode-${index}-${mode}`}
                      selected={row.selection.mode === mode}
                      disabled={disabled}
                      onPress={() => change(() => model.setMode(row.id, mode))}
                    />
                  ))}
                </View>
                {row.selection.mode === 'warm' && row.context && (
                  <Text style={styles.help} testID={`${testID}-lineage-${index}`}>
                    Review lineage {row.context.repository}#{row.context.prNumber} /{' '}
                    {row.context.reviewId}
                  </Text>
                )}
                <Text style={styles.help}>
                  {row.selection.mode === 'warm'
                    ? "Reuse this PR's verified reviewer session for changes since its last reviewed head. An unavailable session requires waiting or choosing COLD."
                    : 'Create a fresh reviewer session for the complete PR diff.'}
                </Text>
              </>
            )}
          </View>
        );
      })}
      {model.context.allowSequence && (
        <Choice
          testID={`${testID}-add`}
          label={review ? '+ Add review' : '+ Add model alternative'}
          disabled={disabled || !model.canAddRow}
          onPress={() =>
            change(() => {
              model.addRow();
            })
          }
        />
      )}
      {model.errors.map((message) => (
        <Text key={message} style={styles.error}>
          {message}
        </Text>
      ))}
      {error && <Text style={styles.error}>{error}</Text>}
      {action && onInvoke && (
        <Choice
          testID={`${testID}-submit`}
          label={actionLabel ?? action}
          disabled={disabled || !model.canInvoke(action)}
          onPress={() => change(() => onInvoke(action, model.toRequestPayload()))}
        />
      )}
    </View>
  );
}

function Choice({
  label,
  selected = false,
  disabled = false,
  onPress,
  testID,
}: {
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.choice, selected && styles.selected, disabled && styles.disabled]}
    >
      <Text style={[styles.choiceText, selected && styles.selectedText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  picker: { gap: spacing.md },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.md,
    gap: spacing.sm,
    padding: spacing.md,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  title: { color: colors.textPrimary, fontSize: fonts.sizeSm, fontWeight: '800', flex: 1 },
  label: { color: colors.textSecondary, fontSize: fonts.sizeXs, fontWeight: '800' },
  modelEffort: { flexDirection: 'row', gap: spacing.md },
  field: { flex: 1, gap: spacing.sm },
  choice: {
    borderColor: colors.bgCardHover,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.sm,
  },
  selected: { backgroundColor: colors.accent + '20', borderColor: colors.accent },
  choiceText: { color: colors.textSecondary, fontSize: fonts.sizeXs, fontWeight: '700' },
  selectedText: { color: colors.accent },
  disabled: { opacity: 0.5 },
  input: {
    borderColor: colors.bgCardHover,
    borderWidth: 1,
    borderRadius: radii.md,
    color: colors.textPrimary,
    minHeight: 44,
    padding: spacing.sm,
  },
  help: { color: colors.textMuted, fontSize: fonts.sizeXs },
  error: { color: colors.statusFail, fontSize: fonts.sizeSm },
});
