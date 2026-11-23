import { useMemo } from 'react';
import { Text, View } from 'react-native';

import type { Run } from '@farmslot/protocol';
import { runCostSummaryForRun } from '@farmslot/review-dispatch';

import { styles } from '../styles/review-history.styles';

export function RunCostCard({ run }: { run: Run }) {
  const cost = useMemo(() => runCostSummaryForRun(run), [run]);
  if (!cost) return null;
  return (
    <View style={styles.section} testID="run-cost">
      <Text style={styles.title}>{cost.subtotal}</Text>
      <Text style={styles.meta}>{cost.coverage}</Text>
      {cost.estimate ? <Text style={styles.meta}>{cost.estimate}</Text> : null}
      {cost.phases.map(({ phase, label, detail }) => (
        <Text key={phase} style={styles.meta}>
          {phase} · {label}
          {detail ? ' · ' + detail : ''}
        </Text>
      ))}
    </View>
  );
}
