import { html } from 'lit';

import { type TextLinkPart, textLinkParts } from '@farmslot/protocol/client-cache';

import { putCapped } from './markdown.js';

/** Each message text's parts, so a view rendering often splits a text once; least recent out. */
const partsByText = new Map<string, TextLinkPart[]>();
const PARTS_LIMIT = 500;

/**
 * Plain message text whose http(s) addresses are links opening beside Command Center. Lit
 * escapes the text, and only http(s) addresses become `href`s, so nothing needs sanitizing.
 */
export function linkedText(text: string) {
  let parts = partsByText.get(text);
  if (parts) partsByText.delete(text);
  else parts = textLinkParts(text);
  putCapped(partsByText, text, parts, PARTS_LIMIT);
  return parts.map(({ text: run, href }) =>
    href ? html`<a href="${href}" target="_blank" rel="noopener noreferrer">${run}</a>` : run,
  );
}
