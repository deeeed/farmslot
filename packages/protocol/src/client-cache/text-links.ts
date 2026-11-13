/** A run of message text: plain, or a web address the reader can open (`href`). */
export interface TextLinkPart {
  text: string;
  href?: string;
}

// An http or https address that starts a word, up to whitespace, a quote, a backtick or an
// angle bracket. Every other scheme (javascript:, file:, app schemes) stays plain text.
const WEB_ADDRESS = /\bhttps?:\/\/[^\s<>"`]+/gi;
// A host must follow the scheme: a letter, a digit, or an IPv6 bracket.
const WITH_HOST = /^https?:\/\/[a-z0-9[]/i;
// Punctuation that ends a sentence, not an address.
const TRAILING = ".,;:!?'*";
const OPENING: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

const count = (text: string, char: string) => text.split(char).length - 1;

/** The address without the punctuation after it; a closing bracket stays when it closes one inside. */
function trimAddress(address: string): string {
  let end = address.length;
  while (end > 0) {
    const last = address[end - 1];
    const opening = OPENING[last];
    const head = address.slice(0, end);
    if (TRAILING.includes(last) || (opening && count(head, last) > count(head, opening))) end--;
    else break;
  }
  return address.slice(0, end);
}

/**
 * Message text split into plain runs and http(s) links, in order; joining every part's text
 * gives the text back. Parse once per text: a renderer keeps the result while the text is the same.
 */
export function textLinkParts(text: string): TextLinkPart[] {
  if (!text.includes('://')) return text ? [{ text }] : [];
  const parts: TextLinkPart[] = [];
  let at = 0;
  for (const match of text.matchAll(WEB_ADDRESS)) {
    const href = trimAddress(match[0]);
    if (!WITH_HOST.test(href)) continue;
    if (match.index > at) parts.push({ text: text.slice(at, match.index) });
    parts.push({ text: href, href });
    at = match.index + href.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
