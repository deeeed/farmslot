import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  adjacentEvidenceReviewClaim,
  type EvidenceReviewModel,
  evidenceReviewToc,
  formatEvidenceReviewVideoTime,
} from '@farmslot/adapter-sdk/evidence';
import { acceptanceClaimLabel, type AcceptanceClaimRow } from '@farmslot/review-dispatch';

import { colors, fonts } from '../lib/theme';

import { AcceptanceClaimList } from './AcceptanceClaimList';

/** The run's criteria a recording's viewer can move between and judge. */
export interface EvidenceAcceptanceReview {
  rows: readonly AcceptanceClaimRow[];
  /** Records Looks right / Issue; absent while the run takes no verdicts. */
  record?: (id: string, verdict: 'confirmed' | 'rejected', reason?: string) => Promise<void>;
  /** The recorded evidence the rows and verdicts belong to (`useRunAcceptance().evidenceKey`). */
  evidenceKey: string | null;
  /** The run recorded newer evidence than the recording on screen: judge after reopening. */
  stale?: boolean;
}

/**
 * The recording's criteria over the player, opened by one tap: the current one with its
 * verdict controls, previous / next, and every criterion at the moment the recording reaches
 * it. The same table of contents Command Center's evidence review shows.
 */
export function EvidenceAcOverlay({
  model,
  videoPath,
  durationMs,
  review,
  maxListHeight,
  onChoose,
}: {
  model: EvidenceReviewModel;
  videoPath: string;
  durationMs: number;
  review: EvidenceAcceptanceReview;
  maxListHeight: number;
  /** Select the criterion and play from its moment (null: the recording misses it). */
  onChoose: (claimId: string, startMs: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const toc = useMemo(
    () => evidenceReviewToc(model, videoPath, { mediaDurationMs: durationMs || undefined }),
    [model, videoPath, durationMs],
  );
  if (!toc.length) return null;
  // Nothing selected (a step opened on its own): no current criterion, › starts at the first.
  const claimId = model.selection?.claimId;
  const row = claimId ? review.rows.find((candidate) => candidate.id === claimId) : undefined;
  const choose = (id: string | null) => {
    if (!id) return;
    onChoose(id, toc.find((entry) => entry.claim.id === id)?.startMs ?? null);
  };
  const previous = claimId ? adjacentEvidenceReviewClaim(toc, claimId, -1) : null;
  const next = claimId ? adjacentEvidenceReviewClaim(toc, claimId, 1) : (toc[0]?.claim.id ?? null);

  return (
    <View style={styles.wrap}>
      <Pressable
        testID="evidence-ac-toggle"
        accessibilityRole="button"
        accessibilityLabel={open ? 'Hide criteria' : 'Show criteria'}
        accessibilityState={{ expanded: open }}
        style={styles.pill}
        onPress={() => setOpen((value) => !value)}
      >
        <Text style={styles.pillText}>
          {open ? 'Hide ACs' : claimId ? `ACs · ${claimId}` : 'ACs'}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.panel} testID="evidence-ac-overlay">
          {review.stale ? (
            <Text style={styles.entryText} testID="evidence-ac-stale">
              Evidence changed · reopen to judge
            </Text>
          ) : null}
          <View style={styles.stepRow}>
            <Pressable
              testID="evidence-ac-previous"
              accessibilityRole="button"
              accessibilityLabel="Previous criterion"
              disabled={!previous}
              style={[styles.step, !previous && styles.stepDisabled]}
              onPress={() => choose(previous)}
            >
              <Text style={styles.stepText}>‹</Text>
            </Pressable>
            <View style={styles.current}>
              {row ? (
                <AcceptanceClaimList
                  rows={[row]}
                  onRecord={review.record}
                  canFocus={() => false}
                  testIDPrefix="evidence-ac-current"
                />
              ) : claimId ? (
                <Text style={styles.entryText}>{claimId}</Text>
              ) : null}
            </View>
            <Pressable
              testID="evidence-ac-next"
              accessibilityRole="button"
              accessibilityLabel="Next criterion"
              disabled={!next}
              style={[styles.step, !next && styles.stepDisabled]}
              onPress={() => choose(next)}
            >
              <Text style={styles.stepText}>›</Text>
            </Pressable>
          </View>
          <ScrollView nestedScrollEnabled style={{ maxHeight: maxListHeight }}>
            {toc.map(({ claim, startMs }) => {
              const match = review.rows.find((candidate) => candidate.id === claim.id);
              const state = match ? ` · ${acceptanceClaimLabel(match)}` : '';
              return (
                <Pressable
                  key={claim.id}
                  testID={`evidence-ac-${claim.id}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: claim.id === claimId }}
                  style={[styles.entry, claim.id === claimId && styles.entrySelected]}
                  onPress={() => choose(claim.id)}
                >
                  <Text style={styles.entryText} numberOfLines={1}>
                    {startMs === null ? '–' : formatEvidenceReviewVideoTime(startMs / 1000)} ·{' '}
                    {claim.id}
                    {state}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6, alignItems: 'flex-start' },
  pill: {
    minHeight: 32,
    paddingHorizontal: 12,
    justifyContent: 'center',
    borderRadius: 999,
    backgroundColor: 'rgba(18,18,26,0.82)',
  },
  pillText: { color: colors.textMuted, fontSize: fonts.sizeSm },
  panel: {
    alignSelf: 'stretch',
    gap: 6,
    padding: 8,
    borderRadius: 12,
    backgroundColor: 'rgba(18,18,26,0.92)',
  },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  step: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  stepDisabled: { opacity: 0.3 },
  stepText: { color: colors.textPrimary, fontSize: 24 },
  current: { flex: 1 },
  entry: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 8, borderRadius: 8 },
  entrySelected: { backgroundColor: 'rgba(255,255,255,0.08)' },
  entryText: { color: colors.textMuted, fontSize: fonts.sizeSm },
});
