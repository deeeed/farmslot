import { Parser } from 'htmlparser2';

/** Derive model-readable content without base64 images, styles, navigation or
 * executable markup. The retained HTML remains the sole human report. */
export function workerReportText(fileName: string, source: string): string {
  if (!/\.html?$/i.test(fileName)) return source;
  const omitted = new Set(['head', 'script', 'style', 'nav', 'template', 'svg']);
  const blocks = new Set([
    'h1',
    'h2',
    'h3',
    'h4',
    'p',
    'div',
    'li',
    'section',
    'summary',
    'tr',
    'figure',
    'figcaption',
    'pre',
    'dt',
    'dd',
  ]);
  const stack: boolean[] = [];
  const text: string[] = [];
  let hidden = false;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        stack.push(hidden);
        hidden =
          hidden ||
          omitted.has(name) ||
          Object.hasOwn(attributes, 'hidden') ||
          attributes['aria-hidden'] === 'true';
        if (hidden) return;
        if (blocks.has(name) || name === 'br') text.push('\n');
        if (name === 'td' || name === 'th') text.push(' | ');
        if (name === 'img' && attributes.alt) text.push(`[Image: ${attributes.alt}]`);
      },
      ontext(value) {
        if (!hidden) text.push(value);
      },
      onclosetag(name) {
        if (!hidden && blocks.has(name)) text.push('\n');
        hidden = stack.pop() ?? false;
      },
    },
    { decodeEntities: true },
  );
  parser.write(source);
  parser.end();
  return text
    .join('')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
