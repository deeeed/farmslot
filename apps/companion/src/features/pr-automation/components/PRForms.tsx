import React from 'react';
import { Text, View } from 'react-native';

import { prExecutionText, prReviewText } from '../../../lib/pr-automation';
import { styles } from '../styles/pr-automation-styles';
import type { PRAutomationController } from '../use-pr-automation-controller';

import { PRButton, PRInput, PRToggle } from './PRControls';
import { PRExecutionFields, PRReviewFields } from './PRPolicyFields';
import { PRTeamPicker } from './PRTeamPicker';

export function PRForms({ viewModel: vm, actions }: PRAutomationController) {
  const editor = vm.editor;
  if (!editor) return null;
  if (editor.kind === 'request')
    return (
      <View style={styles.card} testID="companion-pr-request-form">
        <Text style={styles.title}>Request PR review / QA</Text>
        <PRButton label="Close editor" disabled={vm.busy} onPress={actions.closeEditor} />
        <PRInput
          label="PR URL"
          testID="companion-pr-request-url"
          value={vm.requestDraft.url}
          disabled={vm.disabled}
          onChange={(url) => actions.editRequest({ url })}
        />
        <Text style={styles.muted}>Team policy</Text>
        {vm.reviews.teams.length ? (
          <PRTeamPicker
            teams={vm.reviews.teams}
            value={vm.requestDraft.teamId}
            disabled={vm.disabled}
            onChange={(teamId) => actions.editRequest({ teamId })}
          />
        ) : (
          <Text style={styles.attention}>
            Create a team in Command Center before submitting a review.
          </Text>
        )}
        <Text style={styles.muted}>
          {vm.effectiveRequest.project || 'No project mapping'} ·{' '}
          {vm.effectiveRequest.reviewProfile}
        </Text>
        <PRToggle
          label="Start automatically when an allowed slot is available"
          value={vm.requestDraft.autoStart}
          disabled={vm.disabled}
          onChange={(autoStart) => actions.editRequest({ autoStart })}
        />
        <Text style={styles.muted}>Otherwise the request waits for acceptance.</Text>
        <PRToggle
          label="Override inherited review options"
          testID="companion-pr-request-override"
          value={vm.requestDraft.overrideReview}
          disabled={vm.disabled}
          onChange={(overrideReview) => actions.editRequest({ overrideReview })}
        />
        {vm.requestDraft.overrideReview ? (
          <PRReviewFields
            value={vm.effectiveRequest.review}
            disabled={vm.disabled}
            onChange={(review) => actions.editRequest({ review })}
          />
        ) : (
          <Text style={styles.text}>{prReviewText(vm.effectiveRequest.review)}</Text>
        )}
        <PRToggle
          label="Override inherited slots and models"
          value={vm.requestDraft.overrideExecution}
          disabled={vm.disabled}
          onChange={(overrideExecution) => actions.editRequest({ overrideExecution })}
        />
        {vm.requestDraft.overrideExecution && vm.effectiveRequest.execution ? (
          <PRExecutionFields
            value={vm.effectiveRequest.execution}
            slots={vm.slots}
            project={vm.effectiveRequest.project}
            disabled={vm.disabled}
            onChange={(execution) => actions.editRequest({ execution })}
          />
        ) : (
          <Text style={styles.muted}>{prExecutionText(vm.effectiveRequest.execution)}</Text>
        )}
        <PRButton
          label="Request review"
          testID="companion-pr-request-submit"
          disabled={vm.disabled}
          onPress={actions.saveEditor}
        />
      </View>
    );
  const draft = vm.monitorDraft;
  const isPolicy = editor.kind === 'policy';
  const isRepair = editor.kind === 'repair';
  return (
    <View style={styles.card} testID="companion-pr-monitor-form">
      <Text style={styles.title}>
        {isPolicy ? 'Publication monitoring' : isRepair ? 'Request repair' : 'PR monitoring'}
      </Text>
      <PRButton label="Close editor" disabled={vm.busy} onPress={actions.closeEditor} />
      {!isPolicy && !isRepair && (
        <PRInput
          label="PR URL"
          testID="companion-pr-monitor-url"
          value={draft.url}
          disabled={vm.disabled || !!editor.original}
          onChange={(url) => actions.editMonitor({ url })}
        />
      )}
      {!isRepair && (
        <PRInput
          label="GitHub account login"
          testID="companion-pr-monitor-account"
          value={draft.login}
          disabled={vm.disabled || (editor.kind === 'monitor' && !!editor.original)}
          onChange={(login) => actions.editMonitor({ login })}
        />
      )}
      {isPolicy && (
        <PRInput
          label="GitHub host"
          value={draft.host}
          disabled={vm.disabled}
          onChange={(host) => actions.editMonitor({ host })}
        />
      )}
      <PRInput
        label="Farmslot project"
        testID="companion-pr-monitor-project"
        value={draft.project}
        disabled={vm.disabled || (isPolicy && !!editor.original)}
        onChange={(project) => actions.editMonitor({ project })}
      />
      <Text style={styles.muted}>
        {isPolicy
          ? 'Applies only to new publications while enabled.'
          : 'A project mapping is required for repair.'}
      </Text>
      {isPolicy && (
        <PRToggle
          label="Enable for new publications"
          value={draft.enabled}
          disabled={vm.disabled}
          onChange={(enabled) => actions.editMonitor({ enabled })}
        />
      )}
      {!isRepair && (
        <PRToggle
          label="Allow automatic PR repair"
          testID="companion-pr-monitor-automatic"
          value={draft.automatic}
          disabled={vm.disabled}
          onChange={(automatic) => actions.editMonitor({ automatic })}
        />
      )}
      {(isRepair || draft.automatic) && (
        <PRExecutionFields
          value={draft.execution}
          onChange={(execution) => actions.editMonitor({ execution })}
          slots={vm.slots}
          project={draft.project}
          disabled={vm.disabled}
        />
      )}
      {!isRepair && (
        <>
          <PRInput
            label="Watched checks, one per line"
            multiline
            value={draft.checks}
            disabled={vm.disabled}
            onChange={(checks) => actions.editMonitor({ checks })}
          />
          <PRInput
            label="Poll interval, seconds"
            testID="companion-pr-monitor-interval"
            numeric
            value={draft.intervalSeconds}
            disabled={vm.disabled}
            onChange={(intervalSeconds) => actions.editMonitor({ intervalSeconds })}
          />
          <PRInput
            label="Automatic attempt limit"
            numeric
            value={draft.attemptLimit}
            disabled={vm.disabled}
            onChange={(attemptLimit) => actions.editMonitor({ attemptLimit })}
          />
          <PRInput
            label="Repair cooldown, minutes"
            numeric
            value={draft.cooldownMinutes}
            disabled={vm.disabled}
            onChange={(cooldownMinutes) => actions.editMonitor({ cooldownMinutes })}
          />
        </>
      )}
      <PRButton
        label={isRepair ? 'Request repair' : 'Save monitoring'}
        testID="companion-pr-monitor-submit"
        disabled={vm.disabled}
        onPress={actions.saveEditor}
      />
    </View>
  );
}
