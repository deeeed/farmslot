import React from 'react';
import { Text, View } from 'react-native';

import { styles } from '../styles/pr-automation-styles';
import type { PRAutomationController } from '../use-pr-automation-controller';

import { PRButton } from './PRControls';

export function PRPushCard({ viewModel: vm, actions }: PRAutomationController) {
  const attention = vm.push.attention.filter(
    (item) =>
      item.id === vm.focusedAttentionId ||
      ((!vm.teamId || item.teamId === vm.teamId) &&
        (vm.history || (item.current && !item.acknowledgedAt))),
  );
  const failures = vm.push.deliveries.filter(
    (delivery) =>
      delivery.deviceId === vm.pushDevice?.id &&
      ['failed', 'unknown', 'retry'].includes(delivery.state),
  );
  return (
    <View style={styles.card} testID="companion-pr-push">
      <Text style={styles.title}>PR notifications</Text>
      <Text style={styles.muted}>
        {vm.pushDevice?.enabled ? 'Push enabled on this device' : 'Push is off on this device'}
      </Text>
      <PRButton
        testID="companion-pr-push-toggle"
        label={vm.pushDevice?.enabled ? 'Disable PR push' : 'Enable PR push'}
        disabled={vm.disabled}
        onPress={vm.pushDevice?.enabled ? actions.disablePush : actions.registerPush}
      />
      {[vm.pushError, vm.pushDevice?.error, vm.push.schedulerError]
        .filter(Boolean)
        .map((error, index) => (
          <Text key={index} style={styles.error}>
            {error}
          </Text>
        ))}
      {failures.map((delivery) => (
        <Text key={delivery.id} style={styles.attention}>
          {delivery.error}
          {delivery.nextAttemptAt
            ? ` · Retry ${new Date(delivery.nextAttemptAt).toLocaleString()}`
            : ''}
        </Text>
      ))}
      {attention.map((item) => (
        <View key={item.id} style={styles.card} testID={`companion-pr-attention-${item.id}`}>
          <Text style={styles.title}>{item.title}</Text>
          <Text style={styles.text}>{item.body}</Text>
          <Text style={styles.muted}>
            {item.current ? 'Current attention' : 'Historical attention'} ·{' '}
            {new Date(item.createdAt).toLocaleString()}
          </Text>
          {item.acknowledgedAt ? (
            <Text style={styles.muted}>Acknowledged</Text>
          ) : (
            <PRButton
              testID={`companion-pr-attention-ack-${item.id}`}
              label="Acknowledge for me"
              disabled={vm.disabled}
              onPress={() => actions.acknowledgeAttention(item.id)}
            />
          )}
        </View>
      ))}
    </View>
  );
}
