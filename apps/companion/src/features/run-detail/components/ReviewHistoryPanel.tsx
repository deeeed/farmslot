import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { type ReviewChainEntry, reviewChainForRun, type Run } from '@farmslot/protocol';
import { type ReviewHistoryFix, type ReviewHistoryRound } from '@farmslot/review-dispatch';

import { MobileDiffViewer } from '../../../components/MobileDiffViewer';
import { formatPreciseDuration } from '../../workspace-shared/format';
import { styles } from '../styles/review-history.styles';
import { useReviewHistory } from '../use-review-history';

type History = ReturnType<typeof useReviewHistory>;

function ReviewRoundCard({
  round,
  history,
  onOpenArtifact,
}: {
  round: ReviewHistoryRound;
  history: History;
  onOpenArtifact: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = round.verdict === 'pending';
  const duration =
    round.durationMs ??
    (running && round.startedAt ? Date.now() - Date.parse(round.startedAt) : null);
  return (
    <View style={styles.reviewerCard} testID={`review-history-round-${round.roundNumber}`}>
      <Pressable
        style={styles.attemptSummary}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <View style={styles.grow}>
          <View style={styles.row}>
            <Text style={styles.reviewerTitle}>Round {round.roundNumber}</Text>
            <Text style={[styles.chip, round.verdictTone === 'ok' ? styles.passed : styles.issues]}>
              {history.loading && round.verdict === 'Result not recorded'
                ? 'Loading result…'
                : running
                  ? 'Running'
                  : round.verdict}
            </Text>
          </View>
          <Text style={styles.meta}>
            {round.runner} / {round.model} · {round.modeLabel}
          </Text>
          <Text style={styles.meta}>
            {round.headSha?.slice(0, 8) ?? (history.loading ? 'Loading head…' : 'Head pending')}
            {duration !== null
              ? ` · ${running ? 'Running · ' : ''}${formatPreciseDuration(Math.max(0, duration))}`
              : ''}
          </Text>
        </View>
        <Text style={styles.expand}>{expanded ? '−' : '+'}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.roundDetails}>
          {round.startedAt ? (
            <Text style={styles.meta}>
              Started {new Date(round.startedAt).toLocaleString()} · {round.reviewRange}
            </Text>
          ) : null}
          {round.failureReason ? <Text style={styles.issues}>{round.failureReason}</Text> : null}
          {round.usageLabel ? <Text style={styles.meta}>{round.usageLabel}</Text> : null}
          {round.findings.map((finding) => {
            const source =
              history.source?.key === `${round.key}:${finding.id}` ? history.source : undefined;
            return (
              <View key={finding.id} style={styles.finding}>
                <View style={styles.actions}>
                  <Text style={[styles.chip, styles.issues]}>{finding.severity}</Text>
                  <Text style={styles.chip}>{finding.statusLabel}</Text>
                </View>
                <Pressable
                  style={styles.locationButton}
                  accessibilityRole="button"
                  disabled={!round.headSha || !finding.line}
                  onPress={() => history.inspect(round, finding)}
                >
                  <Text style={styles.findingLocation}>
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ''}
                  </Text>
                </Pressable>
                <Text selectable style={styles.issue}>
                  {finding.title}
                  {finding.details ? `\n${finding.details}` : ''}
                </Text>
                {source?.loading ? <Text style={styles.meta}>Loading reviewed source…</Text> : null}
                {source?.error ? <Text style={styles.issues}>{source.error}</Text> : null}
                {source?.context ? (
                  <MobileDiffViewer
                    title={`${finding.file}:${finding.line} at ${round.headSha?.slice(0, 8)}`}
                    reviewedSource={source.context}
                  />
                ) : null}
              </View>
            );
          })}
          {!round.findings.length ? (
            <Text style={styles.meta}>
              {history.loading ? 'Loading recorded findings…' : round.findingsLabel}
            </Text>
          ) : null}
          {round.diffText !== null ? (
            <MobileDiffViewer
              title={`${round.diffReconstructed ? 'Frozen commit diff' : 'Code reviewed'} · round ${round.roundNumber}`}
              diffText={round.diffText}
              maxHeight={240}
            />
          ) : round.diffPath ? (
            <Pressable
              style={styles.diffButton}
              disabled={history.loading || (round.diffReconstructed && round.diffText === null)}
              onPress={() => onOpenArtifact(round.diffPath!)}
            >
              <Text style={styles.diffButtonText}>
                {round.diffReconstructed
                  ? 'Frozen commit diff · reconstructed'
                  : 'Reviewed code diff'}
              </Text>
            </Pressable>
          ) : null}
          {!history.loading && round.unavailable.length ? (
            <Text style={styles.stale}>
              Some history artifacts could not be loaded. Refresh to try again.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ReviewFixCard({
  fix,
  onOpenArtifact,
}: {
  fix: ReviewHistoryFix;
  onOpenArtifact: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const duration =
    fix.durationMs ??
    (fix.running && fix.startedAt ? Date.now() - Date.parse(fix.startedAt) : null);
  return (
    <View style={styles.reviewerCard} testID="review-history-fix">
      <Pressable
        style={styles.attemptSummary}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <View style={styles.grow}>
          <Text style={styles.reviewerTitle}>
            {fix.label} · {fix.running ? 'Running' : 'Complete'}
          </Text>
          <Text style={styles.meta}>
            {fix.range ?? 'Worker applying fixes'}
            {duration !== null ? ` · ${formatPreciseDuration(Math.max(0, duration))}` : ''}
          </Text>
          {fix.stat ? <Text style={styles.meta}>{fix.stat}</Text> : null}
        </View>
        <Text style={styles.expand}>{expanded ? '−' : '+'}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.roundDetails}>
          {fix.reconstructed ? (
            <Text style={styles.meta}>Saved head comparison · committed code</Text>
          ) : null}
          <Text style={styles.meta}>
            {fix.resolved.length
              ? 'Not raised again in the later review'
              : fix.running
                ? 'Resolution awaits the next review.'
                : 'No per-finding resolution confirmed yet.'}
          </Text>
          {fix.resolved.map((finding) => (
            <Text key={finding.id} style={styles.issue}>
              {finding.severity} · {finding.title}
            </Text>
          ))}
          {fix.files.map((file) => (
            <Text key={file} style={styles.meta}>
              {file}
            </Text>
          ))}
          {fix.diffText !== null ? (
            <MobileDiffViewer title={fix.label} diffText={fix.diffText} maxHeight={240} />
          ) : fix.diffPath ? (
            <Pressable style={styles.diffButton} onPress={() => onOpenArtifact(fix.diffPath!)}>
              <Text style={styles.diffButtonText}>Changed files and diff</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function ReviewHistoryPanel({
  run,
  chain,
  onOpenArtifact,
}: {
  run: Run;
  chain?: ReviewChainEntry[];
  onOpenArtifact?: (path: string) => void;
}) {
  const router = useRouter();
  const openArtifact =
    onOpenArtifact ??
    ((path: string) =>
      router.push({
        pathname: '/workspace/run/[runId]/files',
        params: { runId: run.id, artifact: path },
      }));
  const history = useReviewHistory(run, chain ?? reviewChainForRun(run));
  if (!history.chain.length && !history.events.length && !history.activeReplay) return null;
  return (
    <View style={styles.section} testID="run-review-history">
      <View style={styles.header}>
        <Text style={styles.title}>Review history</Text>
        <Text style={styles.count}>{history.summary}</Text>
        <Pressable style={styles.diffButton} onPress={history.refresh}>
          <Text style={styles.diffButtonText}>Refresh</Text>
        </Pressable>
        {history.loading ? <Text style={styles.meta}>Loading recorded round details…</Text> : null}
        {history.error ? <Text style={styles.issues}>{history.error}</Text> : null}
      </View>
      <View style={styles.timeline}>
        {history.chain
          .filter((entry) => entry.runId !== run.id || !history.roundCount)
          .map((entry) => (
            <View key={entry.runId} style={styles.reviewerCard}>
              <Text style={styles.reviewerTitle}>
                Generation {entry.generation} · {entry.verdict}
              </Text>
              <Text style={styles.meta}>
                {entry.runner} / {entry.model} · {entry.mode.toUpperCase()} · {entry.range}
              </Text>
              {entry.diffPath ? (
                <Pressable style={styles.diffButton} onPress={() => openArtifact(entry.diffPath!)}>
                  <Text style={styles.diffButtonText}>Reviewed code diff</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        {history.events.map((event) =>
          event.kind === 'review' ? (
            <ReviewRoundCard
              key={event.key}
              round={event.round}
              history={history}
              onOpenArtifact={openArtifact}
            />
          ) : event.kind === 'fix' ? (
            <ReviewFixCard key={event.key} fix={event.fix} onOpenArtifact={openArtifact} />
          ) : (
            <Text key={event.key} style={styles.pending}>
              {event.label}
            </Text>
          ),
        )}
        {history.activeReplay ? (
          <Text
            accessibilityLiveRegion="polite"
            style={styles.pending}
            testID="companion-review-history-replay"
          >
            Round {history.activeReplay.roundNumber} · Replay starting
          </Text>
        ) : null}
      </View>
    </View>
  );
}
