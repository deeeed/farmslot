// T3 Code's markdownWithInlineFileLinks (apps/mobile/src/lib/markdownDocument.ts, b8c2cfad) turns
// inline code that names a file, such as `src/app.ts:12`, into a link the renderer draws as a file
// chip. T3 walks a remark AST; this scans lines instead, so Companion does not ship unified and
// remark. Fenced code, and code already inside a link label, stays as written.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE_SPAN = /(?<!`)(`+)([^`\r\n]+?)\1(?!`)/g;

function linkedSpans(line: string, fileLink: RegExp): string {
  return line.replace(INLINE_CODE_SPAN, (span, _ticks: string, code: string, offset: number) => {
    const value = code.trim();
    const inLabel = line[offset - 1] === '[' && line.startsWith('](', offset + span.length);
    if (inLabel || /[<>]/.test(value) || !fileLink.test(value)) return span;
    const escaped = value.replace(/[\\[\]&]/g, '\\$&');
    return `[${escaped}](<${escaped}>)`;
  });
}

export function markdownWithInlineFileLinks(markdown: string, fileLink: RegExp): string {
  if (!markdown.includes('`')) return markdown;
  let fence: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      return linkedSpans(line, fileLink);
    })
    .join('\n');
}
