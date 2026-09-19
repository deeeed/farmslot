/**
 * Test helpers for asserting on lit templates without a DOM. The unit tests run
 * in plain node, so a rendered template is inspected through its `strings` and
 * `values` rather than through elements.
 */

interface TemplateLike {
  strings: readonly string[];
  values: readonly unknown[];
}

function isTemplateLike(value: unknown): value is TemplateLike {
  return typeof value === 'object' && value !== null && 'strings' in value && 'values' in value;
}

/**
 * Flatten a lit TemplateResult (and nested results/arrays) into its rendered
 * text by interleaving the static `strings` with the resolved dynamic `values`.
 * Sentinels such as `nothing` have neither, so they collapse to ''.
 */
export function litText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(litText).join('');
  if (isTemplateLike(value)) {
    const { strings, values } = value;
    return strings
      .map((chunk, index) => chunk + (index < values.length ? litText(values[index]) : ''))
      .join('');
  }
  return '';
}

/**
 * The value bound to a named binding, e.g. `litBinding(result, '?open=')`. Walks
 * nested templates depth-first and returns the first match, so a test can assert
 * on a boolean or property binding that never reaches the rendered text.
 */
export function litBinding(value: unknown, binding: string): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = litBinding(entry, binding);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isTemplateLike(value)) return undefined;
  const { strings, values } = value;
  for (let index = 0; index < values.length; index += 1) {
    if (strings[index]?.trimEnd().endsWith(binding)) return values[index];
  }
  for (const nested of values) {
    const found = litBinding(nested, binding);
    if (found !== undefined) return found;
  }
  return undefined;
}
