/** Persistent display choices. Contexts declare fields; platform adapters own navigation. */
export type ViewStateHistory = 'push' | 'replace';

export interface ViewStateField<T> {
  readonly key: string;
  read(params: URLSearchParams): T;
  write(params: URLSearchParams, value: T): void;
}

export interface ViewStateValues {
  get<T>(field: ViewStateField<T>): T;
  set<T>(field: ViewStateField<T>, value: NoInfer<T>): void;
}

export interface ViewStateAdapter {
  read(): URLSearchParams;
  write(params: URLSearchParams, history: ViewStateHistory): void;
  subscribe(listener: () => void): () => void;
}

export interface ViewStateContext {
  get<T>(field: ViewStateField<T>): T;
  set<T>(field: ViewStateField<T>, value: NoInfer<T>, history?: ViewStateHistory): void;
  update(edit: (values: ViewStateValues) => void, history?: ViewStateHistory): void;
  snapshot(): string;
  subscribe(listener: () => void): () => void;
}

export function viewStateParams(
  source: URLSearchParams,
  edit: (values: ViewStateValues) => void,
): URLSearchParams {
  const params = new URLSearchParams(source);
  edit({
    get: (field) => field.read(params),
    set: (field, value) => field.write(params, value),
  });
  return params;
}

export function createViewStateContext(adapter: ViewStateAdapter): ViewStateContext {
  const update: ViewStateContext['update'] = (edit, history = 'push') => {
    const before = adapter.read();
    const next = viewStateParams(before, edit);
    if (before.toString() !== next.toString()) adapter.write(next, history);
  };
  return {
    get: (field) => field.read(adapter.read()),
    set: (field, value, history) => update((values) => values.set(field, value), history),
    update,
    snapshot: () => adapter.read().toString(),
    subscribe: (listener) => adapter.subscribe(listener),
  };
}

export function viewTextField(key: string, defaultValue = ''): ViewStateField<string> {
  return {
    key,
    read: (params) => params.get(key) ?? defaultValue,
    write: (params, value) => {
      if (value === defaultValue) params.delete(key);
      else params.set(key, value);
    },
  };
}

export function viewChoiceField<T extends string>(
  key: string,
  defaultValue: T,
  choices: readonly T[],
): ViewStateField<T> {
  return {
    ...viewTextField(key, defaultValue),
    read: (params) => choices.find((choice) => choice === params.get(key)) ?? defaultValue,
  };
}

export function viewListField(
  key: string,
  defaultValue: readonly string[] = [],
  encoding: 'repeat' | 'csv' = 'repeat',
): ViewStateField<readonly string[]> {
  return {
    key,
    read: (params) => {
      if (!params.has(key)) return [...defaultValue];
      const values = params.getAll(key);
      return (encoding === 'csv' ? values.flatMap((value) => value.split(',')) : values).filter(
        (value) => value !== '',
      );
    },
    write: (params, values) => {
      params.delete(key);
      if (
        values.length === defaultValue.length &&
        values.every((value, i) => value === defaultValue[i])
      )
        return;
      if (!values.length) params.set(key, '');
      else if (encoding === 'csv') params.set(key, values.join(','));
      else for (const value of values) params.append(key, value);
    },
  };
}

/** A compact collection contains only toggles that differ from their context's defaults. */
export function viewToggleField(
  key: string,
  id: string,
  defaultValue: boolean,
): ViewStateField<boolean> {
  const entries = viewListField(key, [], 'csv');
  const entryId = id.replaceAll('%', '%25').replaceAll(',', '%2C');
  return {
    key,
    read: (params) => {
      for (const value of entries.read(params).slice().reverse()) {
        if (value === entryId) return true;
        if (value === `!${entryId}`) return false;
      }
      return defaultValue;
    },
    write: (params, value) => {
      const values = entries
        .read(params)
        .filter((entry) => entry !== entryId && entry !== `!${entryId}`);
      if (value !== defaultValue) values.push(value ? entryId : `!${entryId}`);
      entries.write(params, [...new Set(values)].sort());
    },
  };
}

