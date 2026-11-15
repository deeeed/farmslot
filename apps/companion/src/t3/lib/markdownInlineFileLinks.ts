// From T3 Code apps/mobile/src/lib/markdownDocument.ts (b8c2cfad): markdownWithInlineFileLinks,
// which turns inline code that names a file, such as `src/app.ts:12`, into a link the renderer draws
// as a file chip. The parse and traversal are T3's; Companion keeps only the file-link rewrite (not
// T3's HTML, table-break and Windows-path passes).
import type { Root, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const parser = unified().use(remarkParse).use(remarkGfm);
type MarkdownNode = Root | RootContent;

interface MarkdownEdit {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

function applyMarkdownEdits(markdown: string, edits: MarkdownEdit[]): string {
  if (edits.length === 0) return markdown;
  const parts: string[] = [];
  let offset = 0;
  // AST traversal emits disjoint edits in source order.
  for (const edit of edits) {
    parts.push(markdown.slice(offset, edit.start), edit.content);
    offset = edit.end;
  }
  parts.push(markdown.slice(offset));
  return parts.join('');
}

// Start only at the beginning of a backtick run to avoid retrying every suffix.
const INLINE_CODE_SPAN = /(?<!`)`+([^`\r\n]+)`+/g;

export function markdownWithInlineFileLinks(markdown: string, fileLink: RegExp): string {
  let linkFiles = false;
  for (const [, code] of markdown.matchAll(INLINE_CODE_SPAN)) {
    if (fileLink.test(code!.trim())) {
      linkFiles = true;
      break;
    }
  }
  if (!linkFiles) return markdown;
  const edits: MarkdownEdit[] = [];
  // Code blocks have no children and link labels are skipped, so only prose code spans change.
  const visit = (node: MarkdownNode) => {
    if (node.type === 'inlineCode') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const escaped = node.value.replace(/[\\[\]&]/g, '\\$&');
      if (
        start !== undefined &&
        end !== undefined &&
        fileLink.test(node.value) &&
        !/[<>]/.test(node.value)
      )
        edits.push({ start, end, content: `[${escaped}](<${escaped}>)` });
    } else if (node.type !== 'link' && node.type !== 'linkReference' && 'children' in node)
      node.children.forEach(visit);
  };
  visit(parser.parse(markdown));
  return applyMarkdownEdits(markdown, edits);
}
