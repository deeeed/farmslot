import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { RunListRow } from '@farmslot/protocol';

import { RunLinkedTickets } from '../../../components/RunLinkedTickets';
import { RunTitle } from '../../../components/RunTitle';
import { baseStyles, colors, spacing } from '../../../lib/theme';
import { formatDuration } from '../../workspace-shared/format';
import { type RunDetailHeaderModel, runDetailHeaderModel } from '../run-detail-header';
import { runDetailStyles as styles } from '../styles/run-detail.styles';

import { CockpitTile } from './run-detail-panels';

const STATUS_COLORS: Record<string, string> = {
  done: colors.statusOk,
  failed: colors.statusFail,
  cancelled: colors.statusWarn,
  monitoring: colors.lifecycleWorking,
  preparing: colors.lifecycleDispatching,
  dispatching: colors.lifecycleDispatching,
  'writing-task': colors.accent,
  grading: colors.accent,
  'slot-finding': colors.accent,
  paused: colors.statusWarn,
};

/** The status badge's colour: the status's own, else its lifecycle tone's. */
function headerStatusColor(header: RunDetailHeaderModel): string {
  return (
    STATUS_COLORS[header.status] ??
    {
      ok: colors.statusOk,
      fail: colors.statusFail,
      warn: colors.statusWarn,
      running: colors.lifecycleWorking,
      muted: colors.textMuted,
    }[header.tone]
  );
}

/**
 * Run Detail's header card: title lines with the ticket control, the terminal tile, the slot
 * line, then `children`. The same component renders it from the run.list row while run.get
 * loads and from the detail afterwards, so no element of it exists in only one state.
 */
export function RunDetailHeaderCard({
  row,
  ticketsDisabled,
  onSaveTickets,
  onOpenTerminal,
  children,
}: {
  row: RunListRow;
  ticketsDisabled: boolean;
  onSaveTickets?: (refs: string[]) => Promise<void>;
  onOpenTerminal: () => void;
  children?: ReactNode;
}) {
  const header = runDetailHeaderModel(row);
  return (
    <View style={styles.headerCard}>
      <RunDetailHeaderLines
        header={header}
        linkedTickets={
          // Keyed by run so its edit draft resets when the screen moves to another run.
          <RunLinkedTickets
            key={row.id}
            run={row}
            disabled={ticketsDisabled}
            onSave={onSaveTickets}
          />
        }
      />
      <RunDetailTerminalTile header={header} onPress={onOpenTerminal} />
      <RunDetailSlotLine header={header} />
      {children}
    </View>
  );
}

/** The header's first lines: flow, status, ref, linked tickets and title, from row or detail. */
function RunDetailHeaderLines({
  header,
  linkedTickets,
}: {
  header: RunDetailHeaderModel;
  linkedTickets: ReactNode;
}) {
  const statusColor = headerStatusColor(header);
  return (
    <>
      <View style={styles.row}>
        <View style={[styles.flowBadge, { backgroundColor: colors.accent + '30' }]}>
          <Text style={[styles.flowText, { color: colors.accent }]}>{header.flowType}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: statusColor + '30' }]}>
          <Text style={[styles.statusText, { color: statusColor }]} numberOfLines={1}>
            {header.statusLabel}
          </Text>
        </View>
      </View>
      <Text style={styles.ticketText}>{header.ticketOrPr}</Text>
      {linkedTickets}
      {header.summary ? <RunTitle style={baseStyles.textSecondary} title={header.summary} /> : null}
    </>
  );
}

/** The terminal tile and QA profile line, between the title and the slot line. */
function RunDetailTerminalTile({
  header,
  onPress,
}: {
  header: RunDetailHeaderModel;
  onPress: () => void;
}) {
  return (
    <>
      <CockpitTile
        testID="companion-run-open-terminal"
        label={header.terminalLabel}
        value={header.terminalValue}
        disabled={header.terminalDisabled}
        onPress={onPress}
      />
      {header.qaProfile ? (
        <Text style={baseStyles.textSecondary} testID="companion-run-qa-profile">
          QA profile: {header.qaProfile}
        </Text>
      ) : null}
    </>
  );
}

/** The header's slot and duration line. */
function RunDetailSlotLine({ header }: { header: RunDetailHeaderModel }) {
  return (
    <View style={[styles.row, { marginTop: spacing.lg }]}>
      {header.slotId && (
        <Text style={baseStyles.textMuted} testID="companion-run-detail-slot">
          Slot: {header.slotId}
          {/*
            `isSlotFreedByPark` ignores `phase`, and cancel skips slot
            release for a park-freed run, so this marker outlives the run.
            On a terminal run the release is still a fact but no restore
            is coming, and the wording must not imply one.
          */}
          {header.slotFreedByPark
            ? header.terminal
              ? ' (released to dispatch; no restore pending)'
              : ' (freed for dispatch)'
            : ''}
        </Text>
      )}
      <Text style={baseStyles.textMuted}>{formatDuration(header.durationMs)}</Text>
    </View>
  );
}
