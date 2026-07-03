import { css, html, LitElement, nothing, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type { ArtifactRef, InteractiveOperatorPacket } from '@farmslot/protocol';
import { Methods, validateInteractiveOperatorPacket } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';
import { colors, fonts, radii, spacing } from '../../styles/theme-tokens.js';
import { gatewayHttpFetch, gatewayResourceUrl } from '../../utils/gateway-origin.js';
import { renderReadyWorkspaceMarkdown } from '../workspace/ready-workspace-markdown.js';

import {
  collectInteractivePacketArtifacts,
  interactivePacketActionRequest,
  interactivePacketArtifactKey,
} from './interactive-operator-packets-model.js';

interface LoadedInteractivePacket {
  artifact: ArtifactRef;
  packet?: InteractiveOperatorPacket;
  bodyText?: string;
  error?: string;
}

export type InteractivePacketArtifactTextLoader = (path: string) => Promise<string>;

@customElement('interactive-operator-packets')
export class InteractiveOperatorPackets extends LitElement {
  static styles = css`
    :host {
      display: block;
      margin-bottom: ${unsafeCSS(spacing.lg)};
      font-family: ${unsafeCSS(fonts.mono)};
    }
    .packet-wrap {
      border: 1px solid ${unsafeCSS(colors.accent)}33;
      border-radius: ${unsafeCSS(radii.md)};
      background: ${unsafeCSS(colors.bgCard)};
      padding: ${unsafeCSS(spacing.md)};
      font-size: 12px;
    }
    .packet-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: ${unsafeCSS(spacing.md)};
      margin-bottom: ${unsafeCSS(spacing.sm)};
    }
    .packet-title {
      color: ${unsafeCSS(colors.textPrimary)};
      font-size: 13px;
      font-weight: 700;
    }
    .packet-summary {
      color: ${unsafeCSS(colors.textMuted)};
      line-height: 1.5;
      margin-top: 3px;
    }
    .packet-badge {
      border: 1px solid ${unsafeCSS(colors.accent)}55;
      color: ${unsafeCSS(colors.accent)};
      border-radius: 999px;
      padding: 2px 8px;
      white-space: nowrap;
      font-size: 11px;
      font-weight: 700;
    }
    .packet-card {
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.sm)};
      padding: ${unsafeCSS(spacing.sm)};
      margin-top: ${unsafeCSS(spacing.sm)};
      background: ${unsafeCSS(colors.bgSurface)};
    }
    .packet-md {
      color: ${unsafeCSS(colors.textSecondary)};
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .packet-md h1,
    .packet-md h2,
    .packet-md h3 {
      color: ${unsafeCSS(colors.textPrimary)};
      margin: 8px 0 4px;
    }
    .packet-md pre {
      overflow-x: auto;
      background: #11131a;
      border-radius: ${unsafeCSS(radii.sm)};
      padding: ${unsafeCSS(spacing.sm)};
    }
    .packet-anchors,
    .packet-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: ${unsafeCSS(spacing.sm)};
    }
    .packet-chip,
    .packet-action {
      border: 1px solid #2a2a44;
      border-radius: ${unsafeCSS(radii.sm)};
      background: ${unsafeCSS(colors.bgCard)};
      color: ${unsafeCSS(colors.textSecondary)};
      padding: 4px 8px;
      font-size: 11px;
    }
    .packet-action {
      cursor: pointer;
      color: ${unsafeCSS(colors.accent)};
      border-color: ${unsafeCSS(colors.accent)}55;
    }
    .packet-action:hover:not(:disabled) {
      background: ${unsafeCSS(colors.accent)}14;
    }
    .packet-action:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .packet-error {
      color: ${unsafeCSS(colors.statusFail)};
      border-color: ${unsafeCSS(colors.statusFail)}55;
    }
    .packet-feedback {
      color: ${unsafeCSS(colors.textMuted)};
      margin-top: ${unsafeCSS(spacing.sm)};
    }
  `;

  @property() runId = '';
  @property() slotId: string | null = null;
  @property({ attribute: false }) artifacts: ArtifactRef[] = [];
  @property({ attribute: false }) artifactTextLoader: InteractivePacketArtifactTextLoader | null =
    null;

  @state() private _packets: LoadedInteractivePacket[] = [];
  @state() private _feedback = '';
  @state() private _loading = false;
  private _packetLoadKey = '';
  private _packetLoadSequence = 0;

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has('runId') || changed.has('artifacts')) this._syncPacketArtifacts();
  }

  private _artifactUrl(path: string): string {
    const params = new URLSearchParams({ runId: this.runId, path });
    return gatewayResourceUrl(`/api/run-artifact?${params.toString()}`);
  }

  private async _readArtifactText(path: string): Promise<string> {
    if (this.artifactTextLoader) return this.artifactTextLoader(path);
    const res = await gatewayHttpFetch(
      `/api/run-artifact?${new URLSearchParams({ runId: this.runId, path })}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  private _syncPacketArtifacts(): void {
    const packetArtifacts = collectInteractivePacketArtifacts(this.artifacts);
    const nextKey = this.runId
      ? `${this.runId}\n${interactivePacketArtifactKey(packetArtifacts)}`
      : '';
    if (nextKey === this._packetLoadKey) return;
    this._packetLoadKey = nextKey;
    this._packetLoadSequence += 1;
    if (!this.runId || packetArtifacts.length === 0) {
      this._packets = [];
      this._loading = false;
      return;
    }
    void this._loadPackets(packetArtifacts, nextKey, this._packetLoadSequence);
  }

  private async _loadPackets(
    packetArtifacts: ArtifactRef[],
    loadKey: string,
    loadSequence: number,
  ): Promise<void> {
    this._loading = true;
    const loaded = await Promise.all(
      packetArtifacts.map(async (artifact): Promise<LoadedInteractivePacket> => {
        try {
          const raw = await this._readArtifactText(artifact.path);
          const parsed = parseJson(raw);
          const validation = validateInteractiveOperatorPacket(parsed);
          if (!validation.ok || !validation.packet) {
            return { artifact, error: validation.errors.join('; ') || 'Invalid packet' };
          }
          const packet = validation.packet;
          const bodyText = packet.body.path
            ? await this._readArtifactText(packet.body.path)
            : packet.body.text;
          return { artifact, packet, bodyText };
        } catch (err) {
          return { artifact, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    if (loadSequence !== this._packetLoadSequence || loadKey !== this._packetLoadKey) return;
    this._packets = loaded;
    this._loading = false;
  }

  private async _copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // CDP/background tabs can expose the Clipboard API while rejecting writes
        // because the document is not focused; the textarea path still handles
        // user-initiated clicks in those cases.
      }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const copied = document.execCommand('copy');
    ta.remove();
    if (!copied) throw new Error('Clipboard copy was not accepted by the browser.');
  }

  private async _runAction(packet: InteractiveOperatorPacket, actionId: string): Promise<void> {
    const action = packet.actions?.find((candidate) => candidate.id === actionId);
    if (!action) return;
    const request = interactivePacketActionRequest(action);
    if (!request) {
      this._feedback = `Action "${action.label}" is missing required payload fields.`;
      return;
    }
    const requiresConfirmation =
      action.safety === 'operator-confirmed' ||
      request.kind === 'terminal.send' ||
      request.kind === 'decision.resolve';
    if (
      requiresConfirmation &&
      !window.confirm(`Run "${action.label}" for packet "${packet.title}"?`)
    ) {
      return;
    }
    try {
      if (request.kind === 'copy') {
        await this._copyText(request.text);
      } else if (request.kind === 'open-artifact') {
        window.open(this._artifactUrl(request.artifactPath), '_blank', 'noopener');
      } else if (request.kind === 'terminal.send') {
        if (!this.slotId) throw new Error('Run is not attached to a slot.');
        await gateway.request(Methods.TERMINAL_SEND, {
          slotId: this.slotId,
          runId: this.runId,
          text: request.text,
          enter: true,
        });
      } else if (request.kind === 'decision.resolve') {
        await gateway.request(Methods.RUN_RESOLVE_DECISION, {
          runId: this.runId,
          decisionId: request.decisionId,
          actionId: request.actionId,
        });
      }
      this._feedback = `Completed "${action.label}" for ${packet.id}.`;
    } catch (err) {
      this._feedback = `Action failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private _renderPacket(entry: LoadedInteractivePacket) {
    if (!entry.packet) {
      return html`
        <div class="packet-card packet-error">
          <div class="packet-title">Invalid interactive packet</div>
          <div class="packet-summary">${entry.artifact.path}</div>
          <div class="packet-feedback">${entry.error}</div>
        </div>
      `;
    }
    const packet = entry.packet;
    return html`
      <div class="packet-card">
        <div class="packet-head">
          <div>
            <div class="packet-title">${packet.title}</div>
            ${packet.summary ? html`<div class="packet-summary">${packet.summary}</div>` : nothing}
          </div>
          <span class="packet-badge">${packet.intent}</span>
        </div>
        <div class="packet-md">
          ${unsafeHTML(renderReadyWorkspaceMarkdown(entry.bodyText ?? packet.body.text ?? ''))}
        </div>
        ${packet.anchors?.length
          ? html`
              <div class="packet-anchors">
                ${packet.anchors.map((anchor) => {
                  const artifactPath = anchor.artifactPath;
                  return html`
                    ${artifactPath
                      ? html`
                          <button
                            class="packet-chip packet-action"
                            title=${artifactPath}
                            @click=${() =>
                              window.open(this._artifactUrl(artifactPath), '_blank', 'noopener')}
                          >
                            ${anchor.label}${anchor.line ? `:${anchor.line}` : ''}
                          </button>
                        `
                      : html`
                          <span class="packet-chip" title=${anchor.id}
                            >${anchor.label}${anchor.line ? `:${anchor.line}` : ''}</span
                          >
                        `}
                  `;
                })}
              </div>
            `
          : nothing}
        ${packet.actions?.length
          ? html`
              <div class="packet-actions">
                ${packet.actions.map(
                  (action) => html`
                    <button
                      class="packet-action"
                      @click=${() => this._runAction(packet, action.id)}
                    >
                      ${action.label}
                    </button>
                  `,
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  render() {
    if (!this._packets.length && !this._loading) return nothing;
    return html`
      <section class="packet-wrap" data-testid="interactive-operator-packets">
        <div class="packet-head">
          <div>
            <div class="packet-title">Interactive packets</div>
            <div class="packet-summary">
              Agent-authored review surfaces with artifact anchors and confirmed actions.
            </div>
          </div>
          <span class="packet-badge">${this._loading ? 'loading' : this._packets.length}</span>
        </div>
        ${this._packets.map((entry) => this._renderPacket(entry))}
        ${this._feedback ? html`<div class="packet-feedback">${this._feedback}</div>` : nothing}
      </section>
    `;
  }
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

declare global {
  interface HTMLElementTagNameMap {
    'interactive-operator-packets': InteractiveOperatorPackets;
  }
}
