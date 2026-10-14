import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import {
  SOURCE_VIEW_ACTION_LABELS,
  type SourceSelection,
  type SourceStatusController,
  type SourceStatusRowView,
  type SourceStatusSnapshot,
  type SourceStatusViewContext,
} from '@farmslot/protocol';

import { baseStyles } from '../../lib/theme';

import { sourceStyles as styles } from './styles/source-status.styles';
import { useSourceStatusController } from './use-source-status-controller';

interface SourceStatusSectionProps {
  context: SourceStatusViewContext;
  onSelectionsChange?: (selections: SourceSelection[]) => void;
  onSelectionStateChange?: (refusal: string | undefined) => void;
}

function SourceRow({
  row,
  snapshot,
  controller,
}: {
  row: SourceStatusRowView;
  snapshot: SourceStatusSnapshot;
  controller: SourceStatusController;
}) {
  const [facts, setFacts] = useState(false);
  const view = snapshot.view!;
  return (
    <View style={styles.row} testID={`source-${row.declaration.id}`}>
      <Text style={styles.facts}>{row.summary}</Text>
      <Pressable onPress={() => setFacts(!facts)}>
        <Text style={baseStyles.textSecondary}>Pin, lock and verification facts</Text>
      </Pressable>
      {facts &&
        row.details.map((line, index) => (
          <Text key={index} style={styles.facts}>
            {line}
          </Text>
        ))}
      {view.editable && (
        <TextInput
          accessibilityLabel={`Pushed branch for ${row.declaration.id}`}
          testID={`source-${row.declaration.id}-branch`}
          placeholder="Pushed branch"
          placeholderTextColor={styles.placeholder.color}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          value={row.selection?.ref ?? ''}
          editable={snapshot.canEdit}
          onChangeText={(ref) =>
            controller.select({ sourceId: row.declaration.id, selection: 'branch', ref })
          }
        />
      )}
      {row.selectionErrors.map((message) => (
        <Text key={message} style={styles.error}>
          {message}
        </Text>
      ))}
      <View style={styles.actions}>
        {view.draft && (
          <>
            <Pressable
              testID={`source-${row.declaration.id}-main`}
              disabled={!snapshot.canEdit}
              style={styles.button}
              onPress={() => controller.select({ sourceId: row.declaration.id, selection: 'main' })}
            >
              <Text style={baseStyles.textPrimary}>Use main</Text>
            </Pressable>
            <Pressable
              disabled={!snapshot.canEdit}
              style={styles.button}
              onPress={() => controller.clearSelection(row.declaration.id)}
            >
              <Text style={baseStyles.textPrimary}>Inherit scope</Text>
            </Pressable>
          </>
        )}
        {view.actions.map((action) => (
          <Pressable
            key={action}
            testID={`source-${row.declaration.id}-${action}`}
            disabled={!snapshot.interactive || (action === 'pin' && !row.canPin)}
            style={styles.button}
            onPress={() => void controller.apply(action, row.declaration.id)}
          >
            <Text style={baseStyles.textPrimary}>{SOURCE_VIEW_ACTION_LABELS[action]}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** Platform wiring only; one protocol controller owns facts, selection validation and mutations. */
export function SourceStatusSection(props: SourceStatusSectionProps) {
  const {
    viewModel: snapshot,
    controller,
    visible,
  } = useSourceStatusController(
    props.context,
    props.onSelectionsChange,
    props.onSelectionStateChange,
  );
  if (!visible) return null;
  const view = snapshot.view;
  return (
    <View style={styles.panel} testID="sources-panel">
      <View style={styles.header}>
        <Text style={baseStyles.textPrimary}>Sources</Text>
        <Pressable testID="sources-refresh" onPress={() => void controller.refresh()}>
          <Text style={baseStyles.textSecondary}>Refresh</Text>
        </Pressable>
      </View>
      {snapshot.loading && <Text style={baseStyles.textSecondary}>Loading sources...</Text>}
      {snapshot.error && (
        <Text style={styles.error} accessibilityRole="alert">
          {snapshot.error}
        </Text>
      )}
      {snapshot.operationError && (
        <Text style={styles.error} accessibilityRole="alert" testID="sources-operation-error">
          {snapshot.operationError}
        </Text>
      )}
      {snapshot.notice && <Text style={baseStyles.textPrimary}>{snapshot.notice}</Text>}
      {snapshot.pending && (
        <>
          <Text style={baseStyles.textPrimary}>{snapshot.pendingLabel}</Text>
          <Pressable
            testID="sources-retry"
            disabled={!snapshot.canRetry}
            style={styles.button}
            onPress={() => void controller.retry()}
          >
            <Text style={baseStyles.textPrimary}>Retry this request</Text>
          </Pressable>
        </>
      )}
      {view?.readOnlyReason && <Text style={baseStyles.textSecondary}>{view.readOnlyReason}</Text>}
      {view?.rows.map((row) => (
        <SourceRow key={row.declaration.id} row={row} snapshot={snapshot} controller={controller} />
      ))}
      {view?.errors.map((error, index) => (
        <Text key={index} style={styles.error}>
          {error.nodeId ?? error.sourceId ?? error.project}: {error.reason}
        </Text>
      ))}
    </View>
  );
}

export function NodeSourceStatusDisclosure({ nodeId }: { nodeId: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <Pressable testID={`node-${nodeId}-sources`} onPress={() => setExpanded(!expanded)}>
        <Text style={baseStyles.textSecondary}>Sources</Text>
      </Pressable>
      {expanded && (
        <SourceStatusSection
          context={{
            target: { scope: 'node', targetId: nodeId },
            actions: ['sync', 'pin', 'unpin'],
          }}
        />
      )}
    </View>
  );
}
