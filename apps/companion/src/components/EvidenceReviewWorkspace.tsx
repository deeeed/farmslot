import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import type {
  EvidenceReviewComparisonFilter,
  EvidenceReviewModel,
} from '@farmslot/adapter-sdk/evidence';
import { type SelfPrincipalSummary } from '@farmslot/protocol';
import { acceptanceClaimLabel, acceptanceClaimRows } from '@farmslot/review-dispatch';

import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  artifactUrlForEntry,
  classifyArtifact,
  formatBytes,
  formatVisualArtifactPairLabel,
  type VisualArtifactPair,
} from '../lib/artifact-url';
import {
  type ArtifactWorkspaceFilter,
  buildArtifactWorkspaceCounts,
  filterArtifactWorkspace,
} from '../lib/artifact-workspace';
import { diffArtifactCandidate } from '../lib/diff';
import { recordedEvidenceArtifactUrl } from '../lib/evidence-media-items';
import { colors, fonts, radii, spacing } from '../lib/theme';

import { ArtifactImage } from './ArtifactImage';
import { BeforeAfterPreview, CompareMedia } from './BeforeAfterPreview';
import { EvidenceReviewSkeleton } from './EvidenceReviewSkeleton';
import { SkeletonError } from './Skeleton';
import { VisualClaimJudgment } from './VisualClaimJudgment';

interface EvidenceReviewWorkspaceProps {
  loading?: boolean;
  error?: string | null;
  retry?: () => void;
  runId: string;
  gatewayUrl: string;
  artifacts: ArtifactManifestEntry[];
  pairs: VisualArtifactPair[];
  evidenceModel?: EvidenceReviewModel | null;
  reviewer?: SelfPrincipalSummary | null;
  onRecordVisualReview?(
    claimId: string,
    verdict: 'confirmed' | 'rejected',
    reason?: string,
  ): Promise<void>;
  onFocusClaim?(offset: number): void;
  focusClaim?: { claimId: string };
  onOpenRecordedEvidence?(model: EvidenceReviewModel, path: string): void;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: ArtifactManifestEntry) => void;
  onOpenDiff?: (path: string) => void;
  onOpenArtifactWorkspace?: (artifact: ArtifactManifestEntry) => void;
  onOpenCompareArtifactWorkspace?: (artifact: ArtifactManifestEntry) => void;
  authHeaders?: ArtifactHttpHeaders;
}

type ReviewArtifact = ArtifactManifestEntry & { url: string };

interface ComparisonLayouts {
  workspace: number;
  rail: number;
  rows: Record<string, number>;
  pending?: string;
}

const EVIDENCE_FILTERS: Array<{ id: ArtifactWorkspaceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'visual', label: 'Visual' },
  { id: 'before', label: 'Before' },
  { id: 'after', label: 'After' },
  { id: 'review', label: 'Review' },
  { id: 'diffs', label: 'Diff' },
  { id: 'recipes', label: 'Recipe' },
  { id: 'supporting', label: 'Setup' },
];

