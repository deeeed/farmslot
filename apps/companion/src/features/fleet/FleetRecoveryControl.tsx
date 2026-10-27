import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { SlotStatus } from '@farmslot/protocol';
import { fleetRecoverySummary, fleetWorkspaceRow } from '@farmslot/review-dispatch';

import { colors, spacing } from '../../lib/theme';

import { useFleetRefreshController } from './use-fleet-refresh-controller';

export function FleetRecoveryControl({
  slot,
  slots,
}: {
  slot?: SlotStatus;
  slots?: readonly SlotStatus[];
}) {
  const model = useFleetRefreshController();
  const [open, setOpen] = useState(false);
  const row = slot ? fleetWorkspaceRow(slot) : null;
  const summary = fleetRecoverySummary(slots ?? []);
  const count = summary.count;
  const disabled =
    !model ||
    (row ? !row.eligibility.allowed && row.eligibility.reason !== 'unknown' : !summary.canInspect);
  const launch = async () => {
    if (!model) return;
    setOpen(true);
    await model.load(
      slot ? [slot.slot] : (slots ?? []).map((value) => value.slot),
      slot ? [slot] : slots,
    );
    if (slot && row?.action !== 'Inspect workspace') await model.release(slot.slot);
  };
  const running = model?.phase === 'running';
  return (
    <View>
      {row ? (
        <Text style={styles.meta}>
          {row.branch} · {row.publication} · {row.owner}
          {'\n'}
          {row.behind}
          {'\n'}
          {row.referenceTime}
        </Text>
      ) : null}
      <Pressable
        testID={slot ? `fleet-release-${slot.slot}` : 'fleet-release-idle'}
        accessibilityRole="button"
        disabled={disabled}
        style={[styles.button, disabled && styles.disabled]}
        onPress={(event) => {
          event.stopPropagation();
          void launch();
        }}
      >
        <Text style={styles.text}>
          {row?.action ?? (count ? `Release idle slots (${count})` : 'Inspect idle slots')}
        </Text>
      </Pressable>
      <Modal visible={open} onRequestClose={() => setOpen(false)} transparent animationType="fade">
        <View style={styles.overlay}>
          <View style={styles.dialog}>
            <View style={styles.header}>
              <Text style={styles.title}>Release and update to main</Text>
              <Pressable
                testID="fleet-recovery-close"
                accessibilityRole="button"
                style={styles.button}
                onPress={() => setOpen(false)}
              >
                <Text style={styles.text}>Close</Text>
              </Pressable>
            </View>
            <ScrollView>
              {model?.error ? (
                <Text accessibilityRole="alert" style={styles.warning}>
                  {model.error}
                </Text>
              ) : null}
              {model?.inspecting ? (
                <Text style={styles.text}>Checking current workspaces…</Text>
              ) : null}
              {model?.confirmation ? (
                <View style={styles.confirm}>
                  <Text style={styles.warning}>{model.confirmation.warning}</Text>
                  <Pressable
                    accessibilityRole="button"
                    style={styles.button}
                    onPress={() => model.cancelConfirmation()}
                  >
                    <Text style={styles.text}>Keep work</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    style={styles.button}
                    onPress={() => void model.confirmDiscard()}
                  >
                    <Text style={styles.warning}>Discard local work and update</Text>
                  </Pressable>
                </View>
              ) : null}
              {model?.rows.map((item) => (
                <View key={item.slotId} style={styles.row}>
                  <Text style={styles.title}>{item.slotId}</Text>
                  <Text style={styles.meta}>
                    {item.branch} · {item.publication} · {item.owner}
                    {'\n'}
                    {item.behind}
                    {'\n'}
                    {item.referenceTime}
                  </Text>
                  {item.warning ? <Text style={styles.warning}>{item.warning}</Text> : null}
                  {item.status !== 'idle' ? (
                    <Text accessibilityLiveRegion="polite" style={styles.text}>
                      {item.status} {item.detail}
                    </Text>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    style={styles.button}
                    disabled={
                      !model.canRelease ||
                      running ||
                      item.status === 'refreshed' ||
                      (!item.eligibility.allowed && item.eligibility.reason !== 'unknown')
                    }
                    onPress={() => void model.release(item.slotId)}
                  >
                    <Text style={styles.text}>{item.action}</Text>
                  </Pressable>
                  {item.log.length ? (
                    <Text style={styles.meta}>{item.log.slice(-2).join('\n')}</Text>
                  ) : null}
                </View>
              ))}
            </ScrollView>
            {!slot ? (
              <Pressable
                accessibilityRole="button"
                disabled={!model?.canRelease || running || !model?.bulkCount}
                style={styles.button}
                onPress={() => void model?.releaseIdle()}
              >
                <Text style={styles.text}>Release idle slots ({model?.bulkCount ?? 0})</Text>
              </Pressable>
            ) : null}
            {model?.canCancel ? (
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() => void model?.cancel()}
              >
                <Text style={styles.text}>Cancel remaining</Text>
              </Pressable>
            ) : running ? (
              <Text style={styles.text}>Updating...</Text>
            ) : (
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() => void model?.load(model.rows.map((item) => item.slotId))}
              >
                <Text style={styles.text}>Inspect again</Text>
              </Pressable>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: '#000a', justifyContent: 'center', padding: spacing.lg },
  dialog: {
    backgroundColor: colors.bgSurface,
    borderRadius: 12,
    padding: spacing.lg,
    maxHeight: '90%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  row: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.bgCard },
  title: { color: colors.textPrimary, fontWeight: '600', fontSize: 16, flexShrink: 1 },
  text: { color: colors.textPrimary },
  meta: { color: colors.textSecondary, marginVertical: 6 },
  warning: { color: colors.statusWarn, marginVertical: 6 },
  button: {
    minHeight: 44,
    justifyContent: 'center',
    padding: spacing.md,
    backgroundColor: colors.bgCard,
    borderRadius: 8,
    marginVertical: 4,
  },
  disabled: { opacity: 0.45 },
  confirm: { borderWidth: 1, borderColor: colors.statusWarn, padding: spacing.md, borderRadius: 8 },
});
