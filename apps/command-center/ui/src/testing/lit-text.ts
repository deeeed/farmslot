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
 * Every value bound to a named binding, e.g. each `@click=` handler in a list, so
 * a test can assert on bindings that never reach the rendered text. A template's
 * own bindings come before those of the templates nested in it.
 */
export function litBindings(value: unknown, binding: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((entry) => litBindings(entry, binding));
  if (!isTemplateLike(value)) return [];
  const { strings, values } = value;
  const own = values.filter((_, index) => strings[index]?.trimEnd().endsWith(binding));
  return [...own, ...values.flatMap((nested) => litBindings(nested, binding))];
}

/** The first value bound to a named binding, e.g. `litBinding(result, '?open=')`. */
export function litBinding(value: unknown, binding: string): unknown {
  return litBindings(value, binding).find((found) => found !== undefined);
}
