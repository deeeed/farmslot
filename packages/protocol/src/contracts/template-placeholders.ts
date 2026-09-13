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
  assertNoUnknownPlaceholders(template, Object.keys(vars), source);
  let content = template;
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}
