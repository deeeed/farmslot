import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';

import { ResourceReadStatus } from '../../components/ResourceReadStatus';
import { colors } from '../../lib/theme';

import { planningListStyles as styles } from './styles/planning-lists';
import type { useDispatchQueueController } from './use-dispatch-queue-controller';

export default function DispatchQueueScreen({
  screen,
}: {
  screen: ReturnType<typeof useDispatchQueueController>;
}) {
  const { state, actions } = screen;
  return (
    <View style={styles.container} testID="companion-dispatch-queue">
      <View style={styles.toolbar}>
        <Pressable accessibilityRole="button" style={styles.button} onPress={actions.back}>
          <Text style={styles.buttonText}>Back</Text>
        </Pressable>
        <View>
          <Text style={styles.title}>Dispatch queue</Text>
          <Text style={styles.meta}>{state.items.length} items</Text>
        </View>
      </View>
      <ResourceReadStatus observation={state.observation} label="dispatch queue" />
      {state.observation.error ? (
        <Pressable
          testID="companion-dispatch-queue-retry"
          accessibilityRole="button"
          style={[styles.button, styles.retry]}
          disabled={!state.canRetry}
          onPress={() => void actions.retry()}
        >
          <Text style={styles.buttonText}>Retry queue read</Text>
        </Pressable>
      ) : null}
      <FlatList
        data={state.items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.list, { paddingBottom: state.bottomPadding }]}
        ListEmptyComponent={
          !state.canRead ? (
            <Text style={styles.empty}>Open a farm workspace to read the dispatch queue.</Text>
          ) : state.observation.status === 'loading' ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Text style={styles.empty}>No queued items in this project scope.</Text>
          )
        }
        renderItem={({ item }) => (
          <View style={styles.card} testID={`companion-queue-${item.id}`}>
            <Text style={styles.heading}>{item.label || item.ticketOrPr}</Text>
            <Text style={styles.status}>{item.status}</Text>
            <Text style={styles.meta}>
              {item.project} · {item.flowType} · Priority {item.priority}
            </Text>
            <Text style={styles.ref}>{item.ticketOrPr}</Text>
            <Text style={styles.ref}>{item.id}</Text>
            {item.waitingReason ? <Text style={styles.meta}>{item.waitingReason}</Text> : null}
          </View>
        )}
      />
    </View>
  );
}
