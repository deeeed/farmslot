import React from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type {
  EvidenceReviewArtifact,
  EvidenceReviewJudgmentRow,
  EvidenceReviewModel,
} from '@farmslot/adapter-sdk/evidence';
import type {
  AcceptanceCriterionRef,
  AcceptanceEvidenceLink,
  AcceptanceRegistration,
  AcceptanceStatusLedger,
} from '@farmslot/protocol';
import { acceptanceClaimRows, untestableOverrideView } from '@farmslot/review-dispatch';

import { acceptanceLedgerView } from '../lib/task-progress-view';
import { baseStyles, colors, fonts, radii, spacing } from '../lib/theme';

import { AcceptanceClaimList } from './AcceptanceClaimList';
import { ReasonSheet } from './ReasonSheet';
import { Skeleton, SkeletonError } from './Skeleton';

interface TaskAcceptancePanelProps {
  acceptanceRegistration?: AcceptanceRegistration;
  loading?: boolean;
  expectedRows?: number;
  onRetry?: () => void;
  judgmentRows?: readonly EvidenceReviewJudgmentRow[];
  onRecordVisualReview?: (
    id: string,
    verdict: 'confirmed' | 'rejected',
    reason?: string,
  ) => Promise<void>;
  onMarkUntestable?: (id: string, reason: string) => void;
  evidenceModel?: EvidenceReviewModel | null;
  showOccurrences?: boolean;
  onOpenOccurrence?: (traceIndex: number) => void;
  acceptanceStatus: AcceptanceStatusLedger | null;
  /** Registered criteria, so one awaiting a verdict still gets a row. */
  acceptanceCriteria?: AcceptanceCriterionRef[] | null;
  /** Manifest-linked evidence for criteria with no recorded verdict. */
  acceptanceEvidenceLinks?: AcceptanceEvidenceLink[] | null;
  /** Why the ledger could not be read; shown instead of an empty panel. */
  error?: string | null;
  onOpenEvidence?: (criterionId: string, path: string) => void;
}

/**
 * The run's acceptance ledger (ADR-060), read-only and compact: the assessed and
 * proven counts always visible, the per-criterion rows collapsed until tapped so a
 * long criteria list does not push the checklist off a phone screen.
 *
 * With `onOpenEvidence`, each evidence file opens in the artifact viewer. Verdicts
 * are the worker's claim, rendered as recorded.
 */
export function TaskAcceptancePanel({
  loading = false,
  expectedRows,
  ...props
}: TaskAcceptancePanelProps) {
  return loading ? (
    <TaskAcceptanceSkeleton rows={expectedRows} />
  ) : (
    <TaskAcceptanceContent {...props} />
  );
}

