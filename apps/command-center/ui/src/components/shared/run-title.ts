import { html } from 'lit';

import { type DisplayRun, runDisplayTitle } from '@farmslot/protocol';

/** Thin shared renderer: legacy titles normalize once in the protocol view model. */
export function renderRunTitle(run: DisplayRun, className = '') {
  return html`<span
    class=${className}
    title=${runDisplayTitle(run, Infinity).title}
    style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal"
    >${runDisplayTitle(run).title}</span
  >`;
}
