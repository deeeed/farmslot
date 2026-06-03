import { html as diff2html } from 'diff2html';
import { ColorSchemeType } from 'diff2html/lib-esm/types';
import { html, LitElement, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type { ImprovementFileChange } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import 'diff2html/bundles/css/diff2html.min.css';

import { gateway } from '../gateway-client.js';
import { colors, fonts, radii, spacing } from '../styles/theme-tokens.js';
import { adoptDocumentCss } from '../utils/shadow-css.js';

// ─── Mock data for standalone testing ───

const MOCK_LEARNING = `Step 8 should check if metro is running before attempting reload. When metro crashes mid-task, the reload command hangs for 60s before timing out. Adding a health check before reload would save time and provide a clearer error message.

Also, step 14 should capture a screenshot BEFORE attempting the fix validation, not just after. This gives a baseline to compare against.`;

const MOCK_CHANGES: ImprovementFileChange[] = [
  {
    filePath: 'projects/example-mobile-farm/templates/worker/fix-bug.md',
    before: `8. Reload the app to verify your changes:
   \`\`\`bash
   yarn a:reload
   \`\`\`
   Wait for the app to fully reload before proceeding.`,
    after: `8. Check metro is running, then reload the app:
   \`\`\`bash
   # Verify metro is alive before reload (avoids 60s hang if crashed)
   curl -sf http://localhost:{{port}}/status || { echo "Metro not running — restart with: yarn watch"; exit 1; }
   yarn a:reload
   \`\`\`
   Wait for the app to fully reload before proceeding.`,
  },
  {
    filePath: 'projects/example-mobile-farm/templates/worker/fix-bug.md',
    before: `14. Validate the fix meets acceptance criteria:
   - Run the repro steps from the ticket
   - Confirm the bug no longer occurs
   - Take a screenshot of the fixed state`,
    after: `14. Validate the fix meets acceptance criteria:
   - Take a BEFORE screenshot for baseline comparison
   - Run the repro steps from the ticket
   - Confirm the bug no longer occurs
   - Take an AFTER screenshot of the fixed state`,
  },
];

const MOCK_RATIONALE =
  'Adds a metro health check before reload in step 8 to prevent 60s hangs when metro has crashed. Also reorders step 14 to capture a baseline screenshot before validation, enabling before/after comparison.';

// ─── Unified diff generation ───

function toUnifiedDiff(change: ImprovementFileChange): string {
  const beforeLines = change.before.split('\n');
  const afterLines = change.after.split('\n');
  const maxLines = Math.max(beforeLines.length, afterLines.length);

  let diff = `--- a/${change.filePath}\n+++ b/${change.filePath}\n`;
  diff += `@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n`;

  // Simple: show all before as removed, all after as added
  // For better diffs we'd use a proper diff algorithm, but this is clear enough
  for (const line of beforeLines) {
    diff += `-${line}\n`;
  }
  for (const line of afterLines) {
    diff += `+${line}\n`;
  }
  return diff;
}

// ─── Component ───

@customElement('improvement-dev')
export class ImprovementDev extends LitElement {
  @state() private _learning = MOCK_LEARNING;
  @state() private _changes: ImprovementFileChange[] = MOCK_CHANGES;
  @state() private _rationale = MOCK_RATIONALE;
  @state() private _chatInput = '';
  @state() private _chatMessages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  @state() private _chatLoading = false;
  @state() private _applyResult: { passed: boolean; output: string } | null = null;
  @state() private _generating = false;
  @state() private _viewMode: 'side-by-side' | 'line-by-line' = 'side-by-side';
  @state() private _customLearning = '';

  // Light DOM for diff2html CSS
  protected override createRenderRoot() {
    return this;
  }

  override firstUpdated() {
    adoptDocumentCss(
      this,
      (href, text) => href.includes('diff2html') || text.includes('.d2h-'),
      'diff2html',
    );
  }

  private _renderDiff(change: ImprovementFileChange): string {
    const udiff = toUnifiedDiff(change);
    return diff2html(udiff, {
      outputFormat: this._viewMode === 'side-by-side' ? 'side-by-side' : 'line-by-line',
      drawFileList: false,
      matching: 'lines',
      colorScheme: ColorSchemeType.DARK,
    });
  }

  private async _generateFromLearning() {
    if (!this._customLearning.trim()) return;
    this._generating = true;
    this._changes = [];
    this._rationale = '';
    this._chatMessages = [];

    try {
      // Call the real LLM via gateway — use llm.auth.test pattern to verify connectivity first
      const testRes = (await gateway.request(Methods.LLM_CONFIG_GET, {})) as any;
      const provider = testRes.defaultProvider;
      const model = testRes.improvementModel ?? 'standard';

      // We can't call improvement.analyze directly (it needs a real run),
      // so we'll use the chat method with a system prompt that simulates it
      const systemPrompt = `You are a template improvement analyst. Given this worker learning, propose changes to project template files.

Learning: ${this._customLearning}

Respond with JSON:
{
  "rationale": "why this change helps",
  "proposedChanges": [{ "filePath": "projects/example-mobile-farm/templates/worker/fix-bug.md", "before": "original text", "after": "modified text" }]
}`;

      const chatRes = (await gateway.request(Methods.LLM_AUTH_TEST, {
        provider,
        model,
      })) as any;

      if (!chatRes.ok) {
        this._rationale = `LLM test failed: ${chatRes.error}. Check #config/llm for provider setup.`;
        this._generating = false;
        return;
      }

      // Use improvement.chat with a mock context to generate
      // For now, show the mock data with custom learning text
      this._learning = this._customLearning;
      this._changes = MOCK_CHANGES;
      this._rationale = `[Mock] Provider ${provider}/${model} is working. In production, the improvement engine would analyze this learning against actual project files and generate real diffs.`;
    } catch (err) {
      this._rationale = `Error: ${(err as Error).message}`;
    }
    this._generating = false;
  }

  private async _sendChat() {
    if (!this._chatInput.trim() || this._chatLoading) return;
    const msg = this._chatInput;
    this._chatInput = '';
    this._chatMessages = [...this._chatMessages, { role: 'user', text: msg }];
    this._chatLoading = true;

    try {
      // Try real gateway improvement.chat if available
      const res = (await gateway.request(Methods.IMPROVEMENT_CHAT, {
        runId: 'dev-mock',
        decisionId: 'dev-mock',
        message: msg,
      })) as any;
      this._chatMessages = [...this._chatMessages, { role: 'assistant', text: res.text }];
      if (res.updatedChanges) {
        this._changes = res.updatedChanges;
      }
    } catch {
      // Fallback: simulate a response
      this._chatMessages = [
        ...this._chatMessages,
        {
          role: 'assistant',
          text: `[Simulated] I would refine the diff based on: "${msg}". In production, this calls the LLM with the full improvement context and updates the proposed changes.`,
        },
      ];
    }
    this._chatLoading = false;
  }

  private _simulateApply() {
    this._applyResult = {
      passed: true,
      output: `Applied ${this._changes.length} file(s). Staged in git.\n\nyarn typecheck: passed (0 errors)`,
    };
  }

  override render() {
    return html`
      <style>
        improvement-dev {
          display: block;
          max-width: 1200px;
          margin: 0 auto;
          padding: ${spacing.lg};
          color: ${colors.textPrimary};
          font-family: ${fonts.mono};
        }
        .imp-header {
          margin-bottom: ${spacing.lg};
        }
        .imp-header h2 {
          color: ${colors.accent};
          margin: 0 0 ${spacing.xs};
          font-size: 1.2rem;
        }
        .imp-header p {
          color: ${colors.textMuted};
          font-size: 0.85rem;
          margin: 0;
        }

        .imp-section {
          margin-bottom: ${spacing.lg};
        }
        .imp-section-title {
          color: ${colors.textPrimary};
          font-size: 0.95rem;
          font-weight: 600;
          margin: 0 0 ${spacing.sm};
          padding-bottom: ${spacing.xs};
          border-bottom: 1px solid #2a2a44;
        }

        .imp-learning {
          background: ${colors.bgCard};
          border: 1px solid #2a2a44;
          border-radius: ${radii.md};
          padding: ${spacing.md};
          font-size: 0.85rem;
          line-height: 1.5;
          white-space: pre-wrap;
          color: ${colors.textMuted};
        }
        .imp-rationale {
          background: rgba(99, 102, 241, 0.08);
          border: 1px solid rgba(99, 102, 241, 0.2);
          border-radius: ${radii.md};
          padding: ${spacing.md};
          font-size: 0.85rem;
          line-height: 1.5;
          color: ${colors.textPrimary};
        }

        .imp-diff-file {
          margin-bottom: ${spacing.md};
          border: 1px solid #2a2a44;
          border-radius: ${radii.md};
          overflow: hidden;
        }
        .imp-diff-file-header {
          background: ${colors.bgSurface};
          padding: ${spacing.xs} ${spacing.md};
          font-size: 0.8rem;
          color: ${colors.accent};
          font-weight: 600;
          border-bottom: 1px solid #2a2a44;
        }

        .imp-view-toggle {
          display: flex;
          gap: ${spacing.xs};
          margin-bottom: ${spacing.sm};
        }
        .imp-view-btn {
          background: ${colors.bgCard};
          color: ${colors.textMuted};
          border: 1px solid #2a2a44;
          border-radius: ${radii.sm};
          padding: 4px 12px;
          cursor: pointer;
          font-family: ${fonts.mono};
          font-size: 0.8rem;
        }
        .imp-view-btn.active {
          border-color: ${colors.accent};
          color: ${colors.accent};
        }

        .imp-chat {
          margin-top: ${spacing.md};
        }
        .imp-chat-messages {
          max-height: 300px;
          overflow-y: auto;
          background: ${colors.bgCard};
          border: 1px solid #2a2a44;
          border-radius: ${radii.md} ${radii.md} 0 0;
          padding: ${spacing.md};
        }
        .imp-chat-msg {
          margin-bottom: ${spacing.sm};
          font-size: 0.85rem;
          line-height: 1.4;
        }
        .imp-chat-msg.user {
          color: ${colors.accent};
        }
        .imp-chat-msg.user::before {
          content: 'You: ';
          font-weight: 600;
        }
        .imp-chat-msg.assistant {
          color: ${colors.textPrimary};
        }
        .imp-chat-msg.assistant::before {
          content: 'LLM: ';
          font-weight: 600;
          color: ${colors.statusOk};
        }
        .imp-chat-input-row {
          display: flex;
          gap: ${spacing.xs};
          border: 1px solid #2a2a44;
          border-top: none;
          border-radius: 0 0 ${radii.md} ${radii.md};
          background: ${colors.bgSurface};
          padding: ${spacing.xs};
        }
        .imp-chat-input {
          flex: 1;
          background: ${colors.bgCard};
          color: ${colors.textPrimary};
          border: 1px solid #2a2a44;
          border-radius: ${radii.sm};
          padding: 6px 10px;
          font-family: ${fonts.mono};
          font-size: 0.85rem;
        }
        .imp-chat-send {
          background: ${colors.accent};
          color: white;
          border: none;
          border-radius: ${radii.sm};
          padding: 6px 16px;
          cursor: pointer;
          font-family: ${fonts.mono};
          font-size: 0.85rem;
        }
        .imp-chat-send:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .imp-actions {
          display: flex;
          gap: ${spacing.sm};
          margin-top: ${spacing.md};
        }
        .imp-btn {
          padding: 8px 20px;
          border-radius: ${radii.sm};
          cursor: pointer;
          font-family: ${fonts.mono};
          font-size: 0.85rem;
          border: 1px solid;
        }
        .imp-btn-apply {
          background: ${colors.statusOk};
          color: #000;
          border-color: ${colors.statusOk};
          font-weight: 600;
        }
        .imp-btn-dismiss {
          background: transparent;
          color: ${colors.textMuted};
          border-color: #2a2a44;
        }

        .imp-toast {
          margin-top: ${spacing.sm};
          padding: ${spacing.sm} ${spacing.md};
          border-radius: ${radii.sm};
          font-size: 0.85rem;
          white-space: pre-wrap;
        }
        .imp-toast.pass {
          background: rgba(0, 255, 136, 0.1);
          color: ${colors.statusOk};
          border: 1px solid rgba(0, 255, 136, 0.2);
        }
        .imp-toast.fail {
          background: rgba(255, 68, 68, 0.1);
          color: ${colors.statusFail};
          border: 1px solid rgba(255, 68, 68, 0.2);
        }

        .imp-generate {
          display: flex;
          gap: ${spacing.xs};
          margin-bottom: ${spacing.md};
        }
        .imp-generate textarea {
          flex: 1;
          background: ${colors.bgCard};
          color: ${colors.textPrimary};
          border: 1px solid #2a2a44;
          border-radius: ${radii.sm};
          padding: 8px 10px;
          font-family: ${fonts.mono};
          font-size: 0.85rem;
          resize: vertical;
          min-height: 60px;
        }
        .imp-generate-btn {
          background: ${colors.accent};
          color: white;
          border: none;
          border-radius: ${radii.sm};
          padding: 8px 16px;
          cursor: pointer;
          font-family: ${fonts.mono};
          font-size: 0.85rem;
          align-self: flex-end;
        }
      </style>

      <div class="imp-header">
        <h2>Improvement Playground</h2>
        <p>
          Simulate the self-improving feedback loop: learning → LLM analysis → diff proposal → chat
          refinement → apply
        </p>
      </div>

      <!-- Generate from custom learning -->
      <div class="imp-section">
        <div class="imp-section-title">Generate from Learning</div>
        <div class="imp-generate">
          <textarea
            placeholder="Paste a worker learning here and click Generate to see what the LLM would propose..."
            .value=${this._customLearning}
            @input=${(e: Event) => (this._customLearning = (e.target as HTMLTextAreaElement).value)}
          ></textarea>
          <button
            class="imp-generate-btn"
            @click=${this._generateFromLearning}
            ?disabled=${this._generating}
          >
            ${this._generating ? 'Generating...' : 'Generate'}
          </button>
        </div>
      </div>

      <!-- Worker Learning -->
      <div class="imp-section">
        <div class="imp-section-title">Worker Learning</div>
        <div class="imp-learning">${this._learning}</div>
      </div>

      <!-- Rationale -->
      <div class="imp-section">
        <div class="imp-section-title">LLM Rationale</div>
        <div class="imp-rationale">${this._rationale}</div>
      </div>

      <!-- Proposed Diffs -->
      <div class="imp-section">
        <div class="imp-section-title">
          Proposed Changes (${this._changes.length} file${this._changes.length !== 1 ? 's' : ''})
        </div>
        <div class="imp-view-toggle">
          <button
            class="imp-view-btn ${this._viewMode === 'side-by-side' ? 'active' : ''}"
            @click=${() => (this._viewMode = 'side-by-side')}
          >
            Side by Side
          </button>
          <button
            class="imp-view-btn ${this._viewMode === 'line-by-line' ? 'active' : ''}"
            @click=${() => (this._viewMode = 'line-by-line')}
          >
            Line by Line
          </button>
        </div>
        ${this._changes.map(
          (c) => html`
            <div class="imp-diff-file">
              <div class="imp-diff-file-header">${c.filePath}</div>
              ${unsafeHTML(this._renderDiff(c))}
            </div>
          `,
        )}
      </div>

      <!-- Chat Refinement -->
      <div class="imp-section">
        <div class="imp-section-title">Chat Refinement</div>
        <div class="imp-chat">
          ${this._chatMessages.length > 0
            ? html`
                <div class="imp-chat-messages">
                  ${this._chatMessages.map(
                    (m) => html` <div class="imp-chat-msg ${m.role}">${m.text}</div> `,
                  )}
                </div>
              `
            : nothing}
          <div class="imp-chat-input-row">
            <input
              class="imp-chat-input"
              placeholder="Refine the proposal... e.g. 'also add a warning comment above the curl command'"
              .value=${this._chatInput}
              @input=${(e: Event) => (this._chatInput = (e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && this._sendChat()}
            />
            <button class="imp-chat-send" @click=${this._sendChat} ?disabled=${this._chatLoading}>
              ${this._chatLoading ? '...' : 'Send'}
            </button>
          </div>
        </div>
      </div>

      <!-- Actions -->
      <div class="imp-section">
        <div class="imp-section-title">Actions</div>
        <div class="imp-actions">
          <button class="imp-btn imp-btn-apply" @click=${this._simulateApply}>Apply Changes</button>
          <button class="imp-btn imp-btn-dismiss" @click=${() => (this._applyResult = null)}>
            Dismiss
          </button>
        </div>
        ${this._applyResult
          ? html`
              <div class="imp-toast ${this._applyResult.passed ? 'pass' : 'fail'}">
                ${this._applyResult.output}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}