function TaskAcceptanceContent({
  acceptanceRegistration,
  acceptanceStatus,
  acceptanceCriteria,
  acceptanceEvidenceLinks,
  error,
  onOpenEvidence,
  evidenceModel,
  showOccurrences,
  onOpenOccurrence,
  onMarkUntestable,
  judgmentRows,
  onRecordVisualReview,
  onRetry,
}: TaskAcceptancePanelProps) {
  const ledger = acceptanceStatus ?? { schemaVersion: 1 as const, criteria: [] };
  const view = acceptanceLedgerView(
    ledger,
    acceptanceCriteria ?? ledger.criteria,
    acceptanceEvidenceLinks ?? [],
    evidenceModel ?? undefined,
    acceptanceRegistration,
  );
  const [showDetails, setShowDetails] = React.useState(false);
  const [showExclusions, setShowExclusions] = React.useState(false);
  const [showWarnings, setShowWarnings] = React.useState(false);
  const [overrideClaim, setOverrideClaim] = React.useState<string | null>(null);
  const [overrideReason, setOverrideReason] = React.useState('');
  const [rawClaims, setRawClaims] = React.useState<ReadonlySet<string>>(() => new Set());
  React.useEffect(() => setRawClaims(new Set()), [evidenceModel]);
  const renderFiles = (id: string, files: readonly EvidenceReviewArtifact[]) => (
    <View style={styles.evidenceList}>
      {files.map((entry) =>
        onOpenEvidence ? (
          <Pressable
            key={entry.artifactPath}
            accessibilityRole="button"
            accessibilityLabel={`Open ${entry.name} evidence for ${id}`}
            testID={`companion-ac-evidence-${id}-${view.rows.find((row) => row.criterion.id === id)?.evidence.findIndex((file) => file.path === entry.artifactPath)}`}
            onPress={() => onOpenEvidence(id, entry.artifactPath)}
            style={({ pressed }) => [styles.evidenceChip, pressed && styles.pressed]}
          >
            <Text style={styles.evidence} numberOfLines={1}>
              {entry.name} ›
            </Text>
          </Pressable>
        ) : (
          <Text key={entry.artifactPath} style={styles.evidence}>
            {entry.name}
          </Text>
        ),
      )}
    </View>
  );
  React.useEffect(() => {
    setShowDetails(false);
    setShowWarnings(false);
  }, [evidenceModel]);
  const packageStatus = evidenceModel?.packageStatus;
  const [expanded, setExpanded] = React.useState(view.defaultOpen || Boolean(error));
  React.useEffect(() => {
    if (
      error ||
      evidenceModel?.errors.length ||
      evidenceModel?.claims.some((claim) => claim.kind === 'qa-case')
    )
      setExpanded(true);
  }, [error, evidenceModel]);
  // Opens once when the first criterion is assessed; a later refresh keeps the user's choice.
  React.useEffect(() => {
    if (view.defaultOpen) setExpanded(true);
  }, [view.defaultOpen]);
  if (
    view.rows.length === 0 &&
    !acceptanceRegistration &&
    !error &&
    !packageStatus &&
    !evidenceModel?.occurrences.length
  )
    return null;
  return (
    <View style={styles.panel} testID="companion-ac-panel">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Acceptance criteria: ${view.counts}; ${view.countsLabel}`}
        onPress={() => setExpanded((previous) => !previous)}
        style={styles.header}
      >
        <Text style={styles.caret}>{expanded ? '▾' : '▸'}</Text>
        <Text style={styles.title} numberOfLines={1}>
          Acceptance criteria
        </Text>
        <Text
          testID="companion-ac-panel-counts"
          style={[styles.counts, { color: view.countsColor }]}
        >
          {view.counts}
        </Text>
      </Pressable>
      {expanded && error ? <SkeletonError message={error} retry={onRetry} /> : null}
      {expanded
        ? view.registration?.pending.map((message, index) => (
            <Text
              key={index}
              testID="companion-acceptance-registration-pending"
              style={baseStyles.textMuted}
            >
              {message}
            </Text>
          ))
        : null}
      {expanded && view.registration?.exclusions.length ? (
        <View>
          <Pressable
            onPress={() => setShowExclusions((shown) => !shown)}
            accessibilityRole="button"
            style={styles.row}
          >
            <Text>Excluded sources ({view.registration.exclusions.length})</Text>
          </Pressable>
          {showExclusions
            ? view.registration.exclusions.map((source) => (
                <View key={source.sourceId}>
                  <Pressable
                    style={{ minHeight: 44, justifyContent: 'center' }}
                    disabled={!source.url}
                    accessibilityRole="link"
                    onPress={() => {
                      if (source.url)
                        void Linking.openURL(source.url).catch((error: Error) =>
                          Alert.alert('Cannot open source', error.message),
                        );
                    }}
                  >
                    <Text>{source.label}</Text>
                  </Pressable>
                  <Text>{source.reason}</Text>
                </View>
              ))
            : null}
        </View>
      ) : null}
      {expanded && packageStatus ? (
        <View testID="companion-evidence-package-status" style={styles.row}>
          <View style={styles.rowHeader}>
            <Text
              style={[
                styles.pill,
                {
                  color:
                    packageStatus.tone === 'error'
                      ? colors.statusFail
                      : packageStatus.status === 'Valid'
                        ? colors.statusOk
                        : colors.textSecondary,
                },
              ]}
            >
              {packageStatus.status}
            </Text>
            <Text style={baseStyles.textMuted}>{packageStatus.path}</Text>
          </View>
          <Text style={packageStatus.tone === 'error' ? styles.error : styles.text}>
            {packageStatus.summary}
          </Text>
          {packageStatus.action ? <Text style={styles.error}>{packageStatus.action}</Text> : null}
          {packageStatus.issues.length ? (
            <Pressable
              accessibilityRole="button"
              testID="companion-evidence-package-details"
              onPress={() => setShowDetails((value) => !value)}
            >
              <Text style={styles.evidence}>
                {showDetails ? 'Hide' : 'Show'} details ({packageStatus.issues.length} issues)
              </Text>
            </Pressable>
          ) : null}
          {showDetails
            ? packageStatus.issues.map((issue) => (
                <Text
                  key={issue.message}
                  style={packageStatus.tone === 'error' ? styles.error : styles.text}
                >
                  {issue.message} ({issue.count} messages)
                </Text>
              ))
            : null}
        </View>
      ) : null}
      {expanded && evidenceModel?.displayWarnings.length ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showWarnings }}
            testID="companion-acceptance-warning-details"
            onPress={() => setShowWarnings((value) => !value)}
            style={{ minHeight: 44, minWidth: 44, justifyContent: 'center' }}
          >
            <Text style={styles.evidence}>
              Evidence details ({evidenceModel.displayWarnings.length})
            </Text>
          </Pressable>
          {showWarnings
            ? evidenceModel.displayWarnings.map((warning) => (
                <Text key={warning} style={baseStyles.textMuted}>
                  {warning}
                </Text>
              ))
            : null}
        </View>
      ) : null}
      {expanded ? (
        <AcceptanceClaimList
          rows={acceptanceClaimRows({
            criteria: acceptanceCriteria ?? undefined,
            ledger,
            registration: acceptanceRegistration,
            claims: view.rows.map(({ review, criterion }) => review ?? criterion),
            judgmentRows: judgmentRows ?? evidenceModel?.judgmentRows(null),
            pendingVisualClaimIds: evidenceModel?.pendingVisualClaimIds,
          })}
          onRecord={onRecordVisualReview}
          onFocus={
            onOpenEvidence
              ? (id) => {
                  const path = view.model.claimFocusPath(id);
                  if (path) onOpenEvidence(id, path);
                }
              : undefined
          }
          canFocus={(id) => Boolean(view.model.claimFocusPath(id))}
          hasDetails={(id) =>
            view.model.claimHasDetails(id, {
              playable: Boolean(onOpenEvidence),
              overridable: Boolean(onMarkUntestable),
            })
          }
          renderDetails={(id) => {
            const row = view.rows.find(({ criterion }) => criterion.id === id);
            if (!row) return null;
            const { criterion, display, review } = row;
            return (
              <View style={styles.details}>
                {criterion.status?.engineVerdict ? (
                  <Text style={baseStyles.textMuted}>
                    Engine verdict: {criterion.status.engineVerdict} · {criterion.status.note}
                  </Text>
                ) : null}
                {onMarkUntestable && evidenceModel?.claimOverrideCandidate(criterion.id) ? (
                  <SkipCriterion
                    claimId={criterion.id}
                    open={overrideClaim === criterion.id}
                    reason={overrideReason}
                    onOpen={() => {
                      setOverrideClaim(criterion.id);
                      setOverrideReason('');
                    }}
                    onChange={setOverrideReason}
                    onCancel={() => setOverrideClaim(null)}
                    onConfirm={() => onMarkUntestable(criterion.id, overrideReason)}
                  />
                ) : null}
                {review?.timing && review?.timing !== 'measured' ? (
                  <Text style={baseStyles.textMuted}>{review?.timing}</Text>
                ) : null}
                {display.clip && evidenceModel && !evidenceModel.errors.length && onOpenEvidence ? (
                  <Pressable
                    accessibilityRole="button"
                    style={styles.touchAction}
                    testID={`companion-ac-clip-${criterion.id}`}
                    onPress={() => {
                      const selected = evidenceModel.selectClaim(criterion.id);
                      const path = selected?.clips[0]?.videoPath;
                      if (path) onOpenEvidence(criterion.id, evidenceModel.artifactPath(path));
                    }}
                  >
                    <Text style={styles.evidence}>Play proof</Text>
                  </Pressable>
                ) : null}
                {renderFiles(criterion.id, display.selected)}
                {display.raw.length ||
                review?.occurrences.length ||
                criterion.status?.recipeNodes.length ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: rawClaims.has(criterion.id) }}
                    style={styles.touchAction}
                    testID={`companion-ac-raw-${criterion.id}`}
                    onPress={() =>
                      setRawClaims((previous) => {
                        const next = new Set(previous);
                        if (next.has(criterion.id)) next.delete(criterion.id);
                        else next.add(criterion.id);
                        return next;
                      })
                    }
                  >
                    <Text style={styles.evidence}>
                      {rawClaims.has(criterion.id) ? 'Hide ' : ''}
                      {display.raw.length
                        ? `raw artifacts (${display.raw.length})`
                        : 'Check details'}
                    </Text>
                  </Pressable>
                ) : null}
                {rawClaims.has(criterion.id) ? (
                  <View>
                    {criterion.status?.recipeNodes.map((node) => (
                      <Text key={node} style={baseStyles.textMuted}>
                        {node}
                      </Text>
                    ))}
                    {review?.occurrences.map((occurrence) => (
                      <View key={occurrence.traceIndex}>
                        <Text style={styles.text}>{occurrence.intent}</Text>
                        {occurrence.expectation ? (
                          <Text style={baseStyles.textMuted}>
                            {JSON.stringify(occurrence.expectation)}
                          </Text>
                        ) : null}
                      </View>
                    ))}
                    {renderFiles(criterion.id, display.raw)}
                  </View>
                ) : null}
                {criterion.status?.note ? (
                  <Text style={baseStyles.textMuted}>{criterion.status.note}</Text>
                ) : null}
              </View>
            );
          }}
        />
      ) : null}
      {expanded && showOccurrences
        ? evidenceModel?.occurrences.map((occurrence) => (
            <Pressable
              key={occurrence.traceIndex}
              accessibilityRole="button"
              testID={`companion-proof-step-${occurrence.traceIndex}`}
              onPress={() => onOpenOccurrence?.(occurrence.traceIndex)}
            >
              <Text style={styles.evidence}>
                {occurrence.nodeId}: {occurrence.intent} · {occurrence.ok ? 'pass' : 'fail'}
              </Text>
            </Pressable>
          ))
        : null}
    </View>
  );
}

/** Skip a criterion: one action, then the shared reason sheet (the untestable override). */
function SkipCriterion(props: {
  claimId: string;
  open: boolean;
  reason: string;
  onOpen: () => void;
  onChange: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const view = untestableOverrideView(props.claimId, props.open ? props.reason : '');
  if (!props.open)
    return (
      <Pressable
        accessibilityRole="button"
        testID="companion-claim-override-open"
        style={styles.skipAction}
        onPress={props.onOpen}
      >
        <Text style={styles.skipLabel}>{view.action}</Text>
      </Pressable>
    );
  return (
    <ReasonSheet
      title={view.title}
      hint={view.hint}
      label={view.reasonLabel}
      placeholder={view.placeholder}
      value={props.reason}
      confirmLabel={view.confirm}
      cancelLabel={view.cancel}
      canConfirm={view.canConfirm}
      testID="companion-claim-override"
      onChange={props.onChange}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    />
  );
}

const styles = StyleSheet.create({
  panel: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.bgCardHover,
    backgroundColor: colors.bgSurface,
    gap: spacing.xs,
  },
  header: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  caret: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },
  counts: {
    fontSize: fonts.sizeXs,
    fontFamily: fonts.mono,
    fontWeight: '700',
  },
  details: {
    backgroundColor: colors.bgSurface,
    padding: spacing.sm,
  },
  touchAction: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
  },
  skipAction: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderRadius: radii.md,
    borderColor: colors.bgCardHover,
    backgroundColor: colors.bgSurface,
  },
  skipLabel: {
    color: colors.textPrimary,
    fontWeight: '600',
  },
  row: {
    gap: 2,
    paddingTop: spacing.xs,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  pill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    fontSize: fonts.sizeXs,
    fontWeight: '700',
  },
  text: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
  },
  error: {
    color: colors.statusFail,
    fontSize: fonts.sizeXs,
    fontFamily: fonts.mono,
  },
  evidence: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontFamily: fonts.mono,
  },
  evidenceList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  evidenceChip: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    maxWidth: '100%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.accent + '66',
  },
  pressed: {
    opacity: 0.6,
  },
});

export function TaskAcceptanceSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <View
      style={styles.panel}
      accessibilityLabel="Acceptance criteria"
      accessibilityState={{ busy: true }}
    >
      <View style={[styles.header, { minHeight: 44 }]}>
        <Skeleton width="48%" />
        <Skeleton width="24%" />
      </View>
      <View style={{ padding: 12, gap: 12 }}>
        {Array.from({ length: rows }, (_, index) => (
          <View key={index} style={{ minHeight: 56, gap: 8 }}>
            <Skeleton width="85%" />
            <Skeleton width="55%" />
          </View>
        ))}
      </View>
    </View>
  );
}

/** Keep evidence below the AC details fixed even when the loaded ledger collapses. */
export function acceptancePanelViewportHeight(
  rows: number | undefined,
  viewportHeight: number,
): number {
  const maximum = viewportHeight * 0.4;
  return rows === undefined ? maximum : Math.min(44 + Math.max(0, rows) * 56, maximum);
}
