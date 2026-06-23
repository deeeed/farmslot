import {
  type FamilyObservabilityArtifact,
  type FamilyObservabilitySnapshot,
  isRunEvidenceVideoArtifact,
} from '@farmslot/protocol';

import { artifactKind } from '../../utils/artifact-kind.js';
import { acceptanceCriteriaKey, artifactStem } from '../../utils/artifact-pairs.js';

import { comparisonRuns, familyRunLabel } from './family-observability-compare-model.js';

// Cross-run visual evidence matrix: one row per logical screen captured by 2+
// comparison-lane runs, one column per run. Each cell is that run's
// representative capture — the `after` (result) state preferred over `before`,
// then any other capture.
//
// We deliberately include EVERY visual artifact (screenshot/video), not only
// `before`/`after`-marked ones: runs name their captures inconsistently, and a
// run that wrote `ac2-screenshot-banner.png` (classified `setup`) would
// otherwise vanish from the comparison even though it is the same screen as a
// peer's `after-ac2-banner.png`. Non-visual artifacts (reports, .md/.json) are
// excluded.
//
// Screens are keyed by an acceptance-criteria token (e.g. `ac2`) when the
// filename carries one, else by the normalized filename stem. The AC key lines
// up the same screen across runs even when each run named it differently.
//
// A screen captured by only one run can't be compared, so it moves to the
// per-run `uncompared` strip instead of being dropped — nothing disappears.

export interface EvidenceMatrixRun {
  runId: string;
  label: string;
}

export interface EvidenceMatrixCell {
  runId: string;
  artifact: FamilyObservabilityArtifact | null;
  kind: 'image' | 'video' | null;
}

export interface EvidenceMatrixRow {
  stem: string;
  label: string;
  /** Aligned 1:1 with {@link EvidenceMatrix.runs}. */
  cells: EvidenceMatrixCell[];
  /** Number of runs that captured this screen. */
  coverage: number;
}

export interface EvidenceUncomparedArtifact {
  artifact: FamilyObservabilityArtifact;
  kind: 'image' | 'video';
}

export interface EvidenceUncomparedRun {
  runId: string;
  label: string;
  artifacts: EvidenceUncomparedArtifact[];
}

export interface EvidenceMatrix {
  runs: EvidenceMatrixRun[];
  rows: EvidenceMatrixRow[];
  /** Single-run screens that have no cross-run counterpart, grouped per run. */
  uncompared: EvidenceUncomparedRun[];
}

interface RunScreenCaptures {
  before?: FamilyObservabilityArtifact;
  after?: FamilyObservabilityArtifact;
  /** Any capture not marked before/after (e.g. a bare `ac2-screenshot.png`). */
  other?: FamilyObservabilityArtifact;
}

interface ScreenGroup {
  /** Most descriptive stem seen for this screen, used as the row label. */
  displayStem: string;
  perRun: Map<string, RunScreenCaptures>;
}

const EMPTY_MATRIX: EvidenceMatrix = { runs: [], rows: [], uncompared: [] };

function humanizeStem(stem: string): string {
  return stem.replace(/[-_.]+/g, ' ').trim() || stem;
}

function cellKind(artifact: FamilyObservabilityArtifact): 'image' | 'video' {
  return isRunEvidenceVideoArtifact(artifact) ? 'video' : 'image';
}

function isVisualArtifact(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path) || isRunEvidenceVideoArtifact({ path });
}

/** Which capture slot an artifact fills, so we can prefer after > before > other. */
function captureSlot(artifact: FamilyObservabilityArtifact): keyof RunScreenCaptures {
  const kind = artifactKind(artifact.path, artifact.purpose);
  return kind === 'before' ? 'before' : kind === 'after' ? 'after' : 'other';
}

export function buildEvidenceComparisonMatrix(
  snapshot: Pick<FamilyObservabilitySnapshot, 'runs' | 'evidence'> | null,
): EvidenceMatrix {
  if (!snapshot) return EMPTY_MATRIX;
  const runs = comparisonRuns(snapshot);
  if (runs.length < 2) return EMPTY_MATRIX;

  const runIds = new Set(runs.map((run) => run.runId));
  // screenKey -> { displayStem, runId -> { before, after } }
  const byScreen = new Map<string, ScreenGroup>();
  for (const artifact of snapshot.evidence ?? []) {
    if (!isVisualArtifact(artifact.path)) continue;
    const runId = artifact.sourceRunId ?? artifact.runId;
    if (!runIds.has(runId)) continue;
    const stem = artifactStem(artifact.path);
    const key = acceptanceCriteriaKey(artifact.path) ?? stem;
    const group = byScreen.get(key) ?? { displayStem: stem, perRun: new Map() };
    // Prefer the longest stem as the human label (most descriptive screen name).
    if (stem.length > group.displayStem.length) group.displayStem = stem;
    const captures = group.perRun.get(runId) ?? {};
    const slot = captureSlot(artifact);
    // First write wins per slot so a run's canonical 'after' isn't clobbered.
    if (!captures[slot]) captures[slot] = artifact;
    group.perRun.set(runId, captures);
    byScreen.set(key, group);
  }

  const matrixRuns: EvidenceMatrixRun[] = runs.map((run) => ({
    runId: run.runId,
    label: familyRunLabel(run),
  }));
  const labelOf = new Map(matrixRuns.map((run) => [run.runId, run.label]));

  const rows: EvidenceMatrixRow[] = [];
  const uncomparedByRun = new Map<string, EvidenceUncomparedArtifact[]>();
  for (const [key, group] of byScreen) {
    const pick = (runId: string) => {
      const captures = group.perRun.get(runId);
      return captures?.after ?? captures?.before ?? captures?.other ?? null;
    };
    if (group.perRun.size >= 2) {
      const cells: EvidenceMatrixCell[] = matrixRuns.map((run) => {
        const artifact = pick(run.runId);
        return { runId: run.runId, artifact, kind: artifact ? cellKind(artifact) : null };
      });
      rows.push({
        stem: key,
        label: humanizeStem(group.displayStem),
        cells,
        coverage: cells.filter((cell) => cell.artifact != null).length,
      });
      continue;
    }
    // Single-run screen — surface it in that run's uncompared strip.
    const [runId] = [...group.perRun.keys()];
    const artifact = pick(runId);
    if (!artifact) continue;
    const list = uncomparedByRun.get(runId) ?? [];
    list.push({ artifact, kind: cellKind(artifact) });
    uncomparedByRun.set(runId, list);
  }

  rows.sort((a, b) => b.coverage - a.coverage || a.label.localeCompare(b.label));
  const uncompared: EvidenceUncomparedRun[] = matrixRuns
    .filter((run) => uncomparedByRun.has(run.runId))
    .map((run) => ({
      runId: run.runId,
      label: labelOf.get(run.runId) ?? run.runId,
      artifacts: uncomparedByRun.get(run.runId) ?? [],
    }));

  return { runs: matrixRuns, rows, uncompared };
}

/** Artifacts for one matrix row, in run/column order, skipping missing cells. */
export function evidenceRowArtifacts(row: EvidenceMatrixRow): FamilyObservabilityArtifact[] {
  return row.cells
    .map((cell) => cell.artifact)
    .filter((artifact): artifact is FamilyObservabilityArtifact => artifact != null);
}
