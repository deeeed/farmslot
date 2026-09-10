import type {
  PRRuleField,
  PRRuleMatch,
  PRRulePredicate,
  PRRuleSubject,
  PRRuleValue,
} from '../contracts/pr-rules.js';

const stringFields = new Set(['repository', 'author', 'state', 'base-branch', 'head-branch']);
const setFields = new Set(['labels', 'changed-paths', 'author-teams', 'project-memberships']);

export function prRuleFieldKey(field: PRRuleField): string {
  return typeof field === 'string'
    ? field
    : JSON.stringify(['project', field.projectId, field.fieldId, field.valueType]);
}

function valueType(field: PRRuleField): 'string' | 'number' | 'boolean' | 'set' {
  if (typeof field !== 'string') return field.valueType === 'number' ? 'number' : 'string';
  if (field === 'draft') return 'boolean';
  return setFields.has(field) ? 'set' : 'string';
}

function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Predicate must be an object');
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Unsupported predicate property');
}
function nonempty(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
  );
}

/** Supported glob syntax: *, ** and ?. Braces, character classes and extglobs are rejected. */
export function prRuleGlob(pattern: string): { test: (value: string) => boolean } {
  if (!nonempty(pattern) || /[\[\]{}()\\]/.test(pattern))
    throw new Error('Glob supports only *, ** and ? wildcards');
  const tokens: { kind: 'literal' | 'star' | 'tree' | 'any' | 'question'; value?: string }[] = [];
  const characters = [...pattern];
  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];
    if (char === '*' && characters[i + 1] === '*') {
      i += 1;
      if (characters[i + 1] === '/') {
        tokens.push({ kind: 'tree' });
        i += 1;
      } else tokens.push({ kind: 'any' });
    } else if (char === '*') tokens.push({ kind: 'star' });
    else if (char === '?') tokens.push({ kind: 'question' });
    else tokens.push({ kind: 'literal', value: char });
  }
  return {
    test(value) {
      const chars = [...value];
      let reachable = new Array<boolean>(chars.length + 1).fill(false);
      reachable[0] = true;
      // Dynamic programming bounds work by pattern length × value length, without regex backtracking.
      for (const token of tokens) {
        const next = new Array<boolean>(chars.length + 1).fill(false);
        let prefix = false;
        for (let i = 0; i <= chars.length; i++) {
          if (token.kind === 'tree') {
            next[i] = reachable[i] || (prefix && chars[i - 1] === '/');
            prefix ||= reachable[i];
          } else if (token.kind === 'star' || token.kind === 'any') {
            next[i] =
              reachable[i] ||
              (i > 0 && next[i - 1] && (token.kind === 'any' || chars[i - 1] !== '/'));
          } else if (
            reachable[i] &&
            i < chars.length &&
            (token.kind === 'question' ? chars[i] !== '/' : chars[i] === token.value)
          )
            next[i + 1] = true;
        }
        reachable = next;
      }
      return reachable[chars.length];
    },
  };
}

export function assertPRRulePredicate(value: unknown): asserts value is PRRulePredicate {
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    if (++nodes > 100 || depth > 8)
      throw new Error('Predicate exceeds 100 nodes or 8 nesting levels');
    record(node);
    if (node.kind === 'all' || node.kind === 'any') {
      keys(node, ['kind', 'items']);
      if (!Array.isArray(node.items) || !node.items.length)
        throw new Error('all/any requires at least one predicate');
      node.items.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (node.kind === 'not') {
      keys(node, ['kind', 'item']);
      visit(node.item, depth + 1);
      return;
    }
    if (node.kind !== 'compare') throw new Error('Unsupported predicate kind');
    keys(node, ['kind', 'field', 'operator', 'value']);
    if (typeof node.field === 'string') {
      if (!stringFields.has(node.field) && !setFields.has(node.field) && node.field !== 'draft')
        throw new Error('Unsupported fact field');
    } else {
      record(node.field);
      keys(node.field, ['projectId', 'fieldId', 'valueType']);
      if (
        !nonempty(node.field.projectId) ||
        !nonempty(node.field.fieldId) ||
        !['text', 'number', 'date', 'single-select'].includes(String(node.field.valueType))
      )
        throw new Error('Project fields require provider IDs and a supported valueType');
    }
    const type = valueType(node.field as PRRuleField);
    const op = node.operator;
    const actual = node.value;
    if (op === 'is-set') {
      if (typeof actual !== 'boolean') throw new Error('is-set requires a boolean');
      return;
    }
    if (op === 'equals') {
      if (actual === null) return;
      if (
        type === 'set' ||
        typeof actual !== type ||
        (typeof actual === 'number' && !Number.isFinite(actual))
      )
        throw new Error('equals value does not match the field type');
      if (typeof actual === 'string' && !nonempty(actual))
        throw new Error('Invalid comparison string');
      return;
    }
    if (op === 'greater-than' || op === 'less-than') {
      if (type !== 'number' || typeof actual !== 'number' || !Number.isFinite(actual))
        throw new Error('Numeric comparison requires a number field and value');
      return;
    }
    if (
      (op === 'one-of' && type !== 'string') ||
      ((op === 'contains-any' || op === 'contains-all') && type !== 'set') ||
      (op === 'glob' && type !== 'set' && type !== 'string')
    )
      throw new Error('Operator does not match the field type');
    if (!['one-of', 'contains-any', 'contains-all', 'glob'].includes(String(op)))
      throw new Error('Unsupported comparison operator');
    if (!Array.isArray(actual) || !actual.length || actual.length > 100 || !actual.every(nonempty))
      throw new Error('Comparison requires 1 to 100 non-empty strings');
    if (op === 'glob') actual.forEach(prRuleGlob);
  };
  visit(value, 0);
}

