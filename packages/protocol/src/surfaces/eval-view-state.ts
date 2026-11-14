import { viewChoiceField, viewTextField } from './view-state.js';

export const EVAL_BENCH_VIEW = viewChoiceField('view', 'results', ['results', 'plan']);
export const EVAL_BENCH_FILTERS = {
  problem: viewTextField('problem'),
  area: viewTextField('area'),
  size: viewTextField('size'),
  model: viewTextField('model'),
};
export type EvalBenchFilter = keyof typeof EVAL_BENCH_FILTERS;
