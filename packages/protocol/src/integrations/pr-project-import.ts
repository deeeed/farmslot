import type {
  PRImportedProjectView,
  PRProjectField,
  PRProjectFilterTerm,
  PRRuleField,
  PRRulePredicate,
} from '../contracts/pr-rules.js';

import { assertPRRulePredicate } from './pr-rule-predicates.js';

export function parsePRProjectURL(value: string, host: string) {
  const url = new URL(value);
  const match =
    /^\/(orgs|users)\/([a-z0-9-]+)\/projects\/([1-9]\d*)(?:\/views\/([1-9]\d*))?\/?$/i.exec(
      url.pathname,
    );
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== host.toLowerCase() ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match
  )
    throw new Error(
      'Use a saved GitHub Project or view URL on the selected account host, without temporary query filters',
    );
  const number = Number(match[3]);
  const viewNumber = match[4] ? Number(match[4]) : undefined;
  if (
    !Number.isSafeInteger(number) ||
    (viewNumber !== undefined && !Number.isSafeInteger(viewNumber))
  )
    throw new Error('Invalid Project/view number');
  return {
    ownerKind: match[1].toLowerCase() === 'orgs' ? ('organization' as const) : ('user' as const),
    owner: match[2],
    number,
    viewNumber,
  };
}

/** Preserve unsupported syntax as one term so it cannot be partially dropped or regrouped. */
export function splitPRProjectFilter(filter: string): string[] {
  if (typeof filter !== 'string' || filter.length > 4096)
    throw new Error('Project filters must be strings of at most 4096 characters');
  // Keep unsupported quoting whole so negation and OR grouping cannot change during partial import.
  if (filter.includes("'")) return filter.trim() ? [filter.trim()] : [];
  const terms: string[] = [];
  let start = 0,
    quoted = false,
    escaped = false,
    grouping = false;
  for (let i = 0; i <= filter.length; i++) {
    const char = filter[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quoted) {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === '(' || char === ')')) grouping = true;
    if ((!quoted && /\s/.test(char ?? '')) || i === filter.length) {
      if (i > start) terms.push(filter.slice(start, i));
      start = i + 1;
    }
  }
  if (quoted || grouping || terms.some((term) => ['OR', 'AND'].includes(term.toUpperCase())))
    return filter.trim() ? [filter.trim()] : [];
  if (terms.length > 100) throw new Error('Project filters may contain at most 100 terms');
  return terms;
}

function literal(text: string): string {
  if (text.startsWith('"')) {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'string' || !value) throw new Error('Expected a non-empty quoted value');
    return value;
  }
  if (!text || /["\s]/.test(text)) throw new Error('Quote filter values containing spaces');
  return text;
}

function parseTerm(text: string) {
  if (text.includes("'"))
    throw new Error('Map single-quoted filters explicitly or re-save the view using double quotes');
  let quoted = false,
    escaped = false,
    colon = -1;
  for (let i = 0; i < text.length; i++) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (text[i] === '\\' && quoted) {
      escaped = true;
      continue;
    }
    if (text[i] === '"') quoted = !quoted;
    if (text[i] === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 1) throw new Error('Map this filter expression explicitly');
  const negated = text.startsWith('-');
  const key = literal(text.slice(negated ? 1 : 0, colon)).toLowerCase();
  const tail = text.slice(colon + 1);
  const values: string[] = [];
  let start = 0;
  quoted = false;
  escaped = false;
  for (let i = 0; i <= tail.length; i++) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (tail[i] === '\\' && quoted) {
      escaped = true;
      continue;
    }
    if (tail[i] === '"') quoted = !quoted;
    if ((!quoted && tail[i] === ',') || i === tail.length) {
      values.push(literal(tail.slice(start, i)));
      start = i + 1;
    }
  }
  if (quoted) throw new Error('Unclosed filter quote');
  return { key, values, negated };
}

function comparison(
  field: PRRuleField,
  operator: Extract<PRRulePredicate, { kind: 'compare' }>['operator'],
  value: Extract<PRRulePredicate, { kind: 'compare' }>['value'],
): PRRulePredicate {
  return { kind: 'compare', field, operator, value };
}
function any(values: Array<PRRulePredicate | boolean>): PRRulePredicate | boolean {
  if (values.includes(true)) return true;
  const predicates = values.filter((value): value is PRRulePredicate => typeof value !== 'boolean');
  return !predicates.length
    ? false
    : predicates.length === 1
      ? predicates[0]
      : { kind: 'any', items: predicates };
}

