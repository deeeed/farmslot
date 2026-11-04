import {
  viewChoiceField,
  viewListField,
  type ViewStateContext,
  viewTextField,
} from '@farmslot/protocol';

import { useFilterStore } from '../store/filters';
import { type RunFilters, useRunFilterStore } from '../store/run-filters';

const fields = {
  projects: viewListField('projects', [], 'csv'),
  machines: viewListField('machines', [], 'csv'),
  flow: viewChoiceField<RunFilters['flow']>('flow', '', [
    '',
    'fix-bug',
    'review-pr',
    'qa',
    'dev',
    'pr-complete',
    'update-branch',
  ]),
  lane: viewChoiceField<RunFilters['lane']>('lane', '', [
    '',
    'production',
    'validation',
    'comparison',
  ]),
  sort: viewChoiceField<RunFilters['sort']>('sort', 'newest', ['newest', 'oldest', 'duration']),
  search: viewTextField('q'),
  tag: viewTextField('tag'),
};
let activeStop: (() => void) | undefined;

/** Filter sheets edit their underlying screen. The next focused screen replaces this binding. */
export function bindViewStateFilters(view: ViewStateContext): () => void {
  activeStop?.();
  let restoring = false;
  const restore = () => {
    const global = {
      projects: [...view.get(fields.projects)],
      machines: [...view.get(fields.machines)],
    };
    const run: RunFilters = {
      flow: view.get(fields.flow),
      lane: view.get(fields.lane),
      sort: view.get(fields.sort),
      search: view.get(fields.search),
      tag: view.get(fields.tag),
    };
    restoring = true;
    try {
      const previous = useFilterStore.getState();
      if (!previous.initialized || JSON.stringify(previous.filters) !== JSON.stringify(global)) {
        // URL restoration precedes init and fences any older preference read already in flight.
        useFilterStore.setState({
          filters: global,
          initialized: true,
          initializing: false,
          mutationVersion: previous.mutationVersion + 1,
        });
        useFilterStore.getState().setAvailable(previous.availableSources);
      }
      const previousRun = useRunFilterStore.getState();
      if (!previousRun.initialized || JSON.stringify(previousRun.filters) !== JSON.stringify(run))
        useRunFilterStore.setState({
          filters: run,
          initialized: true,
          accountEpoch: previousRun.accountEpoch + 1,
        });
    } finally {
      restoring = false;
    }
  };
  const persist = () => {
    if (restoring) return;
    const global = useFilterStore.getState().filters;
    const run = useRunFilterStore.getState().filters;
    view.update((values) => {
      values.set(fields.projects, global.projects);
      values.set(fields.machines, global.machines);
      values.set(fields.flow, run.flow);
      values.set(fields.lane, run.lane);
      values.set(fields.sort, run.sort);
      values.set(fields.search, run.search);
      values.set(fields.tag, run.tag);
    }, 'replace');
  };
  restore();
  const stops = [
    view.subscribe(restore),
    useFilterStore.subscribe((next, previous) => {
      if (next.filters !== previous.filters) persist();
    }),
    useRunFilterStore.subscribe((next, previous) => {
      if (next.filters !== previous.filters) persist();
    }),
  ];
  const stop = () => {
    for (const unsubscribe of stops) unsubscribe();
    if (activeStop === stop) activeStop = undefined;
  };
  activeStop = stop;
  return stop;
}
