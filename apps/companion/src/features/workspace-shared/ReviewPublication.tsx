import { Text, View } from 'react-native';

import type { Run } from '@farmslot/protocol';

import { PRButton } from '../pr-automation/components/PRControls';
import { styles } from '../pr-automation/styles/pr-automation-styles';

import { useReviewPublication } from './use-review-publication';

function ReviewPublicationPanel({
  viewModel: vm,
  busy,
  error,
  disabled,
  retry,
  open,
}: ReturnType<typeof useReviewPublication>) {
  if (!vm) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{vm.label}</Text>
      <Text style={styles.muted}>
        {[vm.account, vm.source, vm.state].filter(Boolean).join(' · ')}
      </Text>
      {(error || vm.error) && <Text style={styles.error}>{error || vm.error}</Text>}
      {vm.url && (
        <PRButton label="Open published review" onPress={open} disabled={busy || disabled} />
      )}
      {vm.canRetry && (
        <PRButton
          label={busy ? 'Publishing…' : 'Retry publication'}
          onPress={retry}
          disabled={busy || disabled}
        />
      )}
    </View>
  );
}

export function ReviewPublication({ run }: { run: Run }) {
  const controller = useReviewPublication(run);
  return <ReviewPublicationPanel {...controller} />;
}
