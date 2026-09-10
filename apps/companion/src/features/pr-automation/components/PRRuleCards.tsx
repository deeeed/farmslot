import React from 'react';
import { Text, View } from 'react-native';

import { styles } from '../styles/pr-automation-styles';
import type { PRAutomationController } from '../use-pr-automation-controller';

import { PRButton, PRDisclosure } from './PRControls';
import { PRSourceProgress } from './PRSourceProgress';

export function PRRuleCards({ viewModel: vm, actions }: PRAutomationController) {
  return (
    <>
      <Text style={styles.muted}>
        Edit sources and predicates in Command Center. Enabling here applies to future matches; it
        does not import historical work.
      </Text>
      {(vm.reviews.notifications ?? [])
        .filter(
          (note) =>
            (!vm.teamId || note.teamId === vm.teamId) &&
            (vm.history ||
              note.id === vm.focusedNotificationId ||
              (note.current && !note.acknowledgedAt)),
        )
        .map((note) => (
          <View key={note.id} style={styles.card} testID={`companion-pr-notification-${note.id}`}>
            <Text style={styles.title}>
              {note.pr.repo}#{note.pr.number}: {note.title}
            </Text>
            <Text style={styles.muted}>
              {note.teamName} · {note.ruleName}
            </Text>
            <Text style={styles.text}>{note.reasons.join('; ')}</Text>
            <Text style={styles.muted}>
              {note.current ? 'Current match' : 'Historical match'} ·{' '}
              {new Date(note.createdAt).toLocaleString()}
            </Text>
            {note.acknowledgedAt ? (
              <Text style={styles.muted}>Acknowledged</Text>
            ) : (
              <PRButton
                label="Acknowledge notification"
                testID={`companion-pr-notification-ack-${note.id}`}
                disabled={vm.disabled}
                onPress={() => actions.acknowledgeNotification(note.id)}
              />
            )}
          </View>
        ))}
      {(vm.reviews.actions ?? [])
        .filter(
          (action) =>
            (action.kind === 'monitor' || action.status !== 'applied') &&
            (!vm.teamId || action.teamId === vm.teamId) &&
            (vm.history || action.current),
        )
        .map((action) => (
          <View key={action.id} style={styles.card}>
            <Text style={styles.text}>
              {action.subject.pr.repo}#{action.subject.pr.number} ·{' '}
              {action.kind === 'monitor' ? 'Monitor enrollment' : 'Notification'} {action.status}
            </Text>
            {action.error && <Text style={styles.error}>{action.error}</Text>}
          </View>
        ))}
      {vm.reviews.rules
        .filter((rule) => !vm.teamId || rule.config.teamId === vm.teamId)
        .map((rule) => {
          const preview =
            vm.preview?.ruleId === rule.id &&
            vm.preview.ruleRevision === rule.revision &&
            vm.preview.teamRevision ===
              vm.reviews.teams.find((team) => team.id === rule.config.teamId)?.revision
              ? vm.preview
              : undefined;
          return (
            <View key={rule.id} style={styles.card} testID={`companion-pr-rule-${rule.id}`}>
              <Text style={styles.title}>
                {rule.config.name} · {rule.enabled ? 'Enabled' : 'Disabled'}
              </Text>
              <Text style={styles.muted}>
                {vm.reviews.teams.find((team) => team.id === rule.config.teamId)?.config.name}
              </Text>
              <Text style={styles.muted}>
                {rule.scan.checkedAt
                  ? `Checked ${new Date(rule.scan.checkedAt).toLocaleString()}`
                  : 'Not scanned yet'}
              </Text>
              <PRSourceProgress progress={rule.scan.sourceProgress} />
              {rule.scan.error && <Text style={styles.error}>{rule.scan.error}</Text>}
              {rule.scan.admissionWarning && (
                <Text style={styles.attention}>{rule.scan.admissionWarning}</Text>
              )}
              <View style={styles.row}>
                <PRButton
                  label="Preview matches"
                  testID={`companion-pr-rule-preview-${rule.id}`}
                  disabled={vm.disabled}
                  onPress={() => actions.previewRule(rule)}
                />
                <PRButton
                  label={rule.enabled ? 'Disable rule' : 'Enable future matches'}
                  testID={`companion-pr-rule-toggle-${rule.id}`}
                  disabled={vm.disabled || (!rule.enabled && !preview?.complete)}
                  onPress={() => actions.toggleRule(rule)}
                />
              </View>
              {preview && (
                <View style={styles.card}>
                  <Text style={styles.title}>
                    {preview.complete ? 'Complete preview' : 'Incomplete coverage'}
                  </Text>
                  <PRSourceProgress progress={preview.sourceProgress} />
                  {preview.sourceErrors.map((error) => (
                    <Text key={error} style={styles.error}>
                      {error}
                    </Text>
                  ))}
                  <Text style={styles.muted}>
                    {preview.ignoredItems} archived or non-PR Project items excluded
                  </Text>
                  <Text style={styles.muted}>
                    {preview.items.filter((item) => item.match.state === 'match').length} matches ·{' '}
                    {preview.items.filter((item) => item.match.state === 'no-match').length}{' '}
                    non-matches
                  </Text>
                  <PRDisclosure
                    label="preview results"
                    testID={`companion-pr-rule-results-${rule.id}`}
                  >
                    {preview.items
                      .filter((item) => item.match.state !== 'no-match')
                      .map((item) => (
                        <View key={`${item.subject.pr.repo}:${item.subject.pr.number}`}>
                          <Text style={styles.text}>
                            {item.subject.pr.repo}#{item.subject.pr.number}: {item.match.state}
                          </Text>
                          <Text style={styles.muted}>{item.match.reasons.join('; ')}</Text>
                          {(item.policySummary ?? []).map((summary) => (
                            <Text key={summary} style={styles.muted}>
                              {summary}
                            </Text>
                          ))}
                          {[
                            ...item.configurationErrors,
                            ...Object.values(item.actionErrors ?? {}).flat(),
                          ].map((error, index) => (
                            <Text key={index} style={styles.error}>
                              {error}
                            </Text>
                          ))}
                        </View>
                      ))}
                  </PRDisclosure>
                </View>
              )}
            </View>
          );
        })}
    </>
  );
}
