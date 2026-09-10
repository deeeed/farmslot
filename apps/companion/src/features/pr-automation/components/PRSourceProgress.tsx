import React from 'react';
import { Text, View } from 'react-native';

import type { PRRuleSourceProgress } from '@farmslot/protocol';

import { styles } from '../styles/pr-automation-styles';

export function PRSourceProgress({ progress }: { progress?: PRRuleSourceProgress }) {
  if (!progress) return null;
  return (
    <View testID="companion-pr-source-progress">
      <Text style={styles.muted}>
        {progress.completedAt ? 'Source scan complete' : 'Source scan in progress'} ·{' '}
        {progress.pages} pages saved
      </Text>
      <Text style={styles.muted}>
        {progress.oldestObservationAt ? 'Source observations from' : 'Scan started'}{' '}
        {new Date(progress.oldestObservationAt ?? progress.startedAt).toLocaleString()}
      </Text>
      {progress.resumed && <Text style={styles.muted}>Using saved scan progress</Text>}
      {progress.nextAttemptAt && (
        <Text style={styles.attention}>
          Retry available {new Date(progress.nextAttemptAt).toLocaleString()}
        </Text>
      )}
    </View>
  );
}
