import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';

import { ResourceReadStatus } from '../../components/ResourceReadStatus';
import { colors } from '../../lib/theme';

import { planningListStyles as styles } from './styles/planning-lists';
import type { useWorkGraphsController } from './use-work-graphs-controller';

export default function WorkGraphsScreen({
  screen,
}: {
  screen: ReturnType<typeof useWorkGraphsController>;
}) {
  const { state, actions } = screen;
  return (
    <View style={styles.container} testID="companion-work-graphs">
      <View style={styles.toolbar}>
        <Pressable accessibilityRole="button" style={styles.button} onPress={actions.back}>
          <Text style={styles.buttonText}>Back</Text>
        </Pressable>
        <View>
          <Text style={styles.title}>Work graphs</Text>
          <Text style={styles.meta}>{state.graphs.length} graphs</Text>
        </View>
      </View>
      <ResourceReadStatus observation={state.observation} label="work graphs" />
      {state.observation.error ? (
        <Pressable
          testID="companion-work-graphs-retry"
          accessibilityRole="button"
          style={[styles.button, styles.retry]}
          disabled={!state.canRetry}
          onPress={() => void actions.retry()}
        >
          <Text style={styles.buttonText}>Retry graph read</Text>
        </Pressable>
      ) : null}
      <FlatList
        data={state.graphs}
        keyExtractor={({ graph }) => graph.id}
        contentContainerStyle={[styles.list, { paddingBottom: state.bottomPadding }]}
        ListEmptyComponent={
          !state.canRead ? (
            <Text style={styles.empty}>Open a farm workspace to read work graphs.</Text>
          ) : state.observation.status === 'loading' ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Text style={styles.empty}>No work graphs in this project scope.</Text>
          )
        }
        renderItem={({ item }) => {
          const expanded = state.selectedGraphId === item.graph.id;
          return (
            <View style={styles.card}>
              <Pressable
                testID={`companion-work-graph-${item.graph.id}`}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => actions.selectGraph(item.graph.id)}
              >
                <Text style={styles.heading}>{item.graph.title}</Text>
                <Text style={styles.status}>{item.graph.status}</Text>
                <Text style={styles.meta}>
                  {item.graph.project} · {item.nodes.length} nodes · {item.edges.length}{' '}
                  dependencies
                </Text>
                <Text style={styles.ref}>{item.graph.id}</Text>
              </Pressable>
              {expanded ? (
                <View
                  style={styles.details}
                  testID={`companion-work-graph-${item.graph.id}-details`}
                >
                  {item.nodes.map((node) => (
                    <View key={node.id} style={styles.node}>
                      <Text style={styles.heading}>
                        {node.reference?.title ?? node.backlogItemId ?? node.id}
                      </Text>
                      <Text style={styles.status}>{node.status}</Text>
                      <Text style={styles.ref}>{node.id}</Text>
                      {node.waitingOn.map((reason, index) => (
                        <Text key={index} style={styles.meta}>
                          {reason.detail}
                        </Text>
                      ))}
                    </View>
                  ))}
                  {item.edges.map((edge) => (
                    <Text key={edge.id} style={styles.meta}>
                      {edge.fromNodeId} → {edge.toNodeId} · {edge.status}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>
          );
        }}
      />
    </View>
  );
}
