import React, { useState } from 'react';
import { Text, View } from 'react-native';

import { prExecutionText, prReviewText } from '../../../lib/pr-automation';
import { styles } from '../styles/pr-automation-styles';
import type { PRAutomationController } from '../use-pr-automation-controller';

import { PRButton } from './PRControls';

export function PRReviewCards({ viewModel: vm, actions }: PRAutomationController) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const requests = (vm.reviews.submissions ?? []).filter(
    (request) =>
      (!vm.teamId || request.request.teamId === vm.teamId) && (vm.history || !request.cancelledAt),
  );
  const intents = vm.reviews.intents.filter(
    (intent) =>
      (!vm.teamId || intent.contributions.some((source) => source.teamId === vm.teamId)) &&
      (vm.history || !['completed', 'failed', 'withdrawn'].includes(intent.status)),
  );
  return (
    <>
      <PRButton
        label="Request PR review / QA"
        testID="companion-pr-request-open"
        disabled={vm.disabled}
        onPress={actions.openRequest}
      />
      {!requests.length && !intents.length && (
        <Text style={styles.muted}>No review work in this view.</Text>
      )}
      {requests.map((request) => (
        <View
          key={request.id}
          style={styles.card}
          testID={`companion-pr-request-${request.request.pr.repo}#${request.request.pr.number}`}
        >
          <Text style={styles.title}>
            {request.request.pr.repo}#{request.request.pr.number}
          </Text>
          <Text style={styles.muted}>
            {vm.reviews.teams.find((team) => team.id === request.request.teamId)?.config.name ??
              request.request.teamId}{' '}
            · {request.request.source.client}
          </Text>
          <Text style={styles.text}>
            {request.cancelledAt
              ? 'Cancelled'
              : request.intentId
                ? 'Linked to review queue'
                : request.error
                  ? 'Source unavailable'
                  : 'Checking request'}
          </Text>
          <PRButton
            label={expanded[request.id] ? 'Hide request details' : 'Show request details'}
            onPress={() =>
              setExpanded((current) => ({ ...current, [request.id]: !current[request.id] }))
            }
          />
          {!expanded[request.id] ? null : (
            <>
              {request.error && <Text style={styles.error}>{request.error}</Text>}
              {request.request.review && (
                <Text style={styles.muted}>{prReviewText(request.request.review)}</Text>
              )}
              {!request.cancelledAt && (
                <PRButton
                  label="Cancel request"
                  testID={`companion-pr-request-cancel-${request.request.pr.repo}#${request.request.pr.number}`}
                  disabled={
                    vm.disabled ||
                    vm.reviews.intents.some(
                      (intent) => intent.id === request.intentId && !!intent.runId,
                    )
                  }
                  onPress={() => actions.cancelRequest(request)}
                />
              )}
            </>
          )}
        </View>
      ))}
      {intents.map((intent) => {
        const run = vm.runs.find((item) => item.id === intent.runId);
        const queue = vm.queue.find((item) => item.id === intent.queueItemId);
        const controllable =
          !intent.runId &&
          intent.contributions.some((source) => source.eligible) &&
          !['running', 'completed', 'failed', 'withdrawn'].includes(intent.status);
        return (
          <View key={intent.id} style={styles.card}>
            <Text style={styles.title}>
              {intent.pr.repo}#{intent.pr.number} · {intent.status}
            </Text>
            <Text style={styles.muted}>
              {intent.reviewProfile} · Head {intent.headSha}
            </Text>
            {intent.reviewedSha && <Text style={styles.muted}>Reviewed {intent.reviewedSha}</Text>}
            <PRButton
              label={expanded[intent.id] ? 'Hide review details' : 'Show review details'}
              onPress={() =>
                setExpanded((current) => ({ ...current, [intent.id]: !current[intent.id] }))
              }
            />
            {!expanded[intent.id] ? null : (
              <>
                {(intent.waitingReason || queue?.waitingReason) && (
                  <Text style={styles.attention}>
                    {intent.waitingReason ?? queue?.waitingReason}
                  </Text>
                )}
                {intent.contributions.map((source) => (
                  <View key={source.ruleId ?? source.submissionId} style={styles.card}>
                    <Text style={styles.text}>
                      {vm.reviews.teams.find((team) => team.id === source.teamId)?.config.name ??
                        source.teamId}{' '}
                      · {source.autoStart ? 'Auto-start' : 'Acceptance required'}
                    </Text>
                    <Text style={styles.muted}>{source.reasons.join('; ')}</Text>
                    <Text style={styles.muted}>{prReviewText(source.review)}</Text>
                    <Text style={styles.muted}>{prExecutionText(source.execution)}</Text>
                    {source.configurationErrors.map((error) => (
                      <Text key={error} style={styles.error}>
                        {error}
                      </Text>
                    ))}
                  </View>
                ))}
                {(run?.slotId || queue?.slotId) && (
                  <Text style={styles.text}>
                    Assigned {run?.slotId ?? queue?.slotId} · {run?.metrics.runner ?? queue?.runner}
                    /{run?.metrics.model ?? queue?.model}/{run?.effort ?? queue?.effort}
                  </Text>
                )}
                {intent.runId && (
                  <PRButton
                    label="Open review run and session history"
                    onPress={() => actions.openRun(intent.runId!)}
                  />
                )}
                {run?.repeatReviewContext?.session && (
                  <Text style={styles.muted}>
                    Session {run.repeatReviewContext.session.continuity}
                    {run.repeatReviewContext.session.fallbackReason
                      ? ` · ${run.repeatReviewContext.session.fallbackReason}`
                      : ''}
                  </Text>
                )}
                <View style={styles.row}>
                  <PRButton
                    label="Accept / resume"
                    disabled={
                      vm.disabled || !controllable || intent.status === 'needs-configuration'
                    }
                    onPress={() => actions.decideReview(intent, true)}
                  />
                  <PRButton
                    label="Defer"
                    disabled={vm.disabled || !controllable}
                    onPress={() => actions.decideReview(intent, false)}
                  />
                </View>
              </>
            )}
          </View>
        );
      })}
    </>
  );
}
