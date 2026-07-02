import { buildHash, parseHashRoute } from '../../utils/url-state.js';

export type ReadyWorkspaceTab =
  | 'pr-preview'
  | 'input'
  | 'diff'
  | 'evidence'
  | 'quality'
  | 'recipe'
  | 'learnings';
export type ReadyWorkspaceModal = 'diff' | 'review' | 'lightbox';
/** Legacy multi-panel toggles — mapped to `ReviewWorkspaceTab` on read. */
export type ReviewWorkspacePanel = 'quality' | 'recipe' | 'learnings';
export type ReviewWorkspaceTab = 'review' | 'evidence' | 'quality' | 'recipe' | 'learnings';

export interface ReadyWorkspaceHashState {
  tab?: ReadyWorkspaceTab;
  file?: string;
  modal?: ReadyWorkspaceModal;
  diffArtifact?: string;
  lightboxIndex?: number;
  lightboxRecipeRunId?: string;
  recipePackageEvidenceCollapsed?: boolean;
}

export interface ReadyWorkspaceHashWriteState {
  tab: ReadyWorkspaceTab;
  file?: string;
  modal?: ReadyWorkspaceModal;
  diffArtifact?: string;
  lightboxIndex?: number;
  lightboxRecipeRunId?: string;
  recipePackageEvidenceCollapsed?: boolean;
}

export interface ReviewWorkspaceHashState {
  tab?: ReviewWorkspaceTab;
}

export interface ReviewWorkspaceHashWriteState {
  tab: ReviewWorkspaceTab;
}

const READY_TABS = new Set<ReadyWorkspaceTab>([
  'pr-preview',
  'input',
  'diff',
  'evidence',
  'quality',
  'recipe',
  'learnings',
]);
const READY_MODALS = new Set<ReadyWorkspaceModal>(['diff', 'review', 'lightbox']);
const REVIEW_TABS = new Set<ReviewWorkspaceTab>([
  'review',
  'evidence',
  'quality',
  'recipe',
  'learnings',
]);
const REVIEW_PANELS = new Set<ReviewWorkspacePanel>(['quality', 'recipe', 'learnings']);

const LEGACY_PANEL_TO_TAB: Record<ReviewWorkspacePanel, ReviewWorkspaceTab> = {
  quality: 'quality',
  recipe: 'recipe',
  learnings: 'learnings',
};

function readyWorkspaceTab(value: string | null): ReadyWorkspaceTab | undefined {
  if (!value) return undefined;
  return READY_TABS.has(value as ReadyWorkspaceTab) ? (value as ReadyWorkspaceTab) : undefined;
}

function readyWorkspaceModal(value: string | null): ReadyWorkspaceModal | undefined {
  if (!value) return undefined;
  return READY_MODALS.has(value as ReadyWorkspaceModal)
    ? (value as ReadyWorkspaceModal)
    : undefined;
}

function reviewWorkspaceTab(value: string | null): ReviewWorkspaceTab | undefined {
  if (!value) return undefined;
  return REVIEW_TABS.has(value as ReviewWorkspaceTab) ? (value as ReviewWorkspaceTab) : undefined;
}

function nonEmptyParam(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name);
  return value ? value : undefined;
}

function nonNegativeFiniteParam(params: URLSearchParams, name: string): number | undefined {
  const value = Number(params.get(name));
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export function parseReadyWorkspaceHashState(
  hash: string = location.hash,
): ReadyWorkspaceHashState {
  const { params } = parseHashRoute(hash);
  const state: ReadyWorkspaceHashState = {
    tab: readyWorkspaceTab(params.get('tab')),
    file: nonEmptyParam(params, 'file'),
    modal: readyWorkspaceModal(params.get('modal')),
    diffArtifact: nonEmptyParam(params, 'diffArtifact'),
    lightboxIndex: nonNegativeFiniteParam(params, 'lightboxIndex'),
    lightboxRecipeRunId:
      nonEmptyParam(params, 'lightboxRecipeRunId') ?? nonEmptyParam(params, 'recipeRun'),
  };
  if (params.get('evidencePreview') === 'collapsed') {
    state.recipePackageEvidenceCollapsed = true;
  }
  return state;
}

export function readyWorkspaceHashWithState(
  state: ReadyWorkspaceHashWriteState,
  hash: string = location.hash,
): string | null {
  const { route, params } = parseHashRoute(hash);
  if (!route) return null;

  params.set('tab', state.tab);
  if (state.file) params.set('file', state.file);
  else params.delete('file');

  if (state.modal === 'diff') {
    params.set('modal', 'diff');
    if (state.diffArtifact) params.set('diffArtifact', state.diffArtifact);
    else params.delete('diffArtifact');
    params.delete('lightboxIndex');
    params.delete('lightboxRecipeRunId');
  } else if (state.modal === 'review') {
    params.set('modal', 'review');
    params.delete('diffArtifact');
    params.delete('lightboxIndex');
    params.delete('lightboxRecipeRunId');
  } else if (state.modal === 'lightbox') {
    params.set('modal', 'lightbox');
    params.set('lightboxIndex', String(state.lightboxIndex ?? 0));
    if (state.lightboxRecipeRunId) params.set('lightboxRecipeRunId', state.lightboxRecipeRunId);
    else params.delete('lightboxRecipeRunId');
    params.delete('diffArtifact');
  } else {
    params.delete('modal');
    params.delete('diffArtifact');
    params.delete('lightboxIndex');
    params.delete('lightboxRecipeRunId');
  }

  if (state.recipePackageEvidenceCollapsed) params.set('evidencePreview', 'collapsed');
  else params.delete('evidencePreview');

  return buildHash(route, params);
}

export function writeReadyWorkspaceHashState(state: ReadyWorkspaceHashWriteState): void {
  if (typeof location === 'undefined') return;
  const nextHash = readyWorkspaceHashWithState(state);
  if (!nextHash || location.hash === nextHash) return;
  history.replaceState(null, '', nextHash);
}

function legacyReviewTabFromPanels(params: URLSearchParams): ReviewWorkspaceTab | undefined {
  const panels = (params.get('panel') ?? '')
    .split(',')
    .filter((panel): panel is ReviewWorkspacePanel =>
      REVIEW_PANELS.has(panel as ReviewWorkspacePanel),
    );
  for (const panel of panels) {
    return LEGACY_PANEL_TO_TAB[panel];
  }
  return undefined;
}

export function parseReviewWorkspaceHashState(
  hash: string = location.hash,
): ReviewWorkspaceHashState {
  const { params } = parseHashRoute(hash);
  const tab = reviewWorkspaceTab(params.get('tab')) ?? legacyReviewTabFromPanels(params);
  return tab ? { tab } : {};
}

export function reviewWorkspaceHashWithState(
  state: ReviewWorkspaceHashWriteState,
  hash: string = location.hash,
): string {
  const { route, params } = parseHashRoute(hash);
  if (state.tab === 'review') {
    params.delete('tab');
  } else {
    params.set('tab', state.tab);
  }
  params.delete('panel');
  return buildHash(route, params);
}

export function writeReviewWorkspaceHashState(state: ReviewWorkspaceHashWriteState): void {
  if (typeof location === 'undefined') return;
  const nextHash = reviewWorkspaceHashWithState(state);
  if (location.hash === nextHash) return;
  history.replaceState(null, '', nextHash);
}
