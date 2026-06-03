import type {
  DispatchQueueAddResult,
  EvalExperimentCreateResult,
  EvalSuiteCapUpdateResult,
  EvalTaskProfile,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import {
  buildEvalCellQueueRequest,
  type CandidateTemplateChoice,
  mockPackageSourceFromExperimentSource,
  trialIdForCell,
} from './eval-cockpit-model.js';
import type { CandidateRow } from './eval-cockpit-url-state.js';
import { type EvalSelectedCase, stableIdHash } from './eval-suite-helpers.js';
import { buildLaunchCells, type EvalLaunchCell } from './eval-suite-launch-model.js';

interface EvalCockpitLaunchCallbacks {
  candidateLabel: (row: CandidateRow) => string;
  slotCapForLaunch: (capGroupId: string) => Promise<number>;
  candidateTemplateChoices: (taskProfile: EvalTaskProfile) => CandidateTemplateChoice[];
  getSuiteCells: () => readonly EvalLaunchCell[];
  setError: (message: string) => void;
  setBusy: (message: string) => void;
  setSuiteCapGroupId: (capGroupId: string) => void;
  setSuiteCells: (cells: EvalLaunchCell[]) => void;
  patchSuiteCell: (cellId: string, patch: Partial<EvalLaunchCell>) => void;
  clearEvalPackageSnapshots: () => void;
  resetAppendResults: () => void;
  resetEvalResultsByCase: () => void;
  setEvalResult: (result: EvalExperimentCreateResult) => void;
  recordEvalResultForCase: (selectionId: string, result: EvalExperimentCreateResult) => void;
  markSlotCapSynced: (capGroupId: string) => void;
}

export interface EvalCockpitLaunchLocalSuiteOptions extends EvalCockpitLaunchCallbacks {
  mock: boolean;
  project: string;
  evalResultOverride: EvalExperimentCreateResult | null;
  selectedCases: readonly EvalSelectedCase[];
  rows: readonly CandidateRow[];
  datasetId: string;
  capGroupId: string;
}

function mockExperimentForCase(
  selectedCase: EvalSelectedCase,
  datasetId: string,
  evalResultOverride: EvalExperimentCreateResult | null,
): EvalExperimentCreateResult {
  if (!evalResultOverride) throw new Error('Mock cockpit has no experiment result override');
  const experimentId = `mock-${selectedCase.datasetItemId}`;
  return {
    ...evalResultOverride,
    experimentId,
    experimentKey: `${datasetId}-${selectedCase.datasetItemId}`,
    familyId: evalResultOverride.familyId,
    experimentManifestPath: `/tmp/farmslot/evals/${experimentId}/artifacts/experiment-manifest.json`,
    referencePackagePath: evalResultOverride.referencePackagePath,
    experimentManifest: {
      ...evalResultOverride.experimentManifest,
      experimentId,
      experimentKey: `${datasetId}-${selectedCase.datasetItemId}`,
      datasetId,
      datasetItemId: selectedCase.datasetItemId,
      case: {
        ...evalResultOverride.experimentManifest.case,
        caseId: selectedCase.datasetItemId,
        source: mockPackageSourceFromExperimentSource(selectedCase.source),
        taskProfile: selectedCase.taskProfile,
        label: selectedCase.label,
        objectiveHash: selectedCase.objectiveHash,
      },
    },
  };
}

function mockPatchForCell(
  options: Pick<EvalCockpitLaunchLocalSuiteOptions, 'getSuiteCells' | 'patchSuiteCell'>,
  selectedCase: EvalSelectedCase,
  row: CandidateRow,
  cellId: string,
  datasetId: string,
): void {
  const deduped = row.id === 'control';
  const packageId = `mock-pkg-${stableIdHash(`${datasetId}|${selectedCase.datasetItemId}|${row.id}`)}`;
  options.patchSuiteCell(cellId, {
    status: deduped ? 'deduped' : 'final',
    deduped,
    experimentId: `mock-${selectedCase.datasetItemId}`,
    experimentManifestPath: `/tmp/farmslot/evals/mock-${datasetId}/artifacts/experiment-manifest.json`,
    trialId: `mock-trial-${row.id}`,
    runId: `mock-run-${row.id}-${selectedCase.datasetItemId}`.slice(0, 48),
    packageId,
    packagePath: `/tmp/farmslot/evals/mock-${datasetId}/artifacts/packages/${packageId}.json`,
    packageStatus: 'final',
    durationMs: deduped
      ? 0
      : 420_000 + options.getSuiteCells().findIndex((cell) => cell.cellId === cellId) * 60_000,
    costEstimate: deduped ? 0 : 2.25,
    validationEvidenceCount: deduped ? 1 : 2,
    visualEvidenceCount: row.id === 'challenger' ? 1 : 0,
    reviewEvidenceCount: 0,
    missingData: deduped ? [] : ['visual-evidence-missing'],
  });
}

export async function launchEvalCockpitLocalSuite(
  options: EvalCockpitLaunchLocalSuiteOptions,
): Promise<void> {
  options.setError('');
  if (!options.selectedCases.length) {
    options.setError('Add at least one case to the basket');
    return;
  }
  if (!options.rows.length) {
    options.setError('Enable at least one candidate strategy');
    return;
  }
  options.setSuiteCapGroupId(options.capGroupId);
  options.setSuiteCells(
    buildLaunchCells(
      options.selectedCases,
      options.rows.map((row) => ({
        id: row.id,
        label: options.candidateLabel(row),
        enabled: row.enabled,
      })),
    ),
  );
  options.clearEvalPackageSnapshots();
  options.resetAppendResults();
  options.resetEvalResultsByCase();
  try {
    if (!options.mock) {
      try {
        const capForLaunch = await options.slotCapForLaunch(options.capGroupId);
        await gateway.request<EvalSuiteCapUpdateResult>(
          Methods.EVAL_SUITE_CAP_UPDATE,
          {
            capGroupId: options.capGroupId,
            suiteId: options.datasetId,
            cap: capForLaunch,
          },
          30_000,
        );
        options.markSlotCapSynced(options.capGroupId);
      } catch (error) {
        const message = `Slot cap sync failed: ${error instanceof Error ? error.message : String(error)}`;
        options.setError(message);
        options.setSuiteCells(
          options.getSuiteCells().map((cell) => ({
            ...cell,
            status: 'error',
            error: message,
          })),
        );
        return;
      }
    }
    for (const selectedCase of options.selectedCases) {
      const caseCells = options
        .getSuiteCells()
        .filter((cell) => cell.caseSelectionId === selectedCase.selectionId);
      for (const cell of caseCells) options.patchSuiteCell(cell.cellId, { status: 'creating' });
      let evalResult: EvalExperimentCreateResult;
      try {
        options.setBusy(`Creating experiment for ${selectedCase.label}`);
        if (options.mock) {
          evalResult = mockExperimentForCase(
            selectedCase,
            options.datasetId,
            options.evalResultOverride,
          );
        } else {
          evalResult = await gateway.request<EvalExperimentCreateResult>(
            Methods.EVAL_EXPERIMENT_CREATE,
            {
              project: selectedCase.project || options.project.trim(),
              taskProfile: selectedCase.taskProfile,
              source: selectedCase.source,
              objective: selectedCase.objective || undefined,
              datasetId: options.datasetId,
              datasetItemId: selectedCase.datasetItemId,
            },
            60_000,
          );
        }
        options.setEvalResult(evalResult);
        options.recordEvalResultForCase(selectedCase.selectionId, evalResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const cell of caseCells)
          options.patchSuiteCell(cell.cellId, { status: 'error', error: message });
        continue;
      }

      for (const row of options.rows) {
        const cellId = `${selectedCase.selectionId}:${row.id}`;
        options.patchSuiteCell(cellId, {
          status: 'launching',
          experimentId: evalResult.experimentId,
          experimentManifestPath: evalResult.experimentManifestPath,
        });
        try {
          options.setBusy(`Launching ${options.candidateLabel(row)} for ${selectedCase.label}`);
          if (options.mock) {
            mockPatchForCell(options, selectedCase, row, cellId, options.datasetId);
            continue;
          }
          const trialId = trialIdForCell({
            datasetId: options.datasetId,
            cellId,
            repeat: row.repeat,
            nonce: Date.now(),
          });
          const queueRequest = buildEvalCellQueueRequest({
            selectedCase,
            row,
            primaryCase: options.selectedCases[0],
            choices: options.candidateTemplateChoices(selectedCase.taskProfile),
            projectFallback: options.project,
            evalResult,
            datasetId: options.datasetId,
            capGroupId: options.capGroupId,
            cellId,
            trialId,
          });
          await gateway.request<DispatchQueueAddResult>(
            Methods.DISPATCH_QUEUE_ADD,
            queueRequest,
            60_000,
          );
          options.patchSuiteCell(cellId, {
            status: 'queued',
            experimentId: evalResult.experimentId,
            experimentManifestPath: evalResult.experimentManifestPath,
            trialId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.patchSuiteCell(cellId, { status: 'error', error: message });
        }
      }
    }
  } finally {
    options.setBusy('');
  }
}
