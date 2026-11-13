/** A run of message text: plain, or a web address the reader can open (`href`). */
export interface TextLinkPart {
  text: string;
  href?: string;
}

// An http or https address after the start, whitespace or punctuation (so `_https://…_` links),
// up to whitespace, a quote, a backtick, an angle bracket, an invisible or control character
// (zero-width, soft hyphen, bidi marks and isolates, C0/C1) or CJK punctuation (the ideographic
// space, 。、「」『』【】〈〉《》〔〕 and （），：；！？). Those stay visible in the text but never enter
// a link; CJK letters such as 々 and 〆 stay part of a path. Every other scheme (javascript:,
// file:, app schemes) stays plain text. A host starting with a non-ASCII letter
// (`https://ąbc.pl`) stays plain; its punycode form links.
const WEB_ADDRESS =
  /(^|[^a-z0-9])(https?:\/\/[^\s<>"`\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u00ad\u061c\u180e\u2060-\u2069\ufeff\u3000-\u3002\u3008-\u3011\u3014\u3015\uff01\uff08\uff09\uff0c\uff1a\uff1b\uff1f]+)/gi;
// A host must follow the scheme: a letter, a digit, or an IPv6 bracket.
const WITH_HOST = /^https?:\/\/[a-z0-9[]/i;
// Punctuation that ends a sentence or emphasis, not an address.
const TRAILING = ".,;:!?'*_";
const OPENING: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

const count = (text: string, char: string) => text.split(char).length - 1;

/**
 * The address without the punctuation after it; a closing bracket stays when it closes one inside.
 * Linear: trimming removes only closers and punctuation, never openers, so each closer's excess
 * over its opener is counted once and decremented as closers come off.
 */
function trimAddress(address: string): string {
  const unclosed: Record<string, number> = {};
  for (const [close, open] of Object.entries(OPENING))
    unclosed[close] = count(address, close) - count(address, open);
  let end = address.length;
  while (end > 0) {
    const last = address[end - 1];
    if (TRAILING.includes(last)) end--;
    else if (unclosed[last] > 0) {
      unclosed[last]--;
      end--;
    } else break;
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
    const href = trimAddress(match[2]);
    if (!WITH_HOST.test(href)) continue;
    const start = match.index + match[1].length;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ text: href, href });
    at = start + href.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
