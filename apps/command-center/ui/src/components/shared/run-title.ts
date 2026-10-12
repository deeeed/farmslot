import { html } from 'lit';

import { type DisplayRun, runDisplayTitle } from '@farmslot/protocol';

/** Thin shared renderer: legacy titles normalize once in the protocol view model. */
export function renderRunTitle(run: DisplayRun, className = '') {
  // These surfaces previously showed the generated summary; retain that source.
  return html`<span
    class=${className}
    title=${runDisplayTitle(run, Infinity, 'summary').title}
    style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal"
    >${runDisplayTitle(run, 120, 'summary').title}</span
  >`;
}
