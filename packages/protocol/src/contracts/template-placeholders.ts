import { enumerateChecklistCheckboxes } from '../checklist-target.js';

/** One shared part for every PR-producing worker template. */
const CI_PARITY_PART =
  '- [ ] **CI parity** [DETERMINISTIC: ci.local_check]. Run `{{TASK_DIR}}/mark N` for this step. Mark executes the configured local CI command, records its exit code and log, and refuses completion on failure. Rerun this step after changing checked source.';

/**
 * `{{NAME}}` placeholder guard shared by every template renderer (task writer,
 * agent-runtime task init, prompt templates). Pure string functions: no slot or
 * project coupling, so a harness can render the same template a control plane
 * renders and fail on the same unknown token.
 */

// Any double-brace token, valid identifier or not — a malformed name like
// {{foo-bar}} can never be substituted, so it must fail the guard rather
// than slip through an identifier-only scan.
const PLACEHOLDER_TOKEN_RE = /\{\{[^{}\n]+\}\}/g;

/** Full {{...}} tokens present in the text, including malformed names. */
export function collectPlaceholderTokens(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(PLACEHOLDER_TOKEN_RE), (match) => match[0]));
}

export function assertNoUnknownPlaceholders(
  template: string,
  known: Iterable<string>,
  source: string,
): void {
  const knownSet = known instanceof Set ? known : new Set(known);
  const unknown = [...collectPlaceholderTokens(template)].filter((token) => {
    const name = token.slice(2, -2);
    if (name === 'CI_PARITY_STEP') return false;
    return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !knownSet.has(name);
  });
  if (unknown.length > 0) {
    throw new Error(
      `${source} references placeholder(s) with no expansion value: ${unknown.join(', ')} — ` +
        `supply the variable or remove the placeholder from the template`,
    );
  }
}

/**
 * Substitute `{{KEY}}` with `vars[KEY]` after the guard. Values are inserted
 * verbatim and never re-expanded; a value that itself contains `{{...}}` is the
 * caller's responsibility (the slot-config renderer rejects such values).
 */
export function renderTemplatePlaceholders(
  template: string,
  vars: Record<string, string>,
  source = 'template',
): string {
  const hasParityPart = template.includes('{{CI_PARITY_STEP}}');
  let content = hasParityPart
    ? template.replace(
        /^[ \t]*\{\{CI_PARITY_STEP\}\}|\{\{CI_PARITY_STEP\}\}/gm,
        vars['ci.local_check']?.trim() ? CI_PARITY_PART : '',
      )
    : template;
  assertNoUnknownPlaceholders(content, Object.keys(vars), source);
  content = content.replace(PLACEHOLDER_TOKEN_RE, (token) => vars[token.slice(2, -2)]);
  if (hasParityPart && vars['ci.local_check']?.trim()) {
    const lines = content.split('\n');
    for (const item of enumerateChecklistCheckboxes(content)) {
      const label = item.rawLabel.startsWith('**CI parity**')
        ? item.rawLabel
            .replace('**CI parity**', `**${item.stepNumber}. CI parity**`)
            .replace(
              '/mark N',
              `/mark${vars.CI_PARITY_CHECKLIST ? ` --checklist ${vars.CI_PARITY_CHECKLIST}` : ''} ${item.stepNumber}`,
            )
        : item.rawLabel.replace(/^(\*{0,2})\d+[.)]\s/, `$1${item.stepNumber}. `);
      lines[item.lineIndex] = lines[item.lineIndex].replace(item.rawLabel, label);
    }
    content = lines.join('\n');
  }
  return content;
}
