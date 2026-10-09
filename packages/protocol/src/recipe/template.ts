/**
 * Recipe templates: `{{params.<path>}}` and `{{outputs.<nodeId>.<path>}}`. A path is dotted keys;
 * `[n]` or a numeric `.n` segment indexes an array, and on an object both read the key `n`. Every
 * reader of recipe templates uses this grammar, so validation, resolution and trace matching agree
 * on what a template is.
 */
const KEY = '[A-Za-z0-9_-]+';
const INDEX = String.raw`\[(?:0|[1-9]\d*)\]`;
const TEMPLATE = String.raw`\{\{(?:params|outputs)\.${KEY}(?:\.${KEY}|${INDEX})*\}\}`;
const EXACT_TEMPLATE = new RegExp(`^${TEMPLATE}$`, 'u');
// Where a template starts: the text from here to the next `}}` must parse as one.
const TEMPLATE_START = /\{\{\s*(?:params|outputs)\./gu;

export type RecipeTemplateSource = 'params' | 'outputs';

export interface RecipeTemplateReference {
  source: RecipeTemplateSource;
  /** Dotted path after the source, with `[n]` written as `.n`. */
  path: string;
}

function toReference(template: string): RecipeTemplateReference {
  const body = template.slice(2, -2);
  const dot = body.indexOf('.');
  return {
    source: body.slice(0, dot) as RecipeTemplateSource,
    path: body.slice(dot + 1).replace(/\[(\d+)\]/gu, '.$1'),
  };
}

/** The reference when `value` is exactly one template, whose resolved value keeps its type. */
export function parseRecipeTemplate(value: string): RecipeTemplateReference | undefined {
  return EXACT_TEMPLATE.test(value) ? toReference(value) : undefined;
}

export function hasRecipeTemplate(value: string): boolean {
  return new RegExp(TEMPLATE, 'u').test(value);
}

/** `value` with each template replaced by `replace(reference, template)`. */
export function replaceRecipeTemplates(
  value: string,
  replace: (reference: RecipeTemplateReference, template: string) => string,
): string {
  return value.replace(new RegExp(TEMPLATE, 'gu'), (template) =>
    replace(toReference(template), template),
  );
}

/** The literal text around the templates in `value`. */
export function splitRecipeTemplates(value: string): string[] {
  return value.split(new RegExp(TEMPLATE, 'gu'));
}

/** Each `{{params.`/`{{outputs.` in `value` that does not parse as a template, up to its `}}`. */
export function findUnsupportedRecipeTemplates(value: string): string[] {
  const unsupported: string[] = [];
  for (const start of value.matchAll(TEMPLATE_START)) {
    const end = value.indexOf('}}', start.index);
    const candidate = end < 0 ? value.slice(start.index) : value.slice(start.index, end + 2);
    if (!EXACT_TEMPLATE.test(candidate)) unsupported.push(candidate);
  }
  return unsupported;
}
