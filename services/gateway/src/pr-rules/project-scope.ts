import {
  evaluatePRRulePredicate,
  type PRProjectField,
  type PRRulePredicate,
  type PRRuleSource,
  type PRRuleSubject,
} from '@farmslot/protocol';

export function sourcePredicates(source: PRRuleSource): PRRulePredicate[] {
  return source.kind === 'github-project'
    ? (source.importedView?.terms ?? []).flatMap((term) =>
        term.kind === 'predicate' ? [term.predicate] : [],
      )
    : [];
}

export function unresolvedSourceFilters(source: PRRuleSource): string[] {
  return source.kind === 'github-project'
    ? (source.importedView?.terms ?? []).flatMap((term) =>
        term.kind === 'unmapped'
          ? [`${source.label}: map ${term.text} before enabling (${term.reason})`]
          : [],
      )
    : [];
}

export function projectBindingErrors(
  predicates: PRRulePredicate[],
  fields: Map<string, PRProjectField[]>,
): string[] {
  const errors = new Set<string>();
  const visit = (node: PRRulePredicate): void => {
    if (node.kind !== 'compare') {
      if (node.kind === 'not') visit(node.item);
      else node.items.forEach(visit);
      return;
    }
    if (typeof node.field === 'string') return;
    const binding = node.field;
    const field = fields.get(binding.projectId)?.find((entry) => entry.id === binding.fieldId);
    if (!field || field.dataType.toLowerCase().replaceAll('_', '-') !== binding.valueType) {
      errors.add(
        `Project ${binding.projectId} field ${binding.fieldId} is unavailable, deleted or has an incompatible type`,
      );
      return;
    }
    if (
      binding.valueType === 'single-select' &&
      ['equals', 'one-of'].includes(node.operator) &&
      node.value !== null
    ) {
      const ids = Array.isArray(node.value) ? node.value : [node.value];
      for (const id of ids)
        if (!field.options?.some((option) => option.id === id))
          errors.add(`Project field ${field.name} option ${String(id)} is unavailable or deleted`);
    }
  };
  predicates.forEach(visit);
  return [...errors];
}

/** Source filters restrict only their own membership; an explicitly configured repository remains independent. */
export function matchPRSourceScopes(
  subject: PRRuleSubject,
  sources: PRRuleSource[],
  origins: Set<number>,
): { included: boolean; reasons: string[]; errors: string[] } {
  const reasons: string[] = [];
  const errors: string[] = [];
  let included = false;
  for (const index of origins) {
    const source = sources[index];
    if (source.kind === 'repository') {
      included = true;
      reasons.push(`Repository source ${source.repo}`);
      continue;
    }
    const terms = source.importedView?.terms ?? [];
    const evaluations = terms.map((term) =>
      term.kind === 'predicate'
        ? evaluatePRRulePredicate(term.predicate, subject)
        : term.kind === 'constant'
          ? { state: term.value ? 'match' : 'no-match', reasons: [] }
          : { state: 'unknown', reasons: [term.reason] },
    );
    for (const result of evaluations.filter((result) => result.state === 'unknown'))
      errors.push(...result.reasons);
    if (evaluations.some((result) => result.state !== 'match')) continue;
    included = true;
    reasons.push(
      `Project ${source.label}${source.importedView ? ` / ${source.importedView.name}` : ''}`,
      ...evaluations.flatMap((result) => result.reasons),
    );
  }
  return { included, reasons, errors };
}