export function compilePRProjectFilter(
  filter: string,
  projectId: string,
  fields: PRProjectField[],
): PRProjectFilterTerm[] {
  return splitPRProjectFilter(filter).map((text): PRProjectFilterTerm => {
    try {
      const { key, values, negated } = parseTerm(text);
      let predicate: PRRulePredicate | boolean;
      if (key === 'is') {
        predicate = any(
          values.map((value) => {
            if (value === 'pr') return true;
            if (value === 'issue') return false;
            if (value === 'draft') return comparison('draft', 'equals', true);
            if (value === 'open' || value === 'merged') return comparison('state', 'equals', value);
            if (value === 'closed') return comparison('state', 'one-of', ['closed', 'merged']);
            throw new Error(`Unsupported item state/type: ${value}`);
          }),
        );
      } else if (key === 'repo') {
        if (values.some((value) => !/^[^/\s*,]+\/[^/\s*,]+$/.test(value)))
          throw new Error('Repository filters require literal owner/repo values');
        predicate = comparison('repository', 'one-of', values);
      } else if (key === 'label') {
        if (values.some((value) => value.includes('*')))
          throw new Error('Map label wildcard filters explicitly');
        predicate = comparison('labels', 'contains-any', values);
      } else {
        const fieldKey = key === 'no' || key === 'has' ? values[0].toLowerCase() : key;
        if ((key === 'no' || key === 'has') && values.length !== 1)
          throw new Error('Map combined presence filters explicitly');
        if ((key === 'no' || key === 'has') && fieldKey === 'label') {
          predicate = comparison('labels', 'glob', ['**']);
          if (key === 'no') predicate = { kind: 'not', item: predicate };
        } else {
          const matches = fields.filter(
            (field) =>
              field.name.toLowerCase() === fieldKey ||
              field.name.toLowerCase().replace(/\s+/g, '-') === fieldKey,
          );
          if (matches.length !== 1)
            throw new Error(`Field is unavailable or ambiguous: ${fieldKey}`);
          const field = matches[0];
          const valueType = field.dataType.toLowerCase().replaceAll('_', '-');
          if (!['text', 'number', 'date', 'single-select'].includes(valueType))
            throw new Error(`Unsupported Project field type: ${field.dataType}`);
          const binding: Exclude<PRRuleField, string> = {
            projectId,
            fieldId: field.id,
            valueType: valueType as 'text' | 'number' | 'date' | 'single-select',
          };
          if (key === 'no' || key === 'has')
            predicate = comparison(binding, 'is-set', key === 'has');
          else if (valueType === 'single-select') {
            const ids = values.map((value) => {
              const options =
                field.options?.filter(
                  (option) => option.name.toLowerCase() === value.toLowerCase(),
                ) ?? [];
              if (options.length !== 1)
                throw new Error(`Option is unavailable or ambiguous: ${value}`);
              return options[0].id;
            });
            predicate = comparison(binding, 'one-of', [...new Set(ids)]);
          } else if (valueType === 'number') {
            predicate = any(
              values.map((value) => {
                const match = /^(>|<)?(-?(?:\d+(?:\.\d+)?|\.\d+))$/.exec(value);
                if (!match || !Number.isFinite(Number(match[2])))
                  throw new Error('Map numeric ranges and inclusive comparisons explicitly');
                return comparison(
                  binding,
                  match[1] === '>' ? 'greater-than' : match[1] === '<' ? 'less-than' : 'equals',
                  Number(match[2]),
                );
              }),
            );
          } else if (valueType === 'date') {
            if (values.some((value) => !/^\d{4}-\d{2}-\d{2}$/.test(value)))
              throw new Error('Map date ranges and relative dates explicitly');
            predicate = comparison(binding, 'one-of', values);
          } else
            throw new Error(
              'Map text-search filters explicitly; substring search is not exact equality',
            );
        }
      }
      if (typeof predicate === 'boolean')
        return { text, kind: 'constant', value: negated ? !predicate : predicate };
      if (negated) predicate = { kind: 'not', item: predicate };
      assertPRRulePredicate(predicate);
      return { text, kind: 'predicate', predicate };
    } catch (error) {
      // An unsupported or invalid term stays visible and blocks the source until explicitly mapped.
      return {
        text,
        kind: 'unmapped',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function assertPRImportedProjectView(
  value: unknown,
): asserts value is PRImportedProjectView {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Imported view must be an object');
  const view = value as Record<string, unknown>;
  if (
    Object.keys(view).some((key) => !['number', 'name', 'filter', 'terms'].includes(key)) ||
    !Number.isSafeInteger(view.number) ||
    Number(view.number) < 1 ||
    typeof view.name !== 'string' ||
    !view.name.trim()
  )
    throw new Error('Invalid imported view identity');
  if (typeof view.filter !== 'string' || !Array.isArray(view.terms))
    throw new Error('Imported view must retain its filter and all terms');
  const terms = splitPRProjectFilter(view.filter);
  if (terms.length !== view.terms.length)
    throw new Error('Imported view cannot discard filter terms');
  for (let i = 0; i < terms.length; i++) {
    const term = view.terms[i] as Record<string, unknown>;
    if (!term || typeof term !== 'object' || term.text !== terms[i])
      throw new Error('Imported filter term does not match the original filter');
    const allowed =
      term.kind === 'predicate'
        ? ['text', 'kind', 'predicate', 'manuallyMapped']
        : term.kind === 'constant'
          ? ['text', 'kind', 'value']
          : ['text', 'kind', 'reason'];
    if (Object.keys(term).some((key) => !allowed.includes(key)))
      throw new Error('Unsupported imported filter property');
    if (term.kind === 'predicate') {
      assertPRRulePredicate(term.predicate);
      if (term.manuallyMapped !== undefined && typeof term.manuallyMapped !== 'boolean')
        throw new Error('manuallyMapped must be explicit boolean');
    } else if (term.kind === 'constant') {
      const compiled = compilePRProjectFilter(terms[i], 'unused', []);
      if (
        compiled.length !== 1 ||
        compiled[0].kind !== 'constant' ||
        compiled[0].value !== term.value
      )
        throw new Error('Only PR/issue type filters may compile to constants');
    } else if (term.kind !== 'unmapped' || typeof term.reason !== 'string' || !term.reason.trim())
      throw new Error('Unsupported filter terms need an actionable reason');
  }
  const predicates = view.terms
    .filter(
      (term): term is Extract<PRProjectFilterTerm, { kind: 'predicate' }> =>
        term.kind === 'predicate',
    )
    .map((term) => term.predicate);
  if (predicates.length)
    assertPRRulePredicate(
      predicates.length === 1 ? predicates[0] : { kind: 'all', items: predicates },
    );
}
