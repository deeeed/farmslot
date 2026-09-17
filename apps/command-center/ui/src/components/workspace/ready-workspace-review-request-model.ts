import type {
  ReviewLoopRequest,
  ReviewSessionIntent,
  ReviewValidationDepth,
} from '@farmslot/protocol';
import { reviewValidationDepthForLoop } from '@farmslot/protocol';

import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  type EffortLevel,
  effortsForRunner,
  modelForRunnerChange,
} from '../../utils/runner-options.js';

import type { ReviewLoopDraft, ReviewRunnerChoice } from './ready-workspace-modal-renderers.js';

function defaultsForRunner(runner: string): { model: string; effort: EffortLevel } {
  const model = DEFAULT_MODEL[runner] ?? modelForRunnerChange(runner, '');
  const efforts = effortsForRunner(runner, model);
  const preferred = DEFAULT_EFFORT[runner] ?? '';
  return {
    model,
    effort: efforts.includes(preferred) ? preferred : (efforts[0] ?? ''),
  };
}

export function readyRunnerLabel(runner: string, currentRunner: string): string {
  if (!runner || runner === 'same')
    return currentRunner === 'same' ? 'Current runner' : currentRunner;
  return runner.charAt(0).toUpperCase() + runner.slice(1);
}

export function createReadyReviewLoop(id: number, currentRunner: string): ReviewLoopDraft {
  return {
    id,
    runner: currentRunner as ReviewRunnerChoice,
    sessionIntent: 'reset',
    ...defaultsForRunner(currentRunner),
  };
}

export function addReadyReviewLoop(input: {
  loops: ReviewLoopDraft[];
  nextId: number;
  currentRunner: string;
  maxLoops?: number;
}): { loops: ReviewLoopDraft[]; nextId: number } {
  const maxLoops = input.maxLoops ?? 5;
  if (input.loops.length >= maxLoops) return { loops: input.loops, nextId: input.nextId };
  return {
    loops: [...input.loops, createReadyReviewLoop(input.nextId, input.currentRunner)],
    nextId: input.nextId + 1,
  };
}

export function removeReadyReviewLoop(loops: ReviewLoopDraft[], id: number): ReviewLoopDraft[] {
  if (loops.length <= 1) return loops;
  return loops.filter((loop) => loop.id !== id);
}

export function setReadyReviewLoopRunner(
  loops: ReviewLoopDraft[],
  id: number,
  runner: ReviewRunnerChoice,
): ReviewLoopDraft[] {
  return loops.map((loop) => {
    if (loop.id !== id) return loop;
    if (loop.runner === runner) return loop;
    return { ...loop, runner, ...defaultsForRunner(runner) };
  });
}

export function setReadyReviewLoopModelEffort(
  loops: ReviewLoopDraft[],
  id: number,
  model: string,
  effort: EffortLevel,
): ReviewLoopDraft[] {
  return loops.map((loop) => (loop.id === id ? { ...loop, model, effort } : loop));
}

export function setReadyReviewLoopDepth(
  loops: ReviewLoopDraft[],
  id: number,
  validationDepth: ReviewValidationDepth,
): ReviewLoopDraft[] {
  return loops.map((loop) => (loop.id === id ? { ...loop, validationDepth } : loop));
}

export function setReadyReviewLoopSessionIntent(
  loops: ReviewLoopDraft[],
  id: number,
  sessionIntent: ReviewSessionIntent,
): ReviewLoopDraft[] {
  return loops.map((loop) => (loop.id === id ? { ...loop, sessionIntent } : loop));
}

export function readyReviewLoopRequestPayload(
  loops: ReviewLoopDraft[],
  currentRunner: string,
): { loops: ReviewLoopRequest[]; requireCrossRunner: boolean } {
  const requests: ReviewLoopRequest[] = loops.slice(0, 5).map((loop, index) => ({
    order: index + 1,
    runner: (loop.runner || currentRunner) as ReviewRunnerChoice,
    ...(loop.model?.trim() ? { model: loop.model.trim() } : {}),
    ...(loop.effort?.trim() ? { effort: loop.effort.trim() } : {}),
    validationDepth: loop.validationDepth ?? reviewValidationDepthForLoop(index, loops.length),
    sessionIntent: loop.sessionIntent,
  }));
  return {
    loops: requests,
    requireCrossRunner: requests.some((loop) => loop.runner !== currentRunner),
  };
}
