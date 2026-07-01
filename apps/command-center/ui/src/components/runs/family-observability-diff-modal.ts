import { html, nothing, type TemplateResult } from 'lit';

import type { FamilyObservabilityArtifact, FamilyObservabilitySnapshot } from '@farmslot/protocol';

import { runArtifactFetchUrl } from '../workspace/workspace-artifacts.js';

import {
  diffSelectionFromFamilyHash,
  familyDiffModalHash,
} from './family-observability-url-state.js';

export interface FamilyDiffModalState {
  title: string;
  artifactUrl: string;
  artifact: FamilyObservabilityArtifact;
}

export type FamilyDiffModalHashAction =
  | { kind: 'none' }
  | { kind: 'close' }
  | { kind: 'open'; label: string; artifact: FamilyObservabilityArtifact };

function diffArtifactScopeTitle(artifact: FamilyObservabilityArtifact, label: string): string {
  if (/^reviewed pr input(?: snapshot)?\b/i.test(label)) {
    return 'Reviewed PR input snapshot';
  }
  if (/^produced code delta\b/i.test(label)) {
    return 'Produced code delta';
  }
  if (artifact.source === 'task-input') {
    return 'Reviewed PR input snapshot';
  }
  if (artifact.source === 'task-artifact') {
    return 'Produced code delta';
  }
  return 'Diff artifact';
}

export function familyDiffModalState(
  label: string,
  artifact: FamilyObservabilityArtifact,
): FamilyDiffModalState {
  const filename = artifact.path.split('/').pop() ?? artifact.path;
  const scopeTitle = diffArtifactScopeTitle(artifact, label);
  const normalizedLabel = label
    .replace(/^reviewed pr input(?: snapshot)?\s*[·-]?\s*/i, '')
    .replace(/^produced code delta\s*[·-]?\s*/i, '')
    .trim();
  const labelPrefix =
    normalizedLabel && normalizedLabel !== filename ? `${normalizedLabel} · ${filename}` : filename;
  const title = `${scopeTitle} · ${labelPrefix}`;
  return {
    title,
    artifactUrl: runArtifactFetchUrl(artifact.runId, artifact),
    artifact,
  };
}

export function familyArtifactForDiffSelection(
  snapshot: FamilyObservabilitySnapshot | null,
  runId: string,
  pathValue: string,
): FamilyObservabilityArtifact | null {
  if (!snapshot) return null;
  const run = snapshot.runs.find((candidate) => candidate.runId === runId);
  const existing = [...(run?.artifacts ?? []), ...(snapshot.evidence ?? [])].find(
    (artifact) => artifact.runId === runId && artifact.path === pathValue,
  );
  return (
    existing ?? {
      runId,
      familyId: run?.familyId ?? snapshot.familyId,
      path: pathValue,
      purpose: pathValue.endsWith('.diff') || pathValue.includes('diff') ? 'diff' : 'artifact',
      source: pathValue.startsWith('inputs/') ? 'task-input' : 'task-artifact',
    }
  );
}

export function familyDiffModalHashAction(
  snapshot: FamilyObservabilitySnapshot | null,
  current: FamilyDiffModalState | null,
): FamilyDiffModalHashAction {
  const { runId, path } = diffSelectionFromFamilyHash();
  if (!runId || !path) return current ? { kind: 'close' } : { kind: 'none' };
  const artifact = familyArtifactForDiffSelection(snapshot, runId, path);
  if (!artifact) return { kind: 'none' };
  if (current?.artifact.runId === artifact.runId && current.artifact.path === artifact.path) {
    return { kind: 'none' };
  }
  return { kind: 'open', label: artifact.path.split('/').pop() ?? 'Diff', artifact };
}

export function updateFamilyDiffModalHash(
  artifact: FamilyObservabilityArtifact | null,
  suppressed: boolean,
  setSuppressed: (suppressed: boolean) => void,
): void {
  if (suppressed) return;
  const next = familyDiffModalHash(artifact);
  if (location.hash !== next) {
    setSuppressed(true);
    history.replaceState(null, '', next);
    queueMicrotask(() => {
      setSuppressed(false);
    });
  }
}

export function restoreFamilyDiffModalOpener(opener: HTMLElement | null): void {
  if (opener && opener.isConnected) {
    queueMicrotask(() => {
      opener.focus();
    });
  }
}

export function renderFamilyDiffModal(
  modal: FamilyDiffModalState | null,
  onClose: () => void,
): TemplateResult | typeof nothing {
  if (!modal) return nothing;
  return html`<diff-viewer-modal
    .open=${true}
    .title=${modal.title}
    .artifactUrl=${modal.artifactUrl}
    @diff-modal-close=${onClose}
  ></diff-viewer-modal>`;
}