/** Router adapters use the same repeated-value representation as browser query strings. */
export function viewStateSearchParams(
  values: Readonly<Record<string, string | readonly string[] | undefined>>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') params.append(key, value);
    else for (const item of value ?? []) params.append(key, item);
  }
  return params;
}

/** Undefined entries remove old route parameters when a configured default is restored. */
export function viewStateRoutePatch(
  before: URLSearchParams,
  next: URLSearchParams,
): Record<string, string | string[] | undefined> {
  const patch: Record<string, string | string[] | undefined> = {};
  for (const key of new Set([...before.keys(), ...next.keys()])) {
    const values = next.getAll(key);
    patch[key] = values.length > 1 ? values : values[0];
  }
  return patch;
}

export function viewNullableTextField(key: string): ViewStateField<string | null> {
  const text = viewTextField(key);
  return {
    key,
    read: (params) => text.read(params) || null,
    write: (params, value) => text.write(params, value ?? ''),
  };
}

export function viewIntegerField(key: string, defaultValue = 0): ViewStateField<number> {
  const text = viewTextField(key, String(defaultValue));
  return {
    key,
    read: (params) => {
      const value = Number(text.read(params));
      return Number.isSafeInteger(value) && value >= 0 ? value : defaultValue;
    },
    write: (params, value) => text.write(params, String(value)),
  };
}

/** Explicit per-entry overrides, such as opened/closed folds whose default depends on data. */
export function viewToggleMapField(key: string): ViewStateField<Readonly<Record<string, boolean>>> {
  const list = viewListField(key, [], 'csv');
  return {
    key,
    read: (params) =>
      Object.fromEntries(
        list
          .read(params)
          .map((entry) =>
            entry.startsWith('!')
              ? [entry.slice(1).replaceAll('%2C', ',').replaceAll('%25', '%'), false]
              : [entry.replaceAll('%2C', ',').replaceAll('%25', '%'), true],
          ),
      ),
    write: (params, values) =>
      list.write(
        params,
        Object.entries(values)
          .map(([id, value]) =>
            value
              ? id.replaceAll('%', '%25').replaceAll(',', '%2C')
              : `!${id.replaceAll('%', '%25').replaceAll(',', '%2C')}`,
          )
          .sort(),
      ),
  };
}

/** A status-derived default may change; an explicit disclosure choice must survive it. */
export function viewToggleOverrideField(
  key: string,
  id: string,
  defaultValue: boolean,
): ViewStateField<boolean> {
  const field = viewToggleMapField(key);
  return {
    key,
    read: (params) => field.read(params)[id] ?? defaultValue,
    write: (params, value) => field.write(params, { ...field.read(params), [id]: value }),
  };
}

/** Display parameters carried across sibling workspace tabs; no action or authority inputs. */
export const VIEW_STATE_PARAMETERS: ReadonlySet<string> = new Set(
  'panels round step flow lane sort q tag workers treeOpen branchFilesView branchFilesClosed changesView changesClosed problemSource commentFilter commentAuthor commentThread logFilter compareStep workerSession expandedSlot messages turnFiles rawClaims prReviews prMonitors folds terminalView reviewReport stage delivery diffMode devicePanes deviceLayout sidebarWidth diffFilter diffQuery diffPath mobileDiffMode claims evidenceFilter compareIndex mediaIndex prFilter subtasks mediaGroups familyCompareIndex assessmentConsumer finetuneProject flowNode nativeFilesTab nativeDirectory nativeFile nativeFileView projects machines'.split(
    ' ',
  ),
);

export function selectedViewStateParams(
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(params).flatMap(([key, value]) =>
      VIEW_STATE_PARAMETERS.has(key) && value !== undefined
        ? [[key, typeof value === 'string' ? value : [...value]]]
        : [],
    ),
  );
}
