import { Stack } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import type { FamilyObservabilityArtifact } from '@farmslot/protocol';

import { DocumentViewer } from '../../components/DocumentViewer';
import { MediaViewer } from '../../components/MediaViewer';
import { RunWorkspaceNav } from '../../components/RunWorkspaceNav';
import {
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
  DECISION_EVIDENCE_RECIPE_RUN_PARAM,
} from '../../lib/artifact-url';
import { prRepoFromWorkspaceSource } from '../../lib/pr-links';
import { baseStyles, spacing } from '../../lib/theme';
import {
  artifactFilterParamForArtifactPath,
  artifactFilterParamForWorkspaceNav,
  decisionWorkspaceRouteParams,
  recipeWorkspaceParam,
  recipeWorkspaceScopeLabel,
  shouldPreserveArtifactForRecipeContext,
} from '../../lib/workspace-navigation';

import {
  EvidenceGroupCard,
  FamilyBeforeAfterPriorityPanel,
  FamilyChangeLedgerPanel,
  FamilyComparePanel,
  FamilyFocusedArtifactCard,
  FamilyRunWorkspaceCard,
  FamilyWorkspaceCockpit,
  formatDateTime,
  Metric,
  RetrospectiveCard,
  RunCard,
} from './components/family-workspace-panels';
import { familyWorkspaceStyles as styles } from './styles/family-workspace.styles';
import { EVIDENCE_FILTERS } from './family-workspace-model';
import { useFamilyWorkspaceController } from './use-family-workspace-controller';

