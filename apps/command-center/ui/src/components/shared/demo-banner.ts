import { html, LitElement, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';

interface ImportMetaWithEnv extends ImportMeta {
  env: Record<string, string | undefined>;
}

/**
 * Demo-only red monitoring banner for Farmslot dispatch smoke tests
 * (deeeed/farmslot#28). Gated entirely behind the `VITE_FARMSLOT_DEMO_BANNER`
 * build/env flag — renders nothing in normal usage. DO NOT ship enabled.
 *
 * Renders in light DOM (no shadow root) so the banner copy is reachable by
 * `document.body.innerText`, which recipe `ui.wait_for` text assertions rely on.
 * Styles are inline since `static styles` only applies to shadow DOM.
 */
export const DEMO_BANNER_TEXT = 'FARMSLOT DEMO: PARALLEL RUN MONITORING';

function demoBannerEnabled(): boolean {
  const env = (import.meta as ImportMetaWithEnv).env;
  const flag = env.VITE_FARMSLOT_DEMO_BANNER;
  return flag === '1' || flag === 'true';
}

const BANNER_STYLE = [
  'display:flex',
  'align-items:center',
  'justify-content:center',
  'padding:8px 16px',
  'background:#d40000',
  'border-bottom:2px solid #ff5555',
  'color:#ffffff',
  "font-family:'SF Mono','Cascadia Code','Fira Code','JetBrains Mono',monospace",
  'font-size:0.75rem',
  'font-weight:700',
  'letter-spacing:0.08em',
  'text-align:center',
  'text-transform:uppercase',
].join(';');

@customElement('demo-banner')
export class DemoBanner extends LitElement {
  // Light DOM so the banner text is visible to text-based recipe assertions.
  protected createRenderRoot() {
    return this;
  }

  render() {
    if (!demoBannerEnabled()) return nothing;
    return html`<div role="status" style=${BANNER_STYLE}>${DEMO_BANNER_TEXT}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'demo-banner': DemoBanner;
  }
}
