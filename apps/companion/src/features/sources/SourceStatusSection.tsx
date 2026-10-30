import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import {
  SOURCE_VIEW_ACTION_LABELS,
  sourceObservationAge,
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
  const view = snapshot.view!;
  return (
    <View style={styles.row} testID={`source-${row.declaration.id}`}>
      <Text style={styles.facts}>{row.declaration.id}</Text>
      {view.editable && (
        <TextInput
          accessibilityLabel={`Pushed branch for ${row.declaration.id}`}
          testID={`source-${row.declaration.id}-branch`}
          placeholder="Pushed branch"
          placeholderTextColor={styles.placeholder.color}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, !snapshot.canEdit && styles.disabled]}
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
              accessibilityRole="button"
              accessibilityState={{ disabled: !snapshot.canEdit }}
              style={[styles.button, !snapshot.canEdit && styles.disabled]}
              onPress={() => controller.select({ sourceId: row.declaration.id, selection: 'main' })}
            >
              <Text style={baseStyles.textPrimary}>Use main</Text>
            </Pressable>
            <Pressable
              disabled={!snapshot.canEdit}
              accessibilityRole="button"
              accessibilityState={{ disabled: !snapshot.canEdit }}
              style={[styles.button, !snapshot.canEdit && styles.disabled]}
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
            accessibilityRole="button"
            accessibilityState={{
              disabled: !snapshot.interactive || (action === 'pin' && !row.canPin),
            }}
            style={[
              styles.button,
              (!snapshot.interactive || (action === 'pin' && !row.canPin)) && styles.disabled,
            ]}
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
    viewKey,
  } = useSourceStatusController(
    props.context,
    props.onSelectionsChange,
    props.onSelectionStateChange,
  );
  const [details, setDetails] = useState(false);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const view = snapshot.view;
  useEffect(() => {
    setOpen(false);
    setDetails(false);
  }, [controller, viewKey, props.context.target?.scope, props.context.target?.targetId]);
  useEffect(() => {
    if (!visible || snapshot.hidden) setOpen(false);
  }, [visible, snapshot.hidden]);
  const saved = visible && Boolean(view) && snapshot.freshness !== 'ready';
  useEffect(() => {
    if (!saved) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [saved]);
  if (!visible) return <View style={styles.disclosureSlot} />;
  return (
    <View style={styles.disclosureSlot}>
      <Pressable
        style={styles.disclosure}
        disabled={snapshot.hidden}
        accessibilityRole="button"
        accessibilityLabel="Sources"
        accessibilityState={{ disabled: snapshot.hidden, expanded: open }}
        testID="sources-open"
        onPress={() => setOpen(true)}
      >
        <Text style={baseStyles.textPrimary}>Sources</Text>
        <Text
          style={styles.disclosureSummary}
          numberOfLines={1}
          testID={open ? undefined : 'sources-line'}
        >
          {snapshot.loading
            ? 'Loading…'
            : snapshot.error
              ? 'Could not refresh'
              : snapshot.hidden
                ? ''
                : view?.line}
          {saved ? (
            <Text testID={open ? undefined : 'sources-stale'}>
              {' '}
              · Saved {sourceObservationAge(snapshot.observedAt, now)}
            </Text>
          ) : null}
        </Text>
      </Pressable>
      <Modal
        visible={open && !snapshot.hidden && visible}
        transparent
        animationType="none"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.backdrop}>
          <View style={styles.dialog}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close sources"
              style={styles.close}
              onPress={() => setOpen(false)}
            >
              <Text style={baseStyles.textPrimary}>Close</Text>
            </Pressable>
            <ScrollView>
              <View style={styles.panel} testID="sources-panel">
                <View style={styles.header}>
                  <Text style={baseStyles.textPrimary}>Sources</Text>
                  {view && (
                    <Text style={styles.facts} testID="sources-line">
                      {view.line}
                    </Text>
                  )}
                </View>
                {view && snapshot.freshness !== 'ready' && (
                  <Text style={baseStyles.textSecondary} testID="sources-stale">
                    Stale · {sourceObservationAge(snapshot.observedAt, now)}
                  </Text>
                )}
                {snapshot.unsupported && (
                  <Text style={baseStyles.textSecondary} testID="sources-unsupported">
                    Live updates unavailable on this gateway.
                  </Text>
                )}
                {snapshot.error && (
                  <>
                    <Text style={styles.error} accessibilityRole="alert">
                      {snapshot.error}
                    </Text>
                    <Pressable
                      testID="sources-read-retry"
                      style={styles.button}
                      onPress={() => void controller.refresh()}
                    >
                      <Text style={baseStyles.textPrimary}>Retry</Text>
                    </Pressable>
                  </>
                )}
                {snapshot.operationError && (
                  <Text
                    style={styles.error}
                    accessibilityRole="alert"
                    testID="sources-operation-error"
                  >
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
                {view?.errors.map((error, index) => (
                  <Text key={index} style={styles.error} testID="sources-status-error">
                    {error.nodeId ?? error.sourceId ?? error.project}: {error.reason}
                  </Text>
                ))}
                {view &&
                  snapshot.controls &&
                  view.rows.map((row) => (
                    <SourceRow
                      key={row.declaration.id}
                      row={row}
                      snapshot={snapshot}
                      controller={controller}
                    />
                  ))}
                {view && view.rows.length > 0 && (
                  <>
                    <Pressable
                      testID="sources-details-toggle"
                      accessibilityRole="button"
                      style={styles.button}
                      onPress={() => setDetails(!details)}
                    >
                      <Text style={baseStyles.textSecondary}>
                        {details ? 'Hide details' : 'Details'}
                      </Text>
                    </Pressable>
                    {details &&
                      view.rows.map((row) => (
                        <View key={row.declaration.id} style={styles.row}>
                          <Text style={styles.facts}>{row.summary}</Text>
                          {row.details.map((line, index) => (
                            <Text key={index} style={styles.facts}>
                              {line}
                            </Text>
                          ))}
                        </View>
                      ))}
                  </>
                )}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
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