export default function FamilyWorkspaceScreen() {
  const screen = useFamilyWorkspaceController();

  if (screen.status === 'loading') {
    return (
      <>
        <Stack.Screen options={{ title: 'Family Workspace' }} />
        <View
          style={[
            baseStyles.container,
            styles.center,
            { paddingBottom: screen.insets.bottom + spacing.xl },
          ]}
        >
          <Text style={baseStyles.textSecondary}>
            {screen.error ??
              (screen.client ? 'Loading family workspace…' : 'Connect to gateway to load family.')}
          </Text>
          <Pressable style={styles.backFallbackButton} onPress={screen.goBackOrRuns}>
            <Text style={styles.backFallbackText}>Back to runs</Text>
          </Pressable>
        </View>
      </>
    );
  }

  const {
    snapshot,
    error,
    insets,
    stickyNavVisible,
    navLayout,
    stickyNavStyle,
    scrollRef,
    scrollHandler,
    workspaceNavProps,
    workflowColor,
    familyRetrospectives,
    pendingRetrospectiveCount,
    retrospectiveRouteContext,
    openPRForRun,
    selectedActiveTaskProgress,
    selectedFallbackTaskProgress,
    readyDecision,
    reviewGateDecision,
    retroDecision,
    selectedRecipeAvailable,
    selectedDiffValue,
    recipeEvidenceForRun,
    recipeCountForRun,
    recipeAvailableForRun,
    decisionRouteContextForRun,
    workspaceRecipeRunForRun,
    focusedArtifactForRun,
    focusedArtifactParamsForRun,
    recipeWorkspaceParamsForRun,
    openFamilyRunDiff,
    openSelectedRunDiff,
    priorityVisualPairs,
    priorityVisualPair,
    priorityVisualPairIsRecipe,
    priorityCompareRecipeRunId,
    gatewayUrl,
    artifactAuthHeaders,
    viewerUri,
    setViewerUri,
    documentViewer,
    setDocumentViewer,
    evidenceFilter,
    setEvidenceFilter,
    rememberNavLayout,
    router,
    requestedRecipeRunId,
    requestedArtifactPath,
    selectedRun,
    selectedFullRun,
    selectedRecipeRuns,
    selectedRecipeArtifactCount,
    visualPairs,
    filteredEvidenceGroups,
    evidenceCounts,
    taskProgressError,
    targetRouteContext,
    diffRouteContext,
    artifactRouteContext,
    openDocument,
    openDiffArtifact,
    openFamilyRecipeArtifact,
    openFamilyArtifactWorkspace,
    rememberSection,
    scrollToSection,
    visualViewerItems,
    viewerIndex,
  } = screen;

  return (
    <>
      <Stack.Screen options={{ title: 'Family Workspace' }} />
      <View style={baseStyles.container}>
        <Animated.View
          pointerEvents={stickyNavVisible && navLayout !== null ? 'auto' : 'none'}
          style={[styles.stickyWorkspaceNav, stickyNavStyle]}
        >
          <RunWorkspaceNav {...workspaceNavProps} />
        </Animated.View>
        <Animated.ScrollView
          ref={scrollRef}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          contentContainerStyle={[
            styles.scrollContent,
            {
              paddingBottom: styles.scrollContent.paddingBottom + insets.bottom,
            },
          ]}
        >
          <View style={styles.headerCard}>
            <View style={styles.headerRow}>
              <View style={[styles.statusBadge, { borderColor: workflowColor }]}>
                <Text style={[styles.statusText, { color: workflowColor }]}>
                  {snapshot.workflowState}
                </Text>
              </View>
              <Text style={styles.generatedText}>{formatDateTime(snapshot.generatedAt)}</Text>
            </View>
            <Text style={styles.title}>{snapshot.familyRootTicketOrPr}</Text>
            <Text style={baseStyles.textSecondary}>{snapshot.summary}</Text>
            <View style={styles.metricGrid}>
              <Metric label="Runs" value={String(snapshot.familyRunCount)} />
              <Metric label="Active" value={String(snapshot.activeRunCount)} />
              <Metric
                label="Evidence files"
                value={String(snapshot.evidence.length)}
                onPress={() => scrollToSection('evidence')}
              />
              <Metric
                label="Before→After"
                value={String(visualPairs.length)}
                onPress={() => scrollToSection('compare')}
                disabled={visualPairs.length === 0}
              />
              <Metric
                label="Diff view"
                value={
                  snapshot.diffStat.available
                    ? `+${snapshot.diffStat.additions} -${snapshot.diffStat.deletions}`
                    : 'none'
                }
                onPress={() => scrollToSection('ledger')}
                disabled={!snapshot.diffStat.available}
              />
              <Metric
                label="Retrospectives"
                value={`${pendingRetrospectiveCount}/${familyRetrospectives.length}`}
                onPress={() => scrollToSection('retros')}
                disabled={familyRetrospectives.length === 0}
              />
              <Metric
                label="Recipe quality"
                value={`${snapshot.recipeQuality.semantic}${
                  snapshot.recipeQuality.score != null ? ` · ${snapshot.recipeQuality.score}` : ''
                }`}
                onPress={() => {
                  if (!selectedRun) return;
                  const recipeTarget = recipeWorkspaceParam(
                    workspaceRecipeRunForRun(selectedRun.runId),
                  );
                  const focusedArtifact = focusedArtifactForRun(selectedRun.runId);
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: selectedRun.runId,
                      ...targetRouteContext('recipe'),
                      recipeRun: recipeTarget,
                      filter: artifactFilterParamForWorkspaceNav('recipe'),
                      ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifact)
                        ? { artifact: focusedArtifact }
                        : {}),
                    },
                  });
                }}
                disabled={!selectedRun || selectedRecipeAvailable === false}
              />
            </View>
          </View>

          <View onLayout={rememberNavLayout}>
            <RunWorkspaceNav {...workspaceNavProps} />
          </View>

          {selectedRun && requestedArtifactPath ? (
            <FamilyFocusedArtifactCard
              artifactPath={requestedArtifactPath}
              recipeRunId={requestedRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM}
              prNumber={selectedRun.prNumber}
              onOpenRun={() =>
                router.push({
                  pathname: '/run/[id]',
                  params: {
                    id: selectedRun.runId,
                    ...targetRouteContext('run'),
                    recipeRun: requestedRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    artifact: requestedArtifactPath,
                  },
                })
              }
              onOpenRecipe={() => {
                const recipeRunTarget = recipeWorkspaceParam(requestedRecipeRunId);
                router.push({
                  pathname: '/artifacts/[runId]',
                  params: {
                    runId: selectedRun.runId,
                    ...targetRouteContext('recipe'),
                    recipeRun: recipeRunTarget,
                    filter: artifactFilterParamForWorkspaceNav('recipe'),
                    ...(shouldPreserveArtifactForRecipeContext(
                      recipeRunTarget,
                      requestedArtifactPath,
                    )
                      ? { artifact: requestedArtifactPath }
                      : {}),
                  },
                });
              }}
              onOpenArtifact={() =>
                openFamilyArtifactWorkspace(selectedRun.runId, requestedArtifactPath)
              }
              onOpenFiles={() =>
                openFamilyArtifactWorkspace(selectedRun.runId, requestedArtifactPath)
              }
              onOpenDiff={() => openFamilyRunDiff(selectedRun)}
              comparePairCount={priorityVisualPairs.length}
              onOpenCompare={() => {
                if (!priorityVisualPair) return;
                if (!priorityVisualPairIsRecipe) {
                  scrollToSection('compare');
                  return;
                }
                router.push({
                  pathname: '/artifacts/[runId]',
                  params: {
                    runId: selectedRun.runId,
                    ...targetRouteContext('compare'),
                    recipeRun: priorityCompareRecipeRunId,
                    filter: artifactFilterParamForWorkspaceNav('compare'),
                    artifact: priorityVisualPair.after.path,
                  },
                });
              }}
              onOpenSlot={() => {
                if (!selectedRun.slotId) return;
                router.push({
                  pathname: '/slot/[id]',
                  params: {
                    id: selectedRun.slotId,
                    ...targetRouteContext('slot'),
                    runId: selectedRun.runId,
                    recipeRun: requestedRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    artifact: requestedArtifactPath,
                  },
                });
              }}
              onOpenTerminal={() => {
                if (!selectedRun.slotId) return;
                router.push({
                  pathname: '/terminal/[slotId]',
                  params: {
                    slotId: selectedRun.slotId,
                    ...targetRouteContext('terminal'),
                    runId: selectedRun.runId,
                    details: '1',
                    recipeRun: requestedRecipeRunId || DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    artifact: requestedArtifactPath,
                  },
                });
              }}
              onOpenPR={() => {
                if (!selectedRun.prNumber) return;
                const prRepo = prRepoFromWorkspaceSource(selectedRun, selectedRun.prNumber);
                router.push({
                  pathname: '/(tabs)/prs',
                  params: {
                    pr: String(selectedRun.prNumber),
                    ...targetRouteContext('pr'),
                    ...(prRepo ? { repo: prRepo } : {}),
                  },
                });
              }}
              slotAvailable={Boolean(selectedRun.slotId)}
            />
          ) : null}

          {priorityVisualPair ? (
            <FamilyBeforeAfterPriorityPanel
              pair={priorityVisualPair}
              pairCount={priorityVisualPairs.length}
              authHeaders={artifactAuthHeaders}
              recipeFallback={priorityVisualPairIsRecipe}
              artifactCount={snapshot.evidence.length}
              recipeArtifactCount={selectedRecipeArtifactCount}
              recipeAvailable={selectedRecipeAvailable}
              diffValue={
                selectedRun
                  ? selectedDiffValue
                  : snapshot.diffStat.available
                    ? `+${snapshot.diffStat.additions} -${snapshot.diffStat.deletions}`
                    : 'none'
              }
              slotId={selectedRun?.slotId}
              prNumber={selectedRun?.prNumber ?? snapshot.latestPrNumber}
              onOpenArtifact={(artifactPath) => {
                const target = [priorityVisualPair.before, priorityVisualPair.after].find(
                  (artifact) => artifact.path === artifactPath,
                );
                if (!target) return;
                if (priorityVisualPairIsRecipe) {
                  if (!selectedRun) return;
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: selectedRun.runId,
                      ...targetRouteContext('compare'),
                      recipeRun: priorityCompareRecipeRunId,
                      filter: artifactFilterParamForWorkspaceNav('compare'),
                      artifact: target.path,
                    },
                  });
                  return;
                }
                openFamilyArtifactWorkspace(
                  (target as FamilyObservabilityArtifact).runId,
                  target.path,
                );
              }}
              onOpenCompare={() => {
                if (!priorityVisualPairIsRecipe) {
                  scrollToSection('compare');
                  return;
                }
                if (!selectedRun) return;
                router.push({
                  pathname: '/artifacts/[runId]',
                  params: {
                    runId: selectedRun.runId,
                    ...targetRouteContext('compare'),
                    recipeRun: priorityCompareRecipeRunId,
                    filter: artifactFilterParamForWorkspaceNav('compare'),
                    artifact: priorityVisualPair.after.path,
                  },
                });
              }}
              onOpenEvidence={() => {
                if (selectedRun) {
                  openFamilyArtifactWorkspace(selectedRun.runId);
                  return;
                }
                scrollToSection('evidence');
              }}
              onOpenRecipe={() => {
                if (!selectedRun) return;
                router.push({
                  pathname: '/artifacts/[runId]',
                  params: {
                    runId: selectedRun.runId,
                    ...targetRouteContext('recipe'),
                    ...recipeWorkspaceParamsForRun(selectedRun),
                    filter: artifactFilterParamForWorkspaceNav('recipe'),
                  },
                });
              }}
              onOpenDiff={() => {
                if (selectedRun) {
                  openSelectedRunDiff();
                  return;
                }
                scrollToSection('ledger');
              }}
              onOpenRun={() => {
                if (!selectedRun) return;
                router.push({
                  pathname: '/run/[id]',
                  params: {
                    id: selectedRun.runId,
                    ...targetRouteContext('run'),
                    recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                    ...focusedArtifactParamsForRun(selectedRun.runId),
                  },
                });
              }}
              onOpenRetros={() => scrollToSection('retros')}
              onOpenTerminal={() => {
                if (!selectedRun?.slotId) return;
                router.push({
                  pathname: '/terminal/[slotId]',
                  params: {
                    slotId: selectedRun.slotId,
                    ...targetRouteContext('terminal'),
                    runId: selectedRun.runId,
                    details: '1',
                    recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                    ...focusedArtifactParamsForRun(selectedRun.runId),
                  },
                });
              }}
              onOpenPR={() => {
                if (!selectedRun) return;
                openPRForRun(selectedRun);
              }}
            />
          ) : null}

          <FamilyWorkspaceCockpit
            selectedRun={selectedRun}
            readyDecisionId={readyDecision?.id ?? null}
            reviewDecisionId={reviewGateDecision?.id ?? null}
            retroDecisionId={retroDecision?.id ?? null}
            evidenceCount={snapshot.evidence.length}
            visualPairCount={priorityVisualPairs.length}
            ledgerEntryCount={snapshot.familyChangeLedger?.entries.length ?? 0}
            retrospectiveCount={familyRetrospectives.length}
            pendingRetrospectiveCount={pendingRetrospectiveCount}
            recipeArtifactCount={selectedRecipeArtifactCount}
            recipeAvailable={selectedRecipeAvailable}
            recipeScopeLabel={recipeWorkspaceScopeLabel(
              selectedRun ? workspaceRecipeRunForRun(selectedRun.runId) : null,
            )}
            diffValue={selectedRun ? selectedDiffValue : 'none'}
            onJumpFocus={() => scrollToSection('focus')}
            onJumpCompare={() => {
              if (!priorityVisualPairIsRecipe) {
                scrollToSection('compare');
                return;
              }
              if (!selectedRun || !priorityVisualPair) return;
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: selectedRun.runId,
                  ...targetRouteContext('compare'),
                  recipeRun: priorityCompareRecipeRunId,
                  filter: artifactFilterParamForWorkspaceNav('compare'),
                  artifact: priorityVisualPair.after.path,
                },
              });
            }}
            onJumpLedger={() => scrollToSection('ledger')}
            onJumpRetros={() => scrollToSection('retros')}
            onJumpEvidence={() => scrollToSection('evidence')}
            onJumpRuns={() => scrollToSection('runs')}
            onOpenRun={() => {
              if (!selectedRun) return;
              const contextRecipeRun = workspaceRecipeRunForRun(selectedRun.runId);
              router.push({
                pathname: '/run/[id]',
                params: {
                  id: selectedRun.runId,
                  ...targetRouteContext('run'),
                  recipeRun: contextRecipeRun,
                  ...focusedArtifactParamsForRun(selectedRun.runId),
                },
              });
            }}
            onOpenArtifacts={() => {
              if (!selectedRun) return;
              const contextRecipeRun = workspaceRecipeRunForRun(selectedRun.runId);
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: selectedRun.runId,
                  ...artifactRouteContext(
                    contextRecipeRun,
                    contextRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                      ? artifactFilterParamForWorkspaceNav('recipe')
                      : artifactFilterParamForWorkspaceNav('review'),
                  ),
                  recipeRun: contextRecipeRun,
                  filter:
                    contextRecipeRun !== DECISION_EVIDENCE_RECIPE_RUN_PARAM
                      ? artifactFilterParamForWorkspaceNav('recipe')
                      : artifactFilterParamForWorkspaceNav('review'),
                  ...focusedArtifactParamsForRun(selectedRun.runId),
                },
              });
            }}
            onOpenRecipe={() => {
              if (!selectedRun) return;
              const recipeTarget = recipeWorkspaceParam(
                workspaceRecipeRunForRun(selectedRun.runId),
              );
              const focusedArtifact = focusedArtifactForRun(selectedRun.runId);
              router.push({
                pathname: '/artifacts/[runId]',
                params: {
                  runId: selectedRun.runId,
                  ...targetRouteContext('recipe'),
                  recipeRun: recipeTarget,
                  filter: artifactFilterParamForWorkspaceNav('recipe'),
                  ...(shouldPreserveArtifactForRecipeContext(recipeTarget, focusedArtifact)
                    ? { artifact: focusedArtifact }
                    : {}),
                },
              });
            }}
            onOpenDiff={() => {
              openSelectedRunDiff();
            }}
            onOpenSlot={() => {
              if (!selectedRun?.slotId) return;
              const contextRecipeRun = workspaceRecipeRunForRun(selectedRun.runId);
              router.push({
                pathname: '/slot/[id]',
                params: {
                  id: selectedRun.slotId,
                  ...targetRouteContext('slot'),
                  runId: selectedRun.runId,
                  recipeRun: contextRecipeRun,
                  ...focusedArtifactParamsForRun(selectedRun.runId),
                },
              });
            }}
            onOpenPR={() => {
              if (!selectedRun) return;
              openPRForRun(selectedRun);
            }}
            onOpenTerminal={() => {
              if (!selectedRun?.slotId) return;
              const contextRecipeRun = workspaceRecipeRunForRun(selectedRun.runId);
              router.push({
                pathname: '/terminal/[slotId]',
                params: {
                  slotId: selectedRun.slotId,
                  ...targetRouteContext('terminal'),
                  runId: selectedRun.runId,
                  details: '1',
                  recipeRun: contextRecipeRun,
                  ...focusedArtifactParamsForRun(selectedRun.runId),
                },
              });
            }}
            onOpenDecision={(decisionId) => {
              if (!selectedRun) return;
              const contextRecipeRun = workspaceRecipeRunForRun(selectedRun.runId);
              router.push({
                pathname: '/decision/[id]',
                params: {
                  id: decisionId,
                  ...decisionRouteContextForRun(selectedRun, decisionId),
                  runId: selectedRun.runId,
                  recipeRun: contextRecipeRun,
                  ...focusedArtifactParamsForRun(selectedRun.runId),
                },
              });
            }}
          />
          {selectedRun ? (
            <View onLayout={rememberSection('focus')}>
              <FamilyRunWorkspaceCard
                run={selectedRun}
                activeRunId={selectedRun.runId}
                onFocusRun={() =>
                  router.setParams({
                    familyId: snapshot.familyId,
                    runId: selectedRun.runId,
                  })
                }
                onOpenRun={() =>
                  router.push({
                    pathname: '/run/[id]',
                    params: {
                      id: selectedRun.runId,
                      ...targetRouteContext('run'),
                      recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                      ...focusedArtifactParamsForRun(selectedRun.runId),
                    },
                  })
                }
                onOpenArtifacts={() =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: selectedRun.runId,
                      ...artifactRouteContext(
                        workspaceRecipeRunForRun(selectedRun.runId),
                        workspaceRecipeRunForRun(selectedRun.runId) !==
                          DECISION_EVIDENCE_RECIPE_RUN_PARAM
                          ? artifactFilterParamForWorkspaceNav('recipe')
                          : artifactFilterParamForWorkspaceNav('review'),
                      ),
                      recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                      filter:
                        workspaceRecipeRunForRun(selectedRun.runId) !==
                        DECISION_EVIDENCE_RECIPE_RUN_PARAM
                          ? artifactFilterParamForWorkspaceNav('recipe')
                          : artifactFilterParamForWorkspaceNav('review'),
                      ...focusedArtifactParamsForRun(selectedRun.runId),
                    },
                  })
                }
                onOpenArtifact={(artifactPath) =>
                  openFamilyArtifactWorkspace(selectedRun.runId, artifactPath)
                }
                gatewayUrl={gatewayUrl}
                artifactAuthHeaders={artifactAuthHeaders}
                recipeArtifactCount={selectedRecipeArtifactCount}
                recipeAvailable={selectedRecipeAvailable}
                selectedFullRun={selectedFullRun}
                activeTaskProgress={selectedActiveTaskProgress}
                fallbackTaskProgress={selectedFallbackTaskProgress}
                taskProgressError={taskProgressError}
                recipeRuns={selectedRecipeRuns}
                onOpenVisual={setViewerUri}
                onOpenDocument={openDocument}
                onOpenDiffArtifact={openDiffArtifact}
                onOpenRecipe={() =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: selectedRun.runId,
                      ...targetRouteContext('recipe'),
                      recipeRun: recipeWorkspaceParam(workspaceRecipeRunForRun(selectedRun.runId)),
                      filter: artifactFilterParamForWorkspaceNav('recipe'),
                      ...(shouldPreserveArtifactForRecipeContext(
                        recipeWorkspaceParam(workspaceRecipeRunForRun(selectedRun.runId)),
                        focusedArtifactForRun(selectedRun.runId),
                      )
                        ? { artifact: focusedArtifactForRun(selectedRun.runId) }
                        : {}),
                    },
                  })
                }
                onOpenRecipeArtifact={(recipeRunId, artifactPath, filterParam) =>
                  openFamilyRecipeArtifact(
                    selectedRun.runId,
                    recipeRunId,
                    artifactPath,
                    filterParam,
                  )
                }
                onOpenDiff={() => openSelectedRunDiff()}
                onOpenTerminal={() => {
                  if (!selectedRun.slotId) return;
                  router.push({
                    pathname: '/terminal/[slotId]',
                    params: {
                      slotId: selectedRun.slotId,
                      ...targetRouteContext('terminal'),
                      runId: selectedRun.runId,
                      details: '1',
                      recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                      ...focusedArtifactParamsForRun(selectedRun.runId),
                    },
                  });
                }}
                onOpenSlot={() => {
                  if (!selectedRun.slotId) return;
                  router.push({
                    pathname: '/slot/[id]',
                    params: {
                      id: selectedRun.slotId,
                      ...targetRouteContext('slot'),
                      runId: selectedRun.runId,
                      recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                      ...focusedArtifactParamsForRun(selectedRun.runId),
                    },
                  });
                }}
                onOpenPR={() => openPRForRun(selectedRun)}
                onOpenDecision={(decisionId) =>
                  router.push({
                    pathname: '/decision/[id]',
                    params: {
                      id: decisionId,
                      ...decisionRouteContextForRun(selectedRun, decisionId),
                      runId: selectedRun.runId,
                      recipeRun: workspaceRecipeRunForRun(selectedRun.runId),
                      ...focusedArtifactParamsForRun(selectedRun.runId),
                    },
                  })
                }
              />
            </View>
          ) : null}

          <View onLayout={rememberSection('compare')}>
            <FamilyComparePanel
              pairs={priorityVisualPairs}
              recipeFallback={priorityVisualPairIsRecipe}
              artifactAuthHeaders={artifactAuthHeaders}
              onOpenVisual={setViewerUri}
              onOpenArtifactWorkspace={(artifactValue) => {
                if (priorityVisualPairIsRecipe) {
                  if (!selectedRun) return;
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: selectedRun.runId,
                      ...targetRouteContext('compare'),
                      recipeRun: priorityCompareRecipeRunId,
                      filter: artifactFilterParamForWorkspaceNav('compare'),
                      artifact: artifactValue.path,
                    },
                  });
                  return;
                }
                if (!artifactValue.runId) return;
                openFamilyArtifactWorkspace(artifactValue.runId, artifactValue.path);
              }}
              onOpenArtifacts={() => {
                if (!selectedRun) return;
                router.push({
                  pathname: '/artifacts/[runId]',
                  params: {
                    runId: selectedRun.runId,
                    ...targetRouteContext('compare'),
                    recipeRun: priorityVisualPairIsRecipe
                      ? priorityCompareRecipeRunId
                      : DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    filter: artifactFilterParamForWorkspaceNav('compare'),
                    ...(priorityVisualPairIsRecipe && priorityVisualPair
                      ? { artifact: priorityVisualPair.after.path }
                      : {}),
                  },
                });
              }}
            />
          </View>

          <View onLayout={rememberSection('ledger')}>
            <FamilyChangeLedgerPanel
              snapshot={snapshot}
              onOpenRun={(runIdValue) =>
                router.push({
                  pathname: '/run/[id]',
                  params: {
                    id: runIdValue,
                    ...targetRouteContext('run'),
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                })
              }
              onOpenArtifacts={openFamilyArtifactWorkspace}
              onOpenDiff={(entry, artifactPath) =>
                router.push({
                  pathname: '/diff/[runId]',
                  params: {
                    runId: entry.runId,
                    ...diffRouteContext(),
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    ...(artifactPath ? { path: artifactPath } : {}),
                  },
                })
              }
              onOpenSlot={(slotIdValue, runIdValue) =>
                router.push({
                  pathname: '/slot/[id]',
                  params: {
                    id: slotIdValue,
                    ...targetRouteContext('slot'),
                    runId: runIdValue,
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                })
              }
              onOpenTerminal={(slotIdValue, runIdValue) =>
                router.push({
                  pathname: '/terminal/[slotId]',
                  params: {
                    slotId: slotIdValue,
                    ...targetRouteContext('terminal'),
                    runId: runIdValue,
                    details: '1',
                    recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                  },
                })
              }
            />
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <View style={styles.section} onLayout={rememberSection('retros')}>
            <View style={styles.sectionHeader}>
              <View>
                <Text style={styles.sectionTitle}>Retrospectives</Text>
                <Text style={styles.sectionMeta}>
                  {pendingRetrospectiveCount} pending · {familyRetrospectives.length} total
                </Text>
              </View>
            </View>
            <Text style={styles.evidenceNote}>
              Pending and recorded retrospectives across this family, newest first. Open the retro,
              artifacts, recipe, diff, slot, or terminal directly from each run.
            </Text>
            {familyRetrospectives.length === 0 ? (
              <Text style={baseStyles.textMuted}>
                No retrospectives have been recorded for this family yet.
              </Text>
            ) : (
              familyRetrospectives.map(({ run, decision }) => (
                <RetrospectiveCard
                  key={decision.id}
                  run={run}
                  decision={decision}
                  recipeEvidence={recipeEvidenceForRun(run)}
                  recipeArtifactCount={recipeCountForRun(run)}
                  recipeAvailable={recipeAvailableForRun(run)}
                  gatewayUrl={gatewayUrl}
                  artifactAuthHeaders={artifactAuthHeaders}
                  onOpenVisual={setViewerUri}
                  onOpenDocument={openDocument}
                  onOpenDiffArtifact={(artifact) =>
                    openDiffArtifact(artifact, retrospectiveRouteContext)
                  }
                  onOpenDecision={() =>
                    router.push({
                      pathname: '/decision/[id]',
                      params: {
                        id: decision.id,
                        ...decisionWorkspaceRouteParams('retrospective'),
                        runId: run.runId,
                        recipeRun: workspaceRecipeRunForRun(run.runId),
                        ...focusedArtifactParamsForRun(run.runId),
                      },
                    })
                  }
                  onOpenRun={() =>
                    router.push({
                      pathname: '/run/[id]',
                      params: {
                        id: run.runId,
                        ...retrospectiveRouteContext,
                        recipeRun: workspaceRecipeRunForRun(run.runId),
                        ...focusedArtifactParamsForRun(run.runId),
                      },
                    })
                  }
                  onOpenArtifacts={() =>
                    router.push({
                      pathname: '/artifacts/[runId]',
                      params: {
                        runId: run.runId,
                        ...retrospectiveRouteContext,
                        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                        filter:
                          artifactFilterParamForArtifactPath(focusedArtifactForRun(run.runId)) ??
                          artifactFilterParamForWorkspaceNav('review'),
                        ...focusedArtifactParamsForRun(run.runId),
                      },
                    })
                  }
                  onOpenArtifact={(artifactPath) =>
                    openFamilyArtifactWorkspace(run.runId, artifactPath, retrospectiveRouteContext)
                  }
                  onOpenRecipe={() =>
                    router.push({
                      pathname: '/artifacts/[runId]',
                      params: {
                        runId: run.runId,
                        ...retrospectiveRouteContext,
                        ...recipeWorkspaceParamsForRun(run),
                        filter: artifactFilterParamForWorkspaceNav('recipe'),
                      },
                    })
                  }
                  onOpenRecipeCompare={(artifactPath) => {
                    const recipeEvidence = recipeEvidenceForRun(run);
                    router.push({
                      pathname: '/artifacts/[runId]',
                      params: {
                        runId: run.runId,
                        ...retrospectiveRouteContext,
                        recipeRun:
                          recipeEvidence?.recipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                        filter: artifactFilterParamForWorkspaceNav('compare'),
                        ...((artifactPath ?? recipeEvidence?.artifactPath)
                          ? {
                              artifact: artifactPath ?? recipeEvidence?.artifactPath,
                            }
                          : {}),
                      },
                    });
                  }}
                  onOpenDiff={() => openFamilyRunDiff(run, retrospectiveRouteContext)}
                  onOpenTerminal={() => {
                    if (!run.slotId) return;
                    router.push({
                      pathname: '/terminal/[slotId]',
                      params: {
                        slotId: run.slotId,
                        ...retrospectiveRouteContext,
                        runId: run.runId,
                        details: '1',
                        recipeRun: workspaceRecipeRunForRun(run.runId),
                        ...focusedArtifactParamsForRun(run.runId),
                      },
                    });
                  }}
                  onOpenSlot={() => {
                    if (!run.slotId) return;
                    router.push({
                      pathname: '/slot/[id]',
                      params: {
                        id: run.slotId,
                        ...retrospectiveRouteContext,
                        runId: run.runId,
                        recipeRun: workspaceRecipeRunForRun(run.runId),
                        ...focusedArtifactParamsForRun(run.runId),
                      },
                    });
                  }}
                  onOpenPR={() => openPRForRun(run, retrospectiveRouteContext)}
                />
              ))
            )}
          </View>

          <View style={styles.section} onLayout={rememberSection('evidence')}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Evidence workspace</Text>
              <Text style={styles.sectionMeta}>
                {filteredEvidenceGroups.length} groups · {snapshot.evidence.length} artifacts
                {visualPairs.length > 0
                  ? ` · ${visualPairs.length} pair${visualPairs.length === 1 ? '' : 's'}`
                  : ''}
              </Text>
            </View>
            <View style={styles.filterRow}>
              {EVIDENCE_FILTERS.map((filter) => (
                <Pressable
                  key={filter.id}
                  style={[
                    styles.filterChip,
                    evidenceFilter === filter.id && styles.filterChipActive,
                  ]}
                  onPress={() => setEvidenceFilter(filter.id)}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      evidenceFilter === filter.id && styles.filterChipTextActive,
                    ]}
                  >
                    {filter.label} {evidenceCounts[filter.id]}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.evidenceNote}>
              Grouped by producing run and capture batch. Before/after and video filters match
              Command Center; review, diff, and recipe are mobile quick filters.
            </Text>
            {snapshot.evidence.length === 0 ? (
              <Text style={baseStyles.textMuted}>No family evidence artifacts found.</Text>
            ) : filteredEvidenceGroups.length === 0 ? (
              <Text style={baseStyles.textMuted}>No evidence files match this filter.</Text>
            ) : (
              filteredEvidenceGroups.map((group) => (
                <EvidenceGroupCard
                  key={group.key}
                  group={group}
                  gatewayUrl={gatewayUrl}
                  artifactAuthHeaders={artifactAuthHeaders}
                  onOpenDocument={openDocument}
                  onOpenDiffArtifact={openDiffArtifact}
                  onOpenVisual={setViewerUri}
                  onOpenRun={(runIdValue) =>
                    router.push({
                      pathname: '/run/[id]',
                      params: {
                        id: runIdValue,
                        ...targetRouteContext('run'),
                        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      },
                    })
                  }
                  onOpenArtifacts={openFamilyArtifactWorkspace}
                  onOpenRecipe={(runIdValue) =>
                    router.push({
                      pathname: '/artifacts/[runId]',
                      params: {
                        runId: runIdValue,
                        ...targetRouteContext('recipe'),
                        recipeRun: CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                        filter: artifactFilterParamForWorkspaceNav('recipe'),
                      },
                    })
                  }
                  onOpenDiff={(sourceRun) => openFamilyRunDiff(sourceRun)}
                  onOpenTerminal={(slotIdValue, runIdValue) =>
                    router.push({
                      pathname: '/terminal/[slotId]',
                      params: {
                        slotId: slotIdValue,
                        ...targetRouteContext('terminal'),
                        runId: runIdValue,
                        details: '1',
                        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      },
                    })
                  }
                  onOpenSlot={(slotIdValue, runIdValue) =>
                    router.push({
                      pathname: '/slot/[id]',
                      params: {
                        id: slotIdValue,
                        ...targetRouteContext('slot'),
                        runId: runIdValue,
                        recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      },
                    })
                  }
                />
              ))
            )}
          </View>

          <View style={styles.section} onLayout={rememberSection('runs')}>
            <Text style={styles.sectionTitle}>Family runs</Text>
            {snapshot.runs.map((run) => (
              <RunCard
                key={run.runId}
                run={run}
                active={run.runId === selectedRun?.runId}
                recipeEvidence={recipeEvidenceForRun(run)}
                recipeArtifactCount={recipeCountForRun(run)}
                recipeAvailable={recipeAvailableForRun(run)}
                gatewayUrl={gatewayUrl}
                artifactAuthHeaders={artifactAuthHeaders}
                onFocusRun={() =>
                  router.setParams({
                    familyId: snapshot.familyId,
                    runId: run.runId,
                  })
                }
                onOpenRun={() =>
                  router.push({
                    pathname: '/run/[id]',
                    params: {
                      id: run.runId,
                      ...targetRouteContext('run'),
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  })
                }
                onOpenArtifacts={() =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: run.runId,
                      ...targetRouteContext('artifacts'),
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('review'),
                    },
                  })
                }
                onOpenCompare={(artifactPath) =>
                  openFamilyArtifactWorkspace(run.runId, artifactPath)
                }
                onOpenRecipeCompare={() => {
                  const recipeEvidence = recipeEvidenceForRun(run);
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: run.runId,
                      ...targetRouteContext('compare'),
                      recipeRun: recipeEvidence?.recipeRunId ?? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('compare'),
                      ...(recipeEvidence?.artifactPath
                        ? { artifact: recipeEvidence.artifactPath }
                        : {}),
                    },
                  });
                }}
                onOpenRecipe={() =>
                  router.push({
                    pathname: '/artifacts/[runId]',
                    params: {
                      runId: run.runId,
                      ...targetRouteContext('recipe'),
                      recipeRun: CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
                      filter: artifactFilterParamForWorkspaceNav('recipe'),
                    },
                  })
                }
                onOpenDiff={() => openFamilyRunDiff(run)}
                onOpenDecision={(decisionId) =>
                  router.push({
                    pathname: '/decision/[id]',
                    params: {
                      id: decisionId,
                      ...decisionRouteContextForRun(run, decisionId),
                      runId: run.runId,
                    },
                  })
                }
                onOpenTerminal={() => {
                  if (!run.slotId) return;
                  router.push({
                    pathname: '/terminal/[slotId]',
                    params: {
                      slotId: run.slotId,
                      ...targetRouteContext('terminal'),
                      runId: run.runId,
                      details: '1',
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  });
                }}
                onOpenSlot={() => {
                  if (!run.slotId) return;
                  router.push({
                    pathname: '/slot/[id]',
                    params: {
                      id: run.slotId,
                      ...targetRouteContext('slot'),
                      runId: run.runId,
                      recipeRun: DECISION_EVIDENCE_RECIPE_RUN_PARAM,
                    },
                  });
                }}
                onOpenPR={() => openPRForRun(run)}
              />
            ))}
          </View>

          {snapshot.learnings.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Learnings</Text>
              {snapshot.learnings.slice(0, 6).map((learning) => (
                <View key={learning.id} style={styles.learningCard}>
                  <Text style={styles.learningTitle}>{learning.title}</Text>
                  <Text style={baseStyles.textSecondary}>{learning.summary}</Text>
                </View>
              ))}
            </View>
          )}
        </Animated.ScrollView>
        <MediaViewer
          visible={!!viewerUri}
          uri={viewerUri}
          items={visualViewerItems}
          authHeaders={artifactAuthHeaders}
          initialIndex={viewerIndex}
          onClose={() => setViewerUri(null)}
        />
        <DocumentViewer
          visible={!!documentViewer}
          title={documentViewer?.title ?? ''}
          body={documentViewer?.body ?? ''}
          onClose={() => setDocumentViewer(null)}
        />
      </View>
    </>
  );
}
