import React, { useState } from 'react';
import { Text, View } from 'react-native';

import { prExecutionText, prMonitorFreshness } from '../../../lib/pr-automation';
import { styles } from '../styles/pr-automation-styles';
import type { PRAutomationController } from '../use-pr-automation-controller';

import { PRButton, PRDisclosure } from './PRControls';

export function PRMonitorCards({ viewModel: vm, actions }: PRAutomationController) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const monitors = vm.watches.monitors
    .filter(
      (monitor) =>
        (!vm.teamId || monitor.config.teamId === vm.teamId) &&
        (vm.history ||
          !['stopped', 'finished'].includes(monitor.lifecycle) ||
          vm.focusedMonitorId === monitor.id),
    )
    .sort(
      (left, right) =>
        Number(right.id === vm.focusedMonitorId) - Number(left.id === vm.focusedMonitorId),
    );
  return (
    <>
      <PRButton
        label="Add PR monitoring"
        testID="companion-pr-monitor-add"
        disabled={vm.disabled}
        onPress={() => actions.openMonitor()}
      />
      {!monitors.length && (
        <Text style={styles.muted}>
          No subscriptions in this view. Add any accessible PR to monitor it independently of runs.
        </Text>
      )}
      {monitors.map((monitor) => (
        <View key={monitor.id} style={styles.card} testID={`companion-pr-monitor-${monitor.id}`}>
          <PRButton
            label={`${monitor.config.pr.repo}#${monitor.config.pr.number}`}
            onPress={() => actions.openPR(monitor)}
          />
          <Text style={styles.title} numberOfLines={expanded[monitor.id] ? undefined : 2}>
            {monitor.observation?.title ?? 'Awaiting PR details'}
          </Text>
          <Text style={styles.text}>
            {monitor.lifecycle} ·{' '}
            {monitor.config.policy.mode === 'notify-only' ? 'Notify only' : 'Automatic repair'}
          </Text>
          <Text style={styles.muted}>
            {prMonitorFreshness(monitor)} · {monitor.config.account.login}
          </Text>
          <PRButton
            label={expanded[monitor.id] ? 'Hide details' : 'Show details'}
            testID={`companion-pr-monitor-details-${monitor.id}`}
            expanded={Boolean(expanded[monitor.id])}
            onPress={() =>
              setExpanded((current) => ({ ...current, [monitor.id]: !current[monitor.id] }))
            }
          />
          {monitor.observationError && <Text style={styles.error}>{monitor.observationError}</Text>}
          <Text style={styles.attention}>
            {
              monitor.incidents.filter((incident) => !incident.resolvedAt && !incident.handledAt)
                .length
            }{' '}
            outstanding incidents
          </Text>
          {!expanded[monitor.id] ? null : (
            <>
              {monitor.observation && (
                <Text style={styles.text}>
                  {monitor.observation.state} · {monitor.observation.mergeability} ·{' '}
                  {monitor.observation.reviewDecision}
                </Text>
              )}
              {!!monitor.observation?.checks?.length && (
                <PRDisclosure
                  label={`checks (${monitor.observation.checks.length})`}
                  testID={`companion-pr-monitor-checks-${monitor.id}`}
                >
                  {(monitor.observation?.checks ?? []).map((check) => (
                    <Text key={check.key} style={styles.muted}>
                      {check.name}: {check.status}
                    </Text>
                  ))}
                </PRDisclosure>
              )}
              {monitor.incidents
                .filter((incident) => vm.history || !incident.resolvedAt)
                .map((incident) => (
                  <View key={incident.id} style={styles.card}>
                    <Text style={styles.text}>{incident.signal.summary}</Text>
                    <Text style={styles.muted}>
                      {incident.resolvedAt
                        ? 'Resolved'
                        : incident.handledAt
                          ? 'Handled; awaiting provider resolution'
                          : 'Needs attention'}{' '}
                      · {incident.attemptCount} repair attempts
                    </Text>
                    {incident.waitingReason && (
                      <Text style={styles.attention}>{incident.waitingReason}</Text>
                    )}
                    {incident.resumeCondition && (
                      <Text style={styles.attention}>{incident.resumeCondition}</Text>
                    )}
                    {incident.snoozedUntil && (
                      <Text style={styles.muted}>
                        Snoozed until {new Date(incident.snoozedUntil).toLocaleString()}
                      </Text>
                    )}
                    {incident.acknowledgedAt && <Text style={styles.muted}>Acknowledged</Text>}
                    {!incident.resolvedAt && (
                      <View style={styles.row}>
                        <PRButton
                          label="Acknowledge"
                          disabled={vm.disabled}
                          onPress={() => actions.acknowledgeIncident(monitor, incident.id, false)}
                        />
                        <PRButton
                          label="Snooze 1 hour"
                          disabled={vm.disabled}
                          onPress={() => actions.acknowledgeIncident(monitor, incident.id, true)}
                        />
                      </View>
                    )}
                    {incident.runId && (
                      <PRButton
                        label="Open repair run"
                        onPress={() => actions.openRun(incident.runId!)}
                      />
                    )}
                  </View>
                ))}
              {(monitor.repairs ?? [])
                .filter((repair) => vm.history || !['finished', 'cancelled'].includes(repair.state))
                .map((repair) => (
                  <View key={repair.id} style={styles.card}>
                    <Text style={styles.text}>
                      Repair {repair.state} · {repair.mode}
                    </Text>
                    <Text style={styles.muted}>{prExecutionText(repair.execution)}</Text>
                    {repair.waitingReason && (
                      <Text style={styles.attention}>{repair.waitingReason}</Text>
                    )}
                    {repair.nextAdmissionAt && (
                      <Text style={styles.muted}>
                        Next eligible {new Date(repair.nextAdmissionAt).toLocaleString()}
                      </Text>
                    )}
                    {repair.runId && (
                      <PRButton
                        label="Open repair run"
                        onPress={() => actions.openRun(repair.runId!)}
                      />
                    )}
                  </View>
                ))}
              <View style={styles.row}>
                <PRButton
                  label="Configure"
                  testID={`companion-pr-monitor-edit-${monitor.id}`}
                  disabled={vm.disabled}
                  onPress={() => actions.openMonitor(monitor)}
                />
                <PRButton
                  label="Refresh"
                  disabled={vm.disabled || monitor.lifecycle !== 'active'}
                  onPress={() => actions.refreshMonitor(monitor)}
                />
                <PRButton
                  label={monitor.lifecycle === 'active' ? 'Pause' : 'Resume'}
                  testID={`companion-pr-monitor-pause-${monitor.id}`}
                  disabled={vm.disabled}
                  onPress={() =>
                    actions.monitorLifecycle(
                      monitor,
                      monitor.lifecycle === 'active' ? 'paused' : 'active',
                    )
                  }
                />
                <PRButton
                  label="Stop monitoring"
                  disabled={vm.disabled || ['stopped', 'finished'].includes(monitor.lifecycle)}
                  onPress={() => actions.monitorLifecycle(monitor, 'stopped')}
                />
                <PRButton
                  label="Request repair"
                  disabled={vm.disabled || monitor.lifecycle !== 'active'}
                  onPress={() => actions.openRepair(monitor)}
                />
              </View>
            </>
          )}
        </View>
      ))}
    </>
  );
}
