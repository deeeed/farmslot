import { viewChoiceField, viewListField, viewTextField } from './view-state.js';

export const EVAL_BENCH_VIEW = viewChoiceField('view', 'results', ['results', 'plan']);
export const EVAL_BENCH_FILTERS = {
  problem: viewTextField('problem'),
  area: viewTextField('area'),
  size: viewTextField('size'),
  model: viewTextField('model'),
};
export type EvalBenchFilter = keyof typeof EVAL_BENCH_FILTERS;

export const EVAL_BENCH_TABS = ['patches', 'files', 'acceptance', 'findings', 'drift'] as const;
export type EvalBenchTab = (typeof EVAL_BENCH_TABS)[number];
export const EVAL_BENCH_COMPARE = viewListField('compare', [], 'csv');
export const EVAL_BENCH_TAB = viewChoiceField('tab', 'patches', EVAL_BENCH_TABS);
export const EVAL_BENCH_FILE = viewTextField('file');
