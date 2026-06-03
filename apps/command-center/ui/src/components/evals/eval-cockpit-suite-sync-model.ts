import type { ResultPackageManifest, Run } from '@farmslot/protocol';

import { evalRunTrialMatchesCell, FAILED_RUN_STATUSES } from './eval-cockpit-model.js';
import {
  cellPatchFromPackage,
  type EvalLaunchCell,
  type EvalLaunchCellStatus,
} from './eval-suite-launch-model.js';

export interface EvalPackageSnapshot {
  revision: string;
  pkg: ResultPackageManifest;
  packagePath: string;
}

export interface EvalSuiteCellsSyncInput {
  cells: readonly EvalLaunchCell[];
  runs: readonly Run[];
  packageSnapshots: ReadonlyMap<string, EvalPackageSnapshot>;
}

export interface EvalSuiteCellsSyncResult {
  cells: EvalLaunchCell[];
  packageRunsToLoad: Run[];
}

export function evalRunStatusForLaunchCell(
  run: Run,
  pkg?: ResultPackageManifest,
): EvalLaunchCellStatus {
  if (FAILED_RUN_STATUSES.has(run.status)) return 'failed';
  if (run.status === 'done' || pkg?.status === 'final') return 'final';
  return 'running';
}

export function evalRunMatchesLaunchCell(run: Run, cell: EvalLaunchCell): boolean {
  const evalState = run.engineState?.evalExperiment;
  if (!evalState) return false;
  if (cell.runId && run.id === cell.runId) return true;
  if (evalRunTrialMatchesCell(evalState.trialId, cell.trialId)) return true;
  return false;
}

export function applyEvalPackageToLaunchCells(
  cells: readonly EvalLaunchCell[],
  run: Run,
  pkg: ResultPackageManifest,
  packagePath: string,
): EvalLaunchCell[] {
  return cells.map((cell) => {
    if (!evalRunMatchesLaunchCell(run, cell)) return cell;
    return {
      ...cell,
      status: evalRunStatusForLaunchCell(run, pkg),
      runId: run.id,
      packagePath,
      ...cellPatchFromPackage(pkg),
    };
  });
}

export function syncEvalSuiteCellsFromRuns(
  input: EvalSuiteCellsSyncInput,
): EvalSuiteCellsSyncResult {
  if (!input.cells.length) return { cells: [], packageRunsToLoad: [] };

  const cells = input.cells.map((cell) => {
    const run = input.runs.find((candidate) => evalRunMatchesLaunchCell(candidate, cell));
    if (!run) return cell;
    const packagePath = run.engineState?.evalExperiment?.packagePath;
    const cached = packagePath ? input.packageSnapshots.get(packagePath) : undefined;
    return {
      ...cell,
      status: evalRunStatusForLaunchCell(run, cached?.pkg),
      runId: run.id,
      packagePath: packagePath ?? cell.packagePath,
      ...(cached?.pkg ? cellPatchFromPackage(cached.pkg) : {}),
    };
  });

  const packageRunsToLoad = input.runs.filter((run) =>
    cells.some((cell) => evalRunMatchesLaunchCell(run, cell)),
  );
  return { cells, packageRunsToLoad };
}
