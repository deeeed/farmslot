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
export type ReviewWorkspacePanel = 'quality' | 'recipe' | 'learnings';

export interface ReadyWorkspaceHashState {
  tab?: ReadyWorkspaceTab;
  file?: string;
  modal?: ReadyWorkspaceModal;
  diffArtifact?: string;
  lightboxIndex?: number;
  lightboxRecipeRunId?: string;
}

export interface ReadyWorkspaceHashWriteState {
  tab: ReadyWorkspaceTab;
  file?: string;
  modal?: ReadyWorkspaceModal;
  diffArtifact?: string;
  lightboxIndex?: number;
  lightboxRecipeRunId?: string;
}

export interface ReviewWorkspaceHashState {
  panels: ReviewWorkspacePanel[];
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
const REVIEW_PANELS = new Set<ReviewWorkspacePanel>(['quality', 'recipe', 'learnings']);

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
  return {
    tab: readyWorkspaceTab(params.get('tab')),
    file: nonEmptyParam(params, 'file'),
    modal: readyWorkspaceModal(params.get('modal')),
    diffArtifact: nonEmptyParam(params, 'diffArtifact'),
    lightboxIndex: nonNegativeFiniteParam(params, 'lightboxIndex'),
    lightboxRecipeRunId:
      nonEmptyParam(params, 'lightboxRecipeRunId') ?? nonEmptyParam(params, 'recipeRun'),
  };
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

  return buildHash(route, params);
}

export function writeReadyWorkspaceHashState(state: ReadyWorkspaceHashWriteState): void {
  if (typeof location === 'undefined') return;
  const nextHash = readyWorkspaceHashWithState(state);
  if (!nextHash || location.hash === nextHash) return;
  history.replaceState(null, '', nextHash);
}

export function parseReviewWorkspaceHashState(
  hash: string = location.hash,
): ReviewWorkspaceHashState {
  const { params } = parseHashRoute(hash);
  const panels = (params.get('panel') ?? '')
    .split(',')
    .filter((panel): panel is ReviewWorkspacePanel =>
      REVIEW_PANELS.has(panel as ReviewWorkspacePanel),
    );
  return { panels };
}

export function reviewWorkspaceHashWithState(
  state: ReviewWorkspaceHashState,
  hash: string = location.hash,
): string {
  const { route, params } = parseHashRoute(hash);
  if (state.panels.length > 0) params.set('panel', state.panels.join(','));
  else params.delete('panel');
  return buildHash(route, params);
}

export function writeReviewWorkspaceHashState(state: ReviewWorkspaceHashState): void {
  if (typeof location === 'undefined') return;
  const nextHash = reviewWorkspaceHashWithState(state);
  history.replaceState(null, '', nextHash);
}