function compare(
  predicate: Extract<PRRulePredicate, { kind: 'compare' }>,
  value: PRRuleValue,
): boolean {
  const { field, operator } = predicate;
  let expected = predicate.value;
  if (
    typeof field === 'string' &&
    ['repository', 'author', 'labels', 'author-teams'].includes(field)
  ) {
    const lower = (item: PRRuleValue): PRRuleValue =>
      typeof item === 'string'
        ? item.toLowerCase()
        : Array.isArray(item)
          ? item.map((text) => text.toLowerCase())
          : item;
    value = lower(value);
    expected = lower(expected);
  }
  if (operator === 'is-set') return (value !== null) === expected;
  if (operator === 'equals') return value === expected;
  if (value === null) return false;
  if (operator === 'greater-than') return Number(value) > Number(expected);
  if (operator === 'less-than') return Number(value) < Number(expected);
  const expectedValues = expected as string[];
  const values = Array.isArray(value) ? value : [String(value)];
  if (operator === 'contains-all') return expectedValues.every((item) => values.includes(item));
  if (operator === 'glob')
    return expectedValues.some((pattern) => values.some((item) => prRuleGlob(pattern).test(item)));
  return expectedValues.some((item) => values.includes(item));
}

export function evaluatePRRulePredicate(
  predicate: PRRulePredicate,
  subject: PRRuleSubject,
): PRRuleMatch {
  assertPRRulePredicate(predicate);
  const visit = (node: PRRulePredicate): PRRuleMatch => {
    if (node.kind === 'not') {
      const result = visit(node.item);
      return {
        state:
          result.state === 'unknown' ? 'unknown' : result.state === 'match' ? 'no-match' : 'match',
        reasons: result.reasons.map((reason) => `Not: ${reason}`),
      };
    }
    if (node.kind === 'all' || node.kind === 'any') {
      const children = node.items.map(visit);
      const decisive = node.kind === 'all' ? 'no-match' : 'match';
      const state = children.some((child) => child.state === decisive)
        ? decisive
        : children.some((child) => child.state === 'unknown')
          ? 'unknown'
          : node.kind === 'all'
            ? 'match'
            : 'no-match';
      return { state, reasons: children.flatMap((child) => child.reasons) };
    }
    if (node.kind !== 'compare') throw new Error('Unsupported predicate');
    const key = prRuleFieldKey(node.field);
    const fact = subject.facts[key];
    if (!fact || fact.state === 'unknown')
      return { state: 'unknown', reasons: [`${key}: ${fact?.reason ?? 'not observed'}`] };
    const type = valueType(node.field);
    if (
      fact.value !== null &&
      (type === 'set'
        ? !Array.isArray(fact.value) || !fact.value.every((item) => typeof item === 'string')
        : typeof fact.value !== type)
    )
      return { state: 'unknown', reasons: [`${key}: incompatible provider value type`] };
    const matched = compare(node, fact.value);
    return {
      state: matched ? 'match' : 'no-match',
      reasons: [`${key} ${node.operator}: ${matched ? 'matched' : 'did not match'}`],
    };
  };
  return visit(predicate);
}