export function EvidenceReviewWorkspace({
  runId,
  gatewayUrl,
  artifacts,
  pairs,
  evidenceModel,
  reviewer,
  onRecordVisualReview,
  onFocusClaim,
  focusClaim,
  onOpenRecordedEvidence,
  onOpenVisual,
  onOpenDocument,
  onOpenDiff,
  onOpenArtifactWorkspace,
  onOpenCompareArtifactWorkspace,
  authHeaders,
  loading,
  error,
  retry,
}: EvidenceReviewWorkspaceProps) {
  const viewport = useWindowDimensions();
  const open = (path: string) =>
    evidenceModel && onOpenRecordedEvidence
      ? onOpenRecordedEvidence(evidenceModel, path)
      : onOpenVisual(
          evidenceModel
            ? recordedEvidenceArtifactUrl(gatewayUrl, runId, evidenceModel, path)
            : artifactUrlForEntry(gatewayUrl, runId, { path, purpose: 'evidence' }),
        );
  const [, refreshComparisons] = useState(0);
  const workspaceScroll = useRef<ScrollViewInstance>(null);
  const layouts = useRef<ComparisonLayouts>({ workspace: 0, rail: 0, rows: {} });
  const focusRow = (offset: number) => {
    workspaceScroll.current?.scrollTo({ y: offset, animated: true });
    onFocusClaim?.(layouts.current.workspace);
  };
  const [evidenceFilter, setEvidenceFilter] = useState<ArtifactWorkspaceFilter>('all');
  const [showRawArtifacts, setShowRawArtifacts] = useState(false);
  useEffect(() => setShowRawArtifacts(false), [runId]);
  const artifactCounts = useMemo(() => buildArtifactWorkspaceCounts(artifacts), [artifacts]);
  const filteredArtifacts = useMemo(
    () => filterArtifactWorkspace(artifacts, evidenceFilter, '', evidenceModel),
    [artifacts, evidenceFilter, evidenceModel],
  );
  const reviewArtifacts = sortReviewArtifacts(
    evidenceModel ? [...evidenceModel.rawArtifacts(filteredArtifacts)] : filteredArtifacts,
  ).map((artifact) => ({
    ...artifact,
    url: recordedEvidenceArtifactUrl(gatewayUrl, runId, evidenceModel, artifact),
  }));
  const evidenceSummary = useMemo(
    () => summarizeEvidenceCompleteness(artifacts, pairs.length),
    [artifacts, pairs.length],
  );
  const packageDiffArtifactPath = useMemo(
    () => diffArtifactCandidate(artifacts)?.path ?? null,
    [artifacts],
  );
  const visibleEvidenceFilters = useMemo(
    () => EVIDENCE_FILTERS.filter((filter) => filter.id === 'all' || artifactCounts[filter.id] > 0),
    [artifactCounts],
  );

  useEffect(() => {
    if (evidenceFilter !== 'all' && artifactCounts[evidenceFilter] === 0) {
      setEvidenceFilter('all');
    }
  }, [artifactCounts, evidenceFilter]);
  const compareIdentity = useMemo(
    () => pairs.map((pair) => `${pair.before.url}:${pair.after.url}`).join('|'),
    [pairs],
  );
  const [compareIndex, setCompareIndex] = useState(0);

  useEffect(() => {
    setCompareIndex(0);
  }, [compareIdentity]);

  useEffect(() => {
    if (!focusClaim || !evidenceModel) return;
    const id = focusClaim.claimId;
    const offset = layouts.current.rows[id];
    if (evidenceModel.comparisonFilter === 'all' && typeof offset === 'number')
      focusRow(layouts.current.rail + offset);
    else {
      layouts.current.pending = id;
      evidenceModel.setComparisonFilter('all');
      refreshComparisons((value) => value + 1);
    }
  }, [focusClaim, evidenceModel]);

  if (loading && !artifacts.length) return <EvidenceReviewSkeleton />;
  return (
    <ScrollView
      ref={workspaceScroll}
      nestedScrollEnabled
      style={{ height: Math.min(640, viewport.height * 0.65) }}
      contentContainerStyle={styles.workspace}
      onLayout={(event) => {
        layouts.current.workspace = event.nativeEvent.layout.y;
      }}
    >
      {error ? <SkeletonError message={error} retry={retry} /> : null}
      {evidenceModel ? (
        <View
          style={styles.railSection}
          onLayout={(event) => {
            layouts.current.rail = event.nativeEvent.layout.y;
          }}
        >
          <Text style={styles.railTitle}>Compare by AC</Text>
          {evidenceModel.gateSnapshot ? (
            <View style={styles.largeCard}>
              <Text style={styles.railSubtitle}>
                Review head {evidenceModel.gateSnapshot.headSha ?? 'not captured'}
              </Text>
              <Text style={styles.railSubtitle}>
                {evidenceModel.gateSnapshot.reviewRequirement.label}
              </Text>
              <Text style={styles.railSubtitle}>
                Own review: {evidenceModel.gateSnapshot.ownReviewVerdict ?? 'not captured'}
              </Text>
              {evidenceModel.gateSnapshot.reviews.map((review) => (
                <Text key={review.id} style={styles.railSubtitle}>
                  Review history: {review.mode} · {review.verdict} · head{' '}
                  {review.reviewedHeadSha ?? review.reviewSnapshot?.headSha ?? 'not captured'}
                  {review.stale ? ' · stale' : ''}
                </Text>
              ))}
              <Text style={styles.railSubtitle}>
                CI parity{' '}
                {evidenceModel.gateSnapshot.ci.length
                  ? evidenceModel.gateSnapshot.ci
                      .map((check) => `${check.reference}: ${check.status}`)
                      .join('; ')
                  : 'not captured for this head'}
              </Text>
              {evidenceModel.gateSnapshot.requirements.map((reason, index) => (
                <Text key={index} style={styles.railSubtitle}>
                  {reason.message}
                </Text>
              ))}
              <Text style={styles.railSubtitle}>
                CI:{' '}
                {evidenceModel.gateSnapshot.ciChecks.length
                  ? evidenceModel.gateSnapshot.ciChecks
                      .map((check) => `${check.name}: ${check.conclusion ?? check.status}`)
                      .join('; ')
                  : 'not captured for this head'}
              </Text>
              <Text style={styles.railTitle}>
                Next action: {evidenceModel.gateSnapshot.nextAction}
              </Text>
            </View>
          ) : null}
          <View style={styles.evidenceFilterWrap}>
            {(
              [
                'all',
                'before',
                'after',
                'review',
                'screenshots',
                'moments',
                'unassigned',
              ] satisfies EvidenceReviewComparisonFilter[]
            ).map((filter) => (
              <Pressable
                key={filter}
                testID={`companion-evidence-filter-${filter}`}
                style={styles.evidenceFilterChip}
                accessibilityState={{ selected: evidenceModel.comparisonFilter === filter }}
                onPress={() => {
                  evidenceModel.setComparisonFilter(filter);
                  refreshComparisons((value) => value + 1);
                }}
              >
                <Text style={styles.evidenceFilterText}>
                  {filter === 'moments' ? 'Video moments' : filter}
                </Text>
              </Pressable>
            ))}
          </View>
          {evidenceModel.comparisonView.rows.map((row) => {
            const primaryClip = row.primaryClip;
            const convert = (media: NonNullable<typeof row.selectedBefore>) => ({
              ...media,
              type: media.mediaType,
              purpose: media.capture?.role ?? 'evidence',
              url: recordedEvidenceArtifactUrl(
                gatewayUrl,
                runId,
                evidenceModel,
                media.artifactPath,
              ),
              path: media.artifactPath,
            });
            const before =
              row.selectedBefore &&
              row.before.some((media) => media.identity === row.selectedBefore?.identity)
                ? convert(row.selectedBefore)
                : undefined;
            const after =
              row.selectedAfter &&
              row.after.some((media) => media.identity === row.selectedAfter?.identity)
                ? convert(row.selectedAfter)
                : undefined;
            return (
              <View
                key={row.claim.id}
                style={styles.largeCard}
                onLayout={(event) => {
                  layouts.current.rows[row.claim.id] = event.nativeEvent.layout.y;
                  if (layouts.current.pending === row.claim.id) {
                    layouts.current.pending = undefined;
                    focusRow(layouts.current.rail + event.nativeEvent.layout.y);
                  }
                }}
              >
                <Text style={styles.railTitle}>
                  {row.claim.id}: {row.claim.text}
                </Text>
                {row.primaryFiles.map((file, index) => (
                  <Pressable
                    key={file.artifactPath}
                    testID={`companion-selected-proof-file-${row.claim.id}-${index}`}
                    onPress={() => {
                      evidenceModel.selectClaim(row.claim.id, file.artifactPath);
                      open(file.artifactPath);
                    }}
                  >
                    <Text style={styles.deltaActionText}>Selected file · {file.name}</Text>
                  </Pressable>
                ))}
                <Text style={styles.railSubtitle}>
                  {acceptanceClaimLabel(
                    acceptanceClaimRows({
                      claims: [row.claim],
                      recording: evidenceModel?.recording,
                    })[0],
                  )}
                </Text>
                {row.claim.reviewLabels?.length ? (
                  <Text style={styles.railSubtitle}>{row.claim.reviewLabels.join(' · ')}</Text>
                ) : null}
                {row.sourceUrl ? (
                  <Pressable onPress={() => Linking.openURL(row.sourceUrl!)}>
                    <Text style={styles.deltaActionText}>Original Jira AC</Text>
                  </Pressable>
                ) : null}
                {(() => {
                  const judgment = evidenceModel
                    .judgmentRows(reviewer ?? null)
                    .find((entry) => entry.claim.id === row.claim.id);
                  return judgment ? (
                    <VisualClaimJudgment row={judgment} onRecord={onRecordVisualReview} />
                  ) : null;
                })()}
                {(['before', 'after'] as const).map((role) =>
                  row[role].length > 1 ? (
                    <View key={role}>
                      <Text style={styles.railSubtitle}>Choose {role}</Text>
                      {row[role].map((media) => (
                        <Pressable
                          key={media.identity}
                          onPress={() => {
                            evidenceModel.chooseComparisonMedia(row.claim.id, role, media.identity);
                            refreshComparisons((value) => value + 1);
                          }}
                        >
                          <Text style={styles.deltaActionText}>{media.name}</Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null,
                )}
                {before && after ? (
                  <BeforeAfterPreview
                    evidenceModel={evidenceModel}
                    testIdPrefix={`companion-evidence-comparison-${row.claim.id}`}
                    pair={{ before, after, stem: row.claim.id }}
                    authHeaders={authHeaders}
                    title={row.claim.text}
                    allowFullscreen={false}
                    onOpenArtifact={(path) => {
                      const media = [row.selectedBefore, row.selectedAfter].find(
                        (entry) => entry?.artifactPath === path,
                      );
                      if (media) evidenceModel.selectComparisonMedia(media.identity);
                      open(path);
                    }}
                  />
                ) : (
                  <View style={styles.deltaActionRow}>
                    {(['before', 'after'] as const).map((role) => {
                      const media = role === 'before' ? row.selectedBefore : row.selectedAfter;
                      return (
                        <View key={role} style={{ flex: 1 }}>
                          <Text style={styles.railTitle}>
                            {role === 'before' ? 'Before' : 'After'}
                          </Text>
                          {media ? (
                            <Pressable
                              onPress={() => {
                                evidenceModel.selectComparisonMedia(media.identity);
                                open(media.artifactPath);
                              }}
                              testID={`companion-evidence-comparison-${row.claim.id}-${role}`}
                              accessibilityRole="button"
                              accessibilityLabel={`Open ${role} artifact ${media.artifactPath}`}
                            >
                              <CompareMedia
                                artifact={convert(media)}
                                testIdPrefix={`companion-evidence-comparison-${row.claim.id}-${role}`}
                                authHeaders={authHeaders}
                                height={180}
                                active={false}
                              />
                            </Pressable>
                          ) : (
                            <Text style={styles.railSubtitle}>No qualified {role} capture</Text>
                          )}
                        </View>
                      );
                    })}
                  </View>
                )}
                {[...row.before, ...row.after]
                  .filter((media) => !media.eligible)
                  .map((media) => (
                    <Pressable
                      key={media.identity}
                      onPress={() => {
                        evidenceModel.selectComparisonMedia(media.identity);
                        open(media.artifactPath);
                      }}
                    >
                      <Text style={styles.deltaActionText}>
                        {media.name} · {media.limitation ?? 'Unavailable for comparison'}
                      </Text>
                    </Pressable>
                  ))}
                {row.review.map((media) => (
                  <Pressable
                    key={media.identity}
                    onPress={() => {
                      evidenceModel.selectComparisonMedia(media.identity);
                      open(media.artifactPath);
                    }}
                  >
                    <Text style={styles.deltaActionText}>
                      {media.name} · {media.limitation ?? 'Review'}
                    </Text>
                  </Pressable>
                ))}
                {[...row.before, ...row.after, ...row.review].flatMap((media) =>
                  media.clips.map((clip, index) => (
                    <Pressable
                      key={`${media.identity}:${index}`}
                      onPress={() => {
                        evidenceModel.selectComparisonMedia(media.identity);
                        evidenceModel.cueClip(index);
                        open(evidenceModel.artifactPath(clip.videoPath));
                      }}
                    >
                      <Text style={styles.deltaActionText}>
                        Video {((clip.momentMs ?? clip.startMs) / 1000).toFixed(3)}s · {media.name}
                      </Text>
                    </Pressable>
                  )),
                )}
                {(primaryClip ? [primaryClip] : []).map((clip, index) => (
                  <Pressable
                    key={`${clip.videoDigest}:${clip.traceIndex}`}
                    onPress={() => {
                      evidenceModel.selectClaim(row.claim.id);
                      evidenceModel.cueClip(index);
                      open(evidenceModel.artifactPath(clip.videoPath));
                    }}
                  >
                    <Text style={styles.deltaActionText}>
                      Video {((clip.momentMs ?? clip.startMs) / 1000).toFixed(3)}s · {clip.caption}
                    </Text>
                  </Pressable>
                ))}
              </View>
            );
          })}
          {evidenceModel.comparisonFilter !== 'all' &&
          evidenceModel.comparisonView.unassigned.length > 0 ? (
            <View>
              <Text style={styles.railTitle}>
                Unassigned ({evidenceModel.comparisonView.unassigned.length})
              </Text>
              <Text style={styles.railSubtitle}>No recorded AC and role binding</Text>
              {evidenceModel.comparisonView.unassigned.map((media) => (
                <Pressable
                  key={media.identity}
                  testID={`companion-unassigned-media-${media.artifactPath}`}
                  onPress={() => {
                    evidenceModel.selectComparisonMedia(media.identity);
                    open(media.artifactPath);
                  }}
                >
                  <Text style={styles.deltaActionText}>{media.name}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      ) : (
        <EvidenceCompletenessCard
          summary={evidenceSummary}
          onOpenDiff={
            packageDiffArtifactPath && onOpenDiff
              ? () => onOpenDiff(packageDiffArtifactPath)
              : undefined
          }
        />
      )}
      {!evidenceModel && pairs.length > 0 && (
        <View style={styles.railSection}>
          <RailHeader
            title="Before → After Compare"
            subtitle="Swipe each pair between its explicit Before and After states"
            index={compareIndex}
            total={pairs.length}
          />
          {pairs.length > 1 ? (
            <PairNavigation
              index={compareIndex}
              total={pairs.length}
              testIdPrefix="companion-before-after-pairs"
              onPrevious={() => setCompareIndex((index) => Math.max(0, index - 1))}
              onNext={() => setCompareIndex((index) => Math.min(pairs.length - 1, index + 1))}
            />
          ) : null}
          <LargeComparisonCard
            pair={pairs[compareIndex] ?? pairs[0]}
            onOpenVisual={onOpenVisual}
            onOpenArtifactWorkspace={onOpenCompareArtifactWorkspace ?? onOpenArtifactWorkspace}
            onOpenDiff={
              packageDiffArtifactPath && onOpenDiff
                ? () => onOpenDiff(packageDiffArtifactPath)
                : undefined
            }
            authHeaders={authHeaders}
          />
        </View>
      )}

      {!evidenceModel && pairs.length === 0 && (
        <MissingEvidenceCard
          summary={evidenceSummary}
          onOpenDiff={
            packageDiffArtifactPath && onOpenDiff
              ? () => onOpenDiff(packageDiffArtifactPath)
              : undefined
          }
        />
      )}

      <View style={styles.railSection}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showRawArtifacts }}
          testID="companion-raw-artifacts"
          onPress={() => setShowRawArtifacts((previous) => !previous)}
        >
          <Text style={styles.railTitle}>
            {showRawArtifacts ? 'Hide ' : ''}raw artifacts ({reviewArtifacts.length})
          </Text>
        </Pressable>
        {showRawArtifacts ? (
          <>
            <RailHeader
              title="Evidence"
              subtitle="Filter the gate package, then tap a file to inspect it"
              index={0}
              total={reviewArtifacts.length}
              rightLabel={`${reviewArtifacts.length}/${artifacts.length}`}
            />
            <View style={styles.evidenceFilterWrap}>
              {visibleEvidenceFilters.map((filter) => {
                const active = filter.id === evidenceFilter;
                return (
                  <Pressable
                    key={filter.id}
                    style={[styles.evidenceFilterChip, active && styles.evidenceFilterChipActive]}
                    onPress={() => setEvidenceFilter(filter.id)}
                  >
                    <Text
                      style={[styles.evidenceFilterText, active && styles.evidenceFilterTextActive]}
                    >
                      {filter.label} {artifactCounts[filter.id]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.compactEvidenceList}>
              {reviewArtifacts.map((artifact) => (
                <CompactArtifactRow
                  key={artifact.path}
                  artifact={artifact}
                  onOpenVisual={onOpenVisual}
                  onOpenDocument={onOpenDocument}
                  onOpenDiff={onOpenDiff}
                  onOpenArtifactWorkspace={onOpenArtifactWorkspace}
                  authHeaders={authHeaders}
                />
              ))}
            </View>
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}

function sortReviewArtifacts(artifacts: ArtifactManifestEntry[]): ArtifactManifestEntry[] {
  const purposeOrder: Record<string, number> = {
    'video-before': 0,
    'video-after': 1,
    screenshot: 2,
    video: 3,
    visual: 4,
    report: 5,
    review: 6,
    recipe: 7,
    learnings: 8,
    script: 9,
  };
  return [...artifacts].sort((a, b) => {
    const purposeDelta = (purposeOrder[a.purpose] ?? 99) - (purposeOrder[b.purpose] ?? 99);
    return purposeDelta !== 0 ? purposeDelta : a.path.localeCompare(b.path);
  });
}

export function PairNavigation({
  index,
  total,
  onPrevious,
  onNext,
  testIdPrefix,
}: {
  index: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
  testIdPrefix?: string;
}) {
  return (
    <View style={styles.pairNavigation}>
      <Pressable
        style={[styles.pairNavigationButton, index === 0 && styles.pairNavigationButtonDisabled]}
        disabled={index === 0}
        onPress={onPrevious}
        testID={testIdPrefix ? `${testIdPrefix}-previous` : undefined}
      >
        <Text style={styles.pairNavigationText}>‹ Previous pair</Text>
      </Pressable>
      <Text
        style={styles.pairNavigationIndex}
        testID={testIdPrefix ? `${testIdPrefix}-index-${index + 1}` : undefined}
      >
        Pair {index + 1}/{total}
      </Text>
      <Pressable
        style={[
          styles.pairNavigationButton,
          index === total - 1 && styles.pairNavigationButtonDisabled,
        ]}
        disabled={index === total - 1}
        onPress={onNext}
        testID={testIdPrefix ? `${testIdPrefix}-next` : undefined}
      >
        <Text style={styles.pairNavigationText}>Next pair ›</Text>
      </Pressable>
    </View>
  );
}

function summarizeEvidenceCompleteness(artifacts: ArtifactManifestEntry[], pairCount: number) {
  const videos = artifacts.filter((artifact) => classifyArtifact(artifact) === 'video').length;
  const visualArtifacts = artifacts.filter((artifact) => {
    const type = classifyArtifact(artifact);
    return type === 'image' || type === 'video';
  }).length;
  const hasDiff = Boolean(diffArtifactCandidate(artifacts));
  const hasReviewReport = artifacts.some((artifact) => {
    const path = artifact.path.toLowerCase();
    const purpose = artifact.purpose.toLowerCase();
    return purpose.includes('review') || purpose.includes('report') || path.includes('review');
  });
  const missing: string[] = [];
  if (pairCount === 0) missing.push('before/after pair');
  if (!hasDiff) missing.push('diff');
  if (!hasReviewReport) missing.push('review report');
  return {
    pairCount,
    videos,
    visualArtifacts,
    hasDiff,
    hasReviewReport,
    missing,
  };
}

function EvidenceCompletenessCard({
  summary,
  onOpenDiff,
}: {
  summary: ReturnType<typeof summarizeEvidenceCompleteness>;
  onOpenDiff?: () => void;
}) {
  return (
    <View style={styles.completenessCard}>
      <View style={styles.completenessHeader}>
        <View style={styles.completenessTitleBlock}>
          <Text style={styles.completenessEyebrow}>Evidence completeness</Text>
          <Text style={styles.completenessTitle}>
            {summary.missing.length === 0
              ? 'Ready to review visually'
              : `Missing ${summary.missing.join(', ')}`}
          </Text>
        </View>
        {onOpenDiff ? (
          <Pressable style={styles.completenessDiffButton} onPress={onOpenDiff}>
            <Text style={styles.completenessDiffText}>Open diff</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.completenessRail}>
        <CompletenessPill
          label="Pairs"
          value={String(summary.pairCount)}
          ok={summary.pairCount > 0}
        />
        <CompletenessPill label="Videos" value={String(summary.videos)} ok />
        <CompletenessPill
          label="Diff"
          value={summary.hasDiff ? 'ready' : 'missing'}
          ok={summary.hasDiff}
        />
        <CompletenessPill
          label="Report"
          value={summary.hasReviewReport ? 'ready' : 'missing'}
          ok={summary.hasReviewReport}
        />
      </View>
    </View>
  );
}

function CompletenessPill({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  const color = ok ? colors.statusOk : colors.statusWarn;
  return (
    <View style={[styles.completenessPill, { borderColor: color + '88' }]}>
      <Text style={[styles.completenessPillLabel, { color }]}>{label}</Text>
      <Text style={styles.completenessPillValue}>{value}</Text>
    </View>
  );
}

function MissingEvidenceCard({
  summary,
  onOpenDiff,
}: {
  summary: ReturnType<typeof summarizeEvidenceCompleteness>;
  onOpenDiff?: () => void;
}) {
  return (
    <View style={styles.missingEvidenceCard}>
      <Text style={styles.missingEvidenceTitle}>No before → after pair found</Text>
      <Text style={styles.missingEvidenceText}>
        This package still has {summary.visualArtifacts} visual file
        {summary.visualArtifacts === 1 ? '' : 's'}, but no paired before/after delta. Ask the worker
        for paired screenshots or inspect the Files tab.
      </Text>
      {onOpenDiff ? (
        <Pressable style={styles.missingEvidenceButton} onPress={onOpenDiff}>
          <Text style={styles.missingEvidenceButtonText}>
            Review diff while evidence is missing
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function RailHeader({
  title,
  subtitle,
  index,
  total,
  rightLabel,
}: {
  title: string;
  subtitle: string;
  index: number;
  total: number;
  rightLabel?: string;
}) {
  return (
    <View style={styles.railHeader}>
      <View>
        <Text style={styles.railTitle}>{title}</Text>
        <Text style={styles.railSubtitle}>{subtitle}</Text>
      </View>
      <Text style={styles.railIndex}>
        {rightLabel ?? (total > 0 ? `${Math.min(index + 1, total)}/${total}` : '—')}
      </Text>
    </View>
  );
}

function LargeComparisonCard({
  pair,
  onOpenVisual,
  onOpenArtifactWorkspace,
  onOpenDiff,
  authHeaders,
}: {
  pair: VisualArtifactPair;
  onOpenVisual: (uri: string) => void;
  onOpenArtifactWorkspace?: (artifact: ArtifactManifestEntry) => void;
  onOpenDiff?: () => void;
  authHeaders?: ArtifactHttpHeaders;
}) {
  const beforeName = artifactDisplayName(pair.before);
  const afterName = artifactDisplayName(pair.after);
  return (
    <View style={styles.largeCard}>
      <BeforeAfterPreview
        pair={pair}
        authHeaders={authHeaders}
        onOpenBefore={() => onOpenVisual(pair.before.url)}
        onOpenAfter={() => onOpenVisual(pair.after.url)}
        eyebrow="Visual difference"
        title={comparisonStem(pair)}
        hint="Swipe left or right"
        imageHeight={210}
        testIdPrefix="companion-before-after-primary"
      />
      <View style={styles.deltaChecklist}>
        <Text style={styles.deltaChecklistLabel}>Identify before vs after</Text>
        <Text style={styles.deltaChecklistText} numberOfLines={1}>
          {beforeName} → {afterName}
        </Text>
        <Text style={styles.deltaChecklistHint}>
          Confirm the visible delta before approving, retrying, or dispatching follow-up work.
        </Text>
        <View style={styles.deltaActionRow}>
          <Pressable style={styles.deltaAction} onPress={() => onOpenVisual(pair.before.url)}>
            <Text style={styles.deltaActionText}>Open before fullscreen</Text>
          </Pressable>
          <Pressable style={styles.deltaAction} onPress={() => onOpenVisual(pair.after.url)}>
            <Text style={styles.deltaActionText}>Open after fullscreen</Text>
          </Pressable>
          {onOpenArtifactWorkspace ? (
            <>
              <Pressable
                style={styles.deltaAction}
                onPress={() => onOpenArtifactWorkspace(pair.before)}
              >
                <Text style={styles.deltaActionText}>Before artifacts</Text>
              </Pressable>
              <Pressable
                style={styles.deltaAction}
                onPress={() => onOpenArtifactWorkspace(pair.after)}
              >
                <Text style={styles.deltaActionText}>After artifacts</Text>
              </Pressable>
            </>
          ) : null}
          {onOpenDiff ? (
            <Pressable style={styles.deltaAction} onPress={onOpenDiff}>
              <Text style={styles.deltaActionText}>Open diff</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function CompactArtifactRow({
  artifact,
  onOpenVisual,
  onOpenDocument,
  onOpenDiff,
  onOpenArtifactWorkspace,
  authHeaders,
}: {
  artifact: ReviewArtifact;
  onOpenVisual: (uri: string) => void;
  onOpenDocument: (artifact: ArtifactManifestEntry) => void;
  onOpenDiff?: (path: string) => void;
  onOpenArtifactWorkspace?: (artifact: ArtifactManifestEntry) => void;
  authHeaders?: ArtifactHttpHeaders;
}) {
  const mediaType = classifyArtifact(artifact);
  const isDiffArtifact = diffArtifactCandidate([artifact])?.path === artifact.path;
  const typeLabel = isDiffArtifact ? 'diff' : mediaType === 'other' ? artifact.purpose : mediaType;
  const openArtifact = () => {
    if (mediaType === 'image' || mediaType === 'video') {
      onOpenVisual(artifact.url);
      return;
    }
    if (isDiffArtifact && onOpenDiff) {
      onOpenDiff(artifact.path);
      return;
    }
    if (mediaType === 'document') {
      onOpenDocument(artifact);
      return;
    }
    if (onOpenArtifactWorkspace) {
      onOpenArtifactWorkspace(artifact);
      return;
    }
    onOpenDocument(artifact);
  };

  return (
    <Pressable
      testID={`companion-evidence-artifact-${artifact.path}`}
      style={styles.compactArtifactRow}
      onPress={openArtifact}
    >
      <CompactArtifactPreview
        artifact={artifact}
        mediaType={mediaType}
        isDiffArtifact={isDiffArtifact}
        authHeaders={authHeaders}
      />
      <View style={styles.compactArtifactBody}>
        <View style={styles.compactArtifactTitleRow}>
          <Text style={styles.compactArtifactTitle} numberOfLines={1}>
            {artifactDisplayName(artifact)}
          </Text>
          <Text style={styles.compactArtifactType}>{typeLabel}</Text>
        </View>
        <Text style={styles.compactArtifactPath} numberOfLines={1}>
          {artifact.path}
        </Text>
        <View style={styles.compactArtifactMetaRow}>
          <Text style={styles.compactArtifactMeta} numberOfLines={1}>
            {artifact.sourceLabel ?? artifact.purpose}
          </Text>
          {artifact.sizeBytes != null && artifact.sizeBytes > 0 ? (
            <Text style={styles.compactArtifactMeta}>{formatBytes(artifact.sizeBytes)}</Text>
          ) : null}
        </View>
      </View>
      <Text style={styles.compactArtifactOpen}>Open</Text>
    </Pressable>
  );
}

function CompactArtifactPreview({
  artifact,
  mediaType,
  isDiffArtifact,
  authHeaders,
}: {
  artifact: ReviewArtifact;
  mediaType: ReturnType<typeof classifyArtifact>;
  isDiffArtifact: boolean;
  authHeaders?: ArtifactHttpHeaders;
}) {
  if (mediaType === 'image') {
    return (
      <ArtifactImage
        artifact={artifact}
        uri={artifact.url}
        authHeaders={authHeaders}
        style={styles.compactArtifactImage}
        resizeMode="cover"
      />
    );
  }
  const label = isDiffArtifact
    ? 'DIFF'
    : mediaType === 'video'
      ? 'VID'
      : mediaType === 'document'
        ? documentArtifactLabel(artifact)
        : 'FILE';
  return (
    <View style={styles.compactArtifactIconBox}>
      <Text style={styles.compactArtifactIconText}>{label}</Text>
    </View>
  );
}

function documentArtifactLabel(artifact: ArtifactManifestEntry): string {
  const lowerPath = artifact.path.toLowerCase();
  if (lowerPath.endsWith('.json')) return 'JSON';
  if (lowerPath.endsWith('.md')) return 'MD';
  if (lowerPath.endsWith('.txt')) return 'TXT';
  return 'DOC';
}

function comparisonStem(pair: VisualArtifactPair): string {
  return formatVisualArtifactPairLabel(pair);
}

function artifactDisplayName(artifact: ArtifactManifestEntry): string {
  return artifact.label?.trim() || artifact.path.split('/').pop() || artifact.path;
}

const styles = StyleSheet.create({
  workspace: {
    gap: spacing.lg,
  },
  completenessCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '44',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.lg,
  },
  completenessHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
  },
  completenessTitleBlock: {
    flex: 1,
    minWidth: 0,
  },
  completenessEyebrow: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  completenessTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
    marginTop: spacing.xs,
  },
  completenessDiffButton: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent + '88',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  completenessDiffText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  completenessRail: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  completenessPill: {
    backgroundColor: colors.bgInput,
    borderRadius: radii.md,
    borderWidth: 1,
    minWidth: 82,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  completenessPillLabel: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  completenessPillValue: {
    color: colors.textPrimary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    marginTop: 2,
    textTransform: 'uppercase',
  },
  missingEvidenceCard: {
    backgroundColor: colors.statusWarn + '12',
    borderColor: colors.statusWarn + '66',
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
    padding: spacing.lg,
  },
  missingEvidenceTitle: {
    color: colors.statusWarn,
    fontSize: fonts.sizeMd,
    fontWeight: '900',
  },
  missingEvidenceText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeSm,
    lineHeight: 19,
  },
  missingEvidenceButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.statusWarn + '22',
    borderColor: colors.statusWarn + '88',
    borderRadius: 999,
    borderWidth: 1,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  missingEvidenceButtonText: {
    color: colors.statusWarn,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  railSection: {
    gap: spacing.md,
  },
  railHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  railTitle: {
    color: colors.textPrimary,
    fontSize: fonts.sizeMd,
    fontWeight: '800',
  },
  railSubtitle: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    marginTop: spacing.xs,
  },
  railIndex: {
    color: colors.accent,
    fontSize: fonts.sizeSm,
    fontWeight: '800',
  },
  pairNavigation: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  pairNavigationButton: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '55',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  pairNavigationButtonDisabled: { opacity: 0.35 },
  pairNavigationText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  pairNavigationIndex: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    fontWeight: '800',
  },
  largeCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  deltaChecklist: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '33',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xs,
    marginTop: spacing.md,
    padding: spacing.sm,
  },
  deltaChecklistLabel: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  deltaChecklistText: {
    color: colors.textPrimary,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  deltaChecklistHint: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
    lineHeight: 16,
  },
  deltaActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  deltaAction: {
    backgroundColor: colors.accent + '18',
    borderColor: colors.accent + '55',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  deltaActionText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  compactEvidenceList: {
    gap: spacing.sm,
  },
  evidenceFilterWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  evidenceFilterChip: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '24',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  evidenceFilterChipActive: {
    backgroundColor: colors.accent + '22',
    borderColor: colors.accent,
  },
  evidenceFilterText: {
    color: colors.textSecondary,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
  evidenceFilterTextActive: {
    color: colors.accentHover,
  },
  compactArtifactRow: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: colors.accent + '24',
    borderRadius: radii.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 74,
    padding: spacing.md,
  },
  compactArtifactImage: {
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '24',
    borderRadius: radii.md,
    borderWidth: 1,
    height: 54,
    width: 64,
  },
  compactArtifactIconBox: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderColor: colors.accent + '24',
    borderRadius: radii.md,
    borderWidth: 1,
    height: 54,
    justifyContent: 'center',
    width: 64,
  },
  compactArtifactIconText: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  compactArtifactBody: {
    flex: 1,
    gap: spacing.xs,
    minWidth: 0,
  },
  compactArtifactTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  compactArtifactTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: fonts.sizeSm,
    fontWeight: '900',
  },
  compactArtifactType: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  compactArtifactPath: {
    color: colors.textMuted,
    fontSize: fonts.sizeXs,
  },
  compactArtifactMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  compactArtifactMeta: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  compactArtifactOpen: {
    color: colors.accent,
    fontSize: fonts.sizeXs,
    fontWeight: '900',
  },
});
