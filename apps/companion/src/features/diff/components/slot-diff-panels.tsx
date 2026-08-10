import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { type Run } from '@farmslot/protocol';

import {
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
  extractRunArtifactManifest,
} from '../../../lib/artifact-url';
import { prRepoFromWorkspaceSource } from '../../../lib/pr-links';
import {
  selectReadyWorkspaceDecision,
  selectRetrospectiveWorkspaceDecision,
  selectReviewGateWorkspaceDecision,
} from '../../../lib/workspace-decisions';
import { summarizeRunWorkspaceNavMeta } from '../../../lib/workspace-nav-meta';
import {
  artifactFilterParamForWorkspaceNav,
  decisionWorkspaceRouteParams,
  familySectionRouteContextParams,
  targetWorkspaceRouteContextParams,
  type WorkspaceRouteContext,
} from '../../../lib/workspace-navigation';
import { slotDiffStyles as styles } from '../styles/slot-diff.styles';

export function SlotDiffCockpit({
  slotId,
  run,
  currentRunId,
  requestedPath,
  recipeArtifactCount,
  recipeAvailable,
  comparePairCount,
  compareArtifactPath,
  compareRecipeRunId,
  compareUsesRecipe,
  workspaceRouteContext,
}: {
  slotId: string;
  run: Run | null;
  currentRunId: string | null;
  requestedPath: string;
  recipeArtifactCount: number | null;
  recipeAvailable?: boolean;
  comparePairCount: number;
  compareArtifactPath: string | null;
  compareRecipeRunId?: string | null;
  compareUsesRecipe: boolean;
  workspaceRouteContext: WorkspaceRouteContext;
}) {
  const router = useRouter();
  const targetRunId = run?.id ?? currentRunId;
  const artifacts = run ? extractRunArtifactManifest(run) : [];
  const artifactCount = artifacts.length;
  const readyDecision = selectReadyWorkspaceDecision(run);
  const reviewGateDecision = selectReviewGateWorkspaceDecision(run);
  const retroDecision = selectRetrospectiveWorkspaceDecision(run);
  const workspaceNavMeta = summarizeRunWorkspaceNavMeta(run);
  const terminalRouteContext = targetWorkspaceRouteContextParams(
    'terminal',
    workspaceRouteContext.decisionKind,
  );
  const runRouteContext = targetWorkspaceRouteContextParams(
    'run',
    workspaceRouteContext.decisionKind,
  );
  const diffRouteContext = targetWorkspaceRouteContextParams(
    'diff',
    workspaceRouteContext.decisionKind,
  );
  const compareRouteContext = targetWorkspaceRouteContextParams(
    'compare',
    workspaceRouteContext.decisionKind,
  );
  const recipeRouteContext = targetWorkspaceRouteContextParams(
    'recipe',
    workspaceRouteContext.decisionKind,
  );
  const slotRouteContext = targetWorkspaceRouteContextParams(
    'slot',
    workspaceRouteContext.decisionKind,
  );
  const prRouteContext = targetWorkspaceRouteContextParams(
    'pr',
    workspaceRouteContext.decisionKind,
  );
  const terminalParams = {
    slotId,
    ...terminalRouteContext,
    keys: '1',
    details: '1',
    ...(targetRunId ? { runId: targetRunId } : {}),
    ...(targetRunId ? { recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM } : {}),
  };
  return (
    <View style={styles.contextCard}>
      <View style={styles.contextHeader}>
        <View style={styles.contextTitleBlock}>
          <Text style={styles.contextEyebrow}>Live diff cockpit</Text>
          <Text style={styles.contextTitle} numberOfLines={1}>
            {slotId}
          </Text>
        </View>
        <Pressable
          style={styles.contextPill}
          onPress={() => router.push({ pathname: '/terminal/[slotId]', params: terminalParams })}
        >
          <Text style={styles.contextPillText}>Terminal</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.contextRail}
      >
        <ContextTile label="Source" value="git.diff" />
        <ContextTile label="Slot" value={slotId} />
        <ContextTile
          label="Run detail"
          value={run?.status ?? (targetRunId ? 'loading' : '-')}
          disabled={!targetRunId}
          onPress={() => {
            if (!targetRunId) return;
            router.push({
              pathname: '/run/[id]',
              params: {
                id: targetRunId,
                ...runRouteContext,
                recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
              },
            });
          }}
        />
        <ContextTile label="Path" value={requestedPath || 'all files'} />
        <ContextTile label="Scope" value="workspace" />
        <ContextTile
          label="Evidence files"
          value={String(artifactCount)}
          disabled={!targetRunId}
          onPress={() => {
            if (!targetRunId) return;
            router.push({
              pathname: '/artifacts/[runId]',
              params: {
                runId: targetRunId,
                ...diffRouteContext,
                recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                filter: artifactFilterParamForWorkspaceNav('diff'),
              },
            });
          }}
        />
        <ContextTile
          label={compareUsesRecipe ? 'Recipe compare' : 'Before→After'}
          value={String(comparePairCount)}
          disabled={!targetRunId || comparePairCount === 0}
          onPress={() => {
            if (!targetRunId || !compareArtifactPath) return;
            router.push({
              pathname: '/artifacts/[runId]',
              params: {
                runId: targetRunId,
                ...compareRouteContext,
                recipeRun: compareRecipeRunId ?? DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                filter: artifactFilterParamForWorkspaceNav('compare'),
                artifact: compareArtifactPath,
              },
            });
          }}
        />
        <ContextTile
          label="Recipe files"
          value={
            recipeArtifactCount === null
              ? 'loading'
              : recipeAvailable
                ? String(recipeArtifactCount)
                : '-'
          }
          disabled={!targetRunId || recipeAvailable === false}
          onPress={() => {
            if (!targetRunId || recipeAvailable === false) return;
            router.push({
              pathname: '/artifacts/[runId]',
              params: {
                runId: targetRunId,
                ...recipeRouteContext,
                recipeRun: CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                filter: artifactFilterParamForWorkspaceNav('recipe'),
              },
            });
          }}
        />
        <ContextTile
          label="Ready gate"
          value={workspaceNavMeta.readyMeta ?? (readyDecision ? 'available' : '-')}
          disabled={!readyDecision}
          onPress={() => {
            if (!readyDecision) return;
            router.push({
              pathname: '/decision/[id]',
              params: {
                id: readyDecision.id,
                ...decisionWorkspaceRouteParams('ready'),
                ...(targetRunId ? { runId: targetRunId } : {}),
              },
            });
          }}
        />
        <ContextTile
          label="Review gate"
          value={workspaceNavMeta.reviewMeta ?? (reviewGateDecision ? 'available' : '-')}
          disabled={!reviewGateDecision}
          onPress={() => {
            if (!reviewGateDecision) return;
            router.push({
              pathname: '/decision/[id]',
              params: {
                id: reviewGateDecision.id,
                ...decisionWorkspaceRouteParams('review'),
                ...(targetRunId ? { runId: targetRunId } : {}),
              },
            });
          }}
        />
        <ContextTile
          label="Retro gate"
          value={workspaceNavMeta.retroMeta ?? (retroDecision ? 'available' : '-')}
          disabled={!retroDecision}
          onPress={() => {
            if (!retroDecision) return;
            router.push({
              pathname: '/decision/[id]',
              params: {
                id: retroDecision.id,
                ...decisionWorkspaceRouteParams('retrospective'),
                ...(targetRunId ? { runId: targetRunId } : {}),
              },
            });
          }}
        />
        <ContextTile
          label="Slot view"
          value="ready/review"
          onPress={() =>
            router.push({
              pathname: '/slot/[id]',
              params: {
                id: slotId,
                ...slotRouteContext,
                ...(targetRunId ? { runId: targetRunId } : {}),
                ...(targetRunId ? { recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM } : {}),
              },
            })
          }
        />
        <ContextTile
          label="Family"
          value={run?.familyId ? shortId(run.familyId) : '-'}
          disabled={!run?.familyId}
          onPress={() => {
            if (!run?.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams('ledger', workspaceRouteContext.decisionKind),
                ...(targetRunId ? { runId: targetRunId } : {}),
                section: 'ledger',
              },
            });
          }}
        />
        <ContextTile
          label="Family retros"
          value={run?.familyId ? 'open' : '-'}
          disabled={!run?.familyId}
          onPress={() => {
            if (!run?.familyId) return;
            router.push({
              pathname: '/family/[familyId]',
              params: {
                familyId: run.familyId,
                project: run.project,
                ...familySectionRouteContextParams('retros', workspaceRouteContext.decisionKind),
                ...(targetRunId ? { runId: targetRunId } : {}),
                section: 'retros',
              },
            });
          }}
        />
        <ContextTile
          label="PR"
          value={run?.prNumber ? `#${run.prNumber}` : '-'}
          disabled={!run?.prNumber}
          onPress={() => {
            if (!run?.prNumber) return;
            const prRepo = prRepoFromWorkspaceSource(run, run.prNumber);
            router.push({
              pathname: '/(tabs)/prs',
              params: {
                pr: String(run.prNumber),
                ...prRouteContext,
                ...(prRepo ? { repo: prRepo } : {}),
              },
            });
          }}
        />
        <ContextTile
          label="Terminal"
          value="control"
          onPress={() => router.push({ pathname: '/terminal/[slotId]', params: terminalParams })}
        />
      </ScrollView>
    </View>
  );
}
export function ContextTile({
  label,
  value,
  onPress,
  disabled,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  const content = (
    <>
      <Text style={styles.contextMetricLabel}>{label}</Text>
      <Text style={styles.contextMetricValue} numberOfLines={1}>
        {value}
      </Text>
    </>
  );
  if (onPress) {
    return (
      <Pressable
        style={[styles.contextMetric, disabled && styles.contextMetricDisabled]}
        onPress={onPress}
        disabled={disabled}
      >
        {content}
      </Pressable>
    );
  }
  return <View style={styles.contextMetric}>{content}</View>;
}
export function shortId(value: string): string {
  return value.length <= 10 ? value : `${value.slice(0, 8)}…`;
}
export function routeParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}
