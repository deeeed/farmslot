import DOMPurify from 'dompurify';
import { html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { marked } from 'marked';

import type { PRReviewThread } from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from '../../gateway-client.js';

import { prCommentsPanelStyles } from './pr-comments-panel-styles.js';

// Configure marked for compact output
marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(raw);
}

type FilterMode = 'unresolved' | 'resolved' | 'outdated' | 'all';
type AuthorFilter = 'all' | 'human' | 'bugbot' | 'cursor';

const BOT_AUTHORS = new Set([
  'github-actions[bot]',
  'bugbot',
  'cursor-review',
  'cursor[bot]',
  'coderabbitai[bot]',
]);

function isBot(author: string): boolean {
  return BOT_AUTHORS.has(author) || author.endsWith('[bot]');
}

function authorCategory(author: string): 'bugbot' | 'cursor' | 'human' {
  const lower = author.toLowerCase();
  if (lower.includes('bugbot') || lower.includes('coderabbit')) return 'bugbot';
  if (lower.includes('cursor')) return 'cursor';
  return 'human';
}

@customElement('pr-comments-panel')
export class PRCommentsPanel extends LitElement {
  @property({ type: Array }) threads: PRReviewThread[] = [];
  @property({ type: Number }) pr = 0;
  @property({ type: String }) repo = '';
  @property({ type: Boolean }) loading = false;
  @property({ type: String }) currentUser = '';

  @state() private _filter: FilterMode = 'unresolved';
  @state() private _authorFilter: AuthorFilter = 'all';
  @state() private _expandedThread: string | null = null;
  @state() private _replyingTo: string | null = null;
  @state() private _replyText = '';
  @state() private _replySubmitting = false;
  @state() private _newCommentPath = '';
  @state() private _newCommentLine = 0;
  @state() private _newCommentText = '';
  @state() private _newCommentSubmitting = false;
  @state() private _editingComment: number | null = null;
  @state() private _editText = '';
  @state() private _editSubmitting = false;
  @state() private _deleteConfirm: number | null = null;
  @state() private _reviewBody = '';
  @state() private _reviewSubmitting = false;
  @state() private _showReviewForm = false;

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('start-new-comment', ((e: CustomEvent) => {
      this._newCommentPath = e.detail.path;
      this._newCommentLine = e.detail.line;
      this._newCommentText = '';
      requestAnimationFrame(() => {
        const textarea = this.shadowRoot?.querySelector(
          '.new-comment-input',
        ) as HTMLTextAreaElement;
        textarea?.focus();
      });
    }) as EventListener);
  }

  static styles = prCommentsPanelStyles;

  private _filteredThreads(): PRReviewThread[] {
    let threads = this.threads;

    // Status filter
    switch (this._filter) {
      case 'unresolved':
        threads = threads.filter((t) => !t.resolved);
        break;
      case 'resolved':
        threads = threads.filter((t) => t.resolved);
        break;
      case 'outdated':
        threads = threads.filter((t) => t.outdated);
        break;
    }

    // Author filter
    if (this._authorFilter !== 'all') {
      threads = threads.filter((t) => {
        const firstAuthor = t.comments[0]?.author ?? '';
        const cat = authorCategory(firstAuthor);
        return cat === this._authorFilter;
      });
    }

    return threads;
  }

  private _threadsByFile(threads: PRReviewThread[]): Map<string, PRReviewThread[]> {
    const groups = new Map<string, PRReviewThread[]>();
    for (const t of threads) {
      const existing = groups.get(t.path) ?? [];
      existing.push(t);
      groups.set(t.path, existing);
    }
    return groups;
  }

  private _counts() {
    const all = this.threads;
    return {
      unresolved: all.filter((t) => !t.resolved).length,
      resolved: all.filter((t) => t.resolved).length,
      outdated: all.filter((t) => t.outdated).length,
      all: all.length,
    };
  }

  // --- Actions ---

  private _handleThreadClick(thread: PRReviewThread) {
    this._expandedThread = this._expandedThread === thread.id ? null : thread.id;
    this._replyingTo = null;
  }

  private _navigateToThread(thread: PRReviewThread) {
    this.dispatchEvent(
      new CustomEvent('comment-navigate', {
        detail: { path: thread.path, line: thread.line },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async _resolveThread(thread: PRReviewThread, resolve: boolean) {
    try {
      await gateway.request(Methods.PR_RESOLVE_THREAD, {
        repo: this.repo,
        threadId: thread.id,
        resolved: resolve,
      });
      this.dispatchEvent(new CustomEvent('thread-resolved', { bubbles: true, composed: true }));
    } catch (err) {
      console.error('[pr-comments] resolve failed:', err);
    }
  }

  private _startReply(threadId: string) {
    this._replyingTo = threadId;
    this._replyText = '';
    requestAnimationFrame(() => {
      const textarea = this.shadowRoot?.querySelector('.reply-input') as HTMLTextAreaElement;
      textarea?.focus();
    });
  }

  private async _submitReply(thread: PRReviewThread) {
    if (!this._replyText.trim() || this._replySubmitting) return;
    this._replySubmitting = true;
    try {
      const lastCommentId = thread.comments[thread.comments.length - 1]?.id;
      await gateway.request(Methods.PR_ADD_COMMENT, {
        pr: this.pr,
        repo: this.repo,
        body: this._replyText,
        path: thread.path,
        line: thread.line ?? 0,
        inReplyTo: lastCommentId,
      });
      this._replyingTo = null;
      this._replyText = '';
      this.dispatchEvent(new CustomEvent('thread-resolved', { bubbles: true, composed: true }));
    } catch (err) {
      console.error('[pr-comments] reply failed:', err);
    } finally {
      this._replySubmitting = false;
    }
  }

  private _formatTime(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
    return `${Math.floor(diff / 86400_000)}d`;
  }

  private async _submitNewComment() {
    if (!this._newCommentText.trim() || this._newCommentSubmitting || !this.pr || !this.repo)
      return;
    this._newCommentSubmitting = true;
    try {
      await gateway.request(Methods.PR_ADD_COMMENT, {
        pr: this.pr,
        repo: this.repo,
        body: this._newCommentText,
        path: this._newCommentPath,
        line: this._newCommentLine,
      });
      this._newCommentPath = '';
      this._newCommentLine = 0;
      this._newCommentText = '';
      this.dispatchEvent(new CustomEvent('thread-resolved', { bubbles: true, composed: true }));
    } catch (err) {
      console.error('[pr-comments] new comment failed:', err);
    } finally {
      this._newCommentSubmitting = false;
    }
  }

  private _cancelNewComment() {
    this._newCommentPath = '';
    this._newCommentLine = 0;
    this._newCommentText = '';
  }

  private _startEdit(commentId: number, body: string) {
    this._editingComment = commentId;
    this._editText = body;
    requestAnimationFrame(() => {
      const textarea = this.shadowRoot?.querySelector('.edit-input') as HTMLTextAreaElement;
      textarea?.focus();
    });
  }

  private async _submitEdit() {
    if (!this._editText.trim() || this._editSubmitting || !this._editingComment) return;
    this._editSubmitting = true;
    try {
      await gateway.request(Methods.PR_EDIT_COMMENT, {
        repo: this.repo,
        commentId: this._editingComment,
        body: this._editText,
      });
      this._editingComment = null;
      this._editText = '';
      this.dispatchEvent(new CustomEvent('thread-resolved', { bubbles: true, composed: true }));
    } catch (err) {
      console.error('[pr-comments] edit failed:', err);
    } finally {
      this._editSubmitting = false;
    }
  }

  private _cancelEdit() {
    this._editingComment = null;
    this._editText = '';
  }

  private async _deleteComment(commentId: number) {
    if (this._deleteConfirm !== commentId) {
      this._deleteConfirm = commentId;
      setTimeout(() => {
        this._deleteConfirm = null;
      }, 3000);
      return;
    }
    this._deleteConfirm = null;
    try {
      await gateway.request(Methods.PR_DELETE_COMMENT, {
        repo: this.repo,
        commentId,
      });
      this.dispatchEvent(new CustomEvent('thread-resolved', { bubbles: true, composed: true }));
    } catch (err) {
      console.error('[pr-comments] delete failed:', err);
    }
  }

  private async _submitReview() {
    if (!this._reviewBody.trim() || this._reviewSubmitting || !this.pr) return;
    this._reviewSubmitting = true;
    try {
      await gateway.request(Methods.PR_SUBMIT_REVIEW, {
        pr: this.pr,
        repo: this.repo,
        body: this._reviewBody,
      });
      this._reviewBody = '';
      this._showReviewForm = false;
      this.dispatchEvent(new CustomEvent('thread-resolved', { bubbles: true, composed: true }));
    } catch (err) {
      console.error('[pr-comments] submit review failed:', err);
    } finally {
      this._reviewSubmitting = false;
    }
  }

  private _handleRefresh() {
    this.dispatchEvent(new CustomEvent('thread-resolved', { bubbles: true, composed: true }));
  }

  // --- Render ---

  private _renderReviewForm() {
    if (!this._showReviewForm) return nothing;
    return html`
      <div class="review-form">
        <div class="review-header">
          <span class="review-label">Review Summary (COMMENT only)</span>
        </div>
        <textarea
          class="review-input"
          placeholder="Leave a general comment on this PR..."
          .value=${this._reviewBody}
          @input=${(e: InputEvent) => {
            this._reviewBody = (e.target as HTMLTextAreaElement).value;
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) this._submitReview();
            if (e.key === 'Escape') {
              this._showReviewForm = false;
            }
          }}
        ></textarea>
        <div class="reply-actions">
          <button
            class="reply-cancel"
            @click=${() => {
              this._showReviewForm = false;
            }}
          >
            Cancel
          </button>
          <button
            class="reply-submit"
            ?disabled=${this._reviewSubmitting || !this._reviewBody.trim()}
            @click=${this._submitReview}
          >
            ${this._reviewSubmitting ? 'Submitting...' : 'Submit Review'}
          </button>
        </div>
      </div>
    `;
  }

  private _renderNewCommentForm() {
    if (!this._newCommentPath || !this._newCommentLine) return nothing;
    return html`
      <div class="new-comment-form">
        <div class="new-comment-header">
          New comment on <strong>${this._newCommentPath}</strong> line ${this._newCommentLine}
        </div>
        <textarea
          class="new-comment-input"
          placeholder="Write a review comment..."
          .value=${this._newCommentText}
          @input=${(e: InputEvent) => {
            this._newCommentText = (e.target as HTMLTextAreaElement).value;
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) this._submitNewComment();
            if (e.key === 'Escape') this._cancelNewComment();
          }}
        ></textarea>
        <div class="reply-actions">
          <button class="reply-cancel" @click=${this._cancelNewComment}>Cancel</button>
          <button
            class="reply-submit"
            ?disabled=${this._newCommentSubmitting || !this._newCommentText.trim()}
            @click=${this._submitNewComment}
          >
            ${this._newCommentSubmitting ? 'Posting...' : 'Comment'}
          </button>
        </div>
      </div>
    `;
  }

  private _renderFilterBar() {
    const c = this._counts();
    return html`
      <div class="filter-bar">
        <div class="filter-group">
          <button
            class="filter-btn ${this._filter === 'unresolved' ? 'active' : ''}"
            @click=${() => {
              this._filter = 'unresolved';
            }}
          >
            Unresolved<span class="filter-count">${c.unresolved}</span>
          </button>
          <button
            class="filter-btn ${this._filter === 'resolved' ? 'active' : ''}"
            @click=${() => {
              this._filter = 'resolved';
            }}
          >
            Resolved<span class="filter-count">${c.resolved}</span>
          </button>
          <button
            class="filter-btn ${this._filter === 'outdated' ? 'active' : ''}"
            @click=${() => {
              this._filter = 'outdated';
            }}
          >
            Outdated<span class="filter-count">${c.outdated}</span>
          </button>
          <button
            class="filter-btn ${this._filter === 'all' ? 'active' : ''}"
            @click=${() => {
              this._filter = 'all';
            }}
          >
            All<span class="filter-count">${c.all}</span>
          </button>
        </div>
        <div class="filter-sep"></div>
        <div class="filter-group">
          <button
            class="filter-btn ${this._authorFilter === 'all' ? 'active' : ''}"
            @click=${() => {
              this._authorFilter = 'all';
            }}
          >
            All
          </button>
          <button
            class="filter-btn ${this._authorFilter === 'human' ? 'active' : ''}"
            @click=${() => {
              this._authorFilter = 'human';
            }}
          >
            Human
          </button>
          <button
            class="filter-btn ${this._authorFilter === 'bugbot' ? 'active' : ''}"
            @click=${() => {
              this._authorFilter = 'bugbot';
            }}
          >
            Bot
          </button>
          <button
            class="filter-btn ${this._authorFilter === 'cursor' ? 'active' : ''}"
            @click=${() => {
              this._authorFilter = 'cursor';
            }}
          >
            Cursor
          </button>
        </div>
        <span class="pr-badge">#${this.pr}</span>
        <button
          class="review-btn"
          title="Submit review summary"
          @click=${() => {
            this._showReviewForm = !this._showReviewForm;
          }}
        >
          Review
        </button>
        <button class="refresh-btn" title="Refresh" @click=${this._handleRefresh}>↻</button>
      </div>
    `;
  }

  private _renderThread(thread: PRReviewThread) {
    const first = thread.comments[0];
    if (!first) return nothing;
    const expanded = this._expandedThread === thread.id;
    const replyCount = thread.comments.length - 1;
    const firstAuthor = first.author;
    const isBotAuthor = isBot(firstAuthor);

    return html`
      <div class="thread ${expanded ? 'expanded' : ''} ${thread.resolved ? 'resolved' : ''}">
        <div class="thread-row" @click=${() => this._handleThreadClick(thread)}>
          <span class="author ${isBotAuthor ? 'bot' : ''}">${firstAuthor}</span>
          ${thread.line ? html`<span class="line-num">L${thread.line}</span>` : ''}
          ${thread.resolved ? html`<span class="status-badge resolved">resolved</span>` : ''}
          ${thread.outdated ? html`<span class="status-badge outdated">outdated</span>` : ''}
          ${replyCount > 0
            ? html`<span class="reply-count"
                >${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}</span
              >`
            : ''}
          <span class="thread-time">${this._formatTime(first.createdAt)}</span>
        </div>
        ${this._editingComment === first.id
          ? html`
              <div class="edit-form">
                <textarea
                  class="edit-input"
                  .value=${this._editText}
                  @input=${(e: InputEvent) => {
                    this._editText = (e.target as HTMLTextAreaElement).value;
                  }}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) this._submitEdit();
                    if (e.key === 'Escape') this._cancelEdit();
                  }}
                ></textarea>
                <div class="reply-actions">
                  <button class="reply-cancel" @click=${this._cancelEdit}>Cancel</button>
                  <button
                    class="reply-submit"
                    ?disabled=${this._editSubmitting || !this._editText.trim()}
                    @click=${this._submitEdit}
                  >
                    ${this._editSubmitting ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            `
          : html`
              <div class="thread-body md-body" @click=${() => this._navigateToThread(thread)}>
                ${unsafeHTML(renderMarkdown(first.body))}
              </div>
            `}
        ${expanded
          ? html`
              <div class="thread-detail">
                ${thread.comments.length > 1
                  ? thread.comments.slice(1).map(
                      (c) => html`
                        <div class="thread-comment">
                          <div class="comment-header">
                            <span class="author ${isBot(c.author) ? 'bot' : ''}">${c.author}</span>
                            <span class="thread-time">${this._formatTime(c.createdAt)}</span>
                          </div>
                          ${this._editingComment === c.id
                            ? html`
                                <div class="edit-form">
                                  <textarea
                                    class="edit-input"
                                    .value=${this._editText}
                                    @input=${(e: InputEvent) => {
                                      this._editText = (e.target as HTMLTextAreaElement).value;
                                    }}
                                    @keydown=${(e: KeyboardEvent) => {
                                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
                                        this._submitEdit();
                                      if (e.key === 'Escape') this._cancelEdit();
                                    }}
                                  ></textarea>
                                  <div class="reply-actions">
                                    <button class="reply-cancel" @click=${this._cancelEdit}>
                                      Cancel
                                    </button>
                                    <button
                                      class="reply-submit"
                                      ?disabled=${this._editSubmitting || !this._editText.trim()}
                                      @click=${this._submitEdit}
                                    >
                                      ${this._editSubmitting ? 'Saving...' : 'Save'}
                                    </button>
                                  </div>
                                </div>
                              `
                            : html`
                                <div class="comment-body md-body">
                                  ${unsafeHTML(renderMarkdown(c.body))}
                                </div>
                                ${this.currentUser && c.author === this.currentUser
                                  ? html`
                                      <div class="comment-actions">
                                        <button
                                          class="comment-action-btn"
                                          @click=${() => this._startEdit(c.id, c.body)}
                                        >
                                          Edit
                                        </button>
                                        <button
                                          class="comment-action-btn danger ${this._deleteConfirm ===
                                          c.id
                                            ? 'confirming'
                                            : ''}"
                                          @click=${() => this._deleteComment(c.id)}
                                        >
                                          ${this._deleteConfirm === c.id ? 'Confirm?' : 'Delete'}
                                        </button>
                                      </div>
                                    `
                                  : ''}
                              `}
                        </div>
                      `,
                    )
                  : ''}
                ${this._replyingTo === thread.id
                  ? html`
                      <div class="reply-form">
                        <textarea
                          class="reply-input"
                          placeholder="Write a reply..."
                          .value=${this._replyText}
                          @input=${(e: InputEvent) => {
                            this._replyText = (e.target as HTMLTextAreaElement).value;
                          }}
                          @keydown=${(e: KeyboardEvent) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
                              this._submitReply(thread);
                          }}
                        ></textarea>
                        <div class="reply-actions">
                          <button
                            class="reply-cancel"
                            @click=${() => {
                              this._replyingTo = null;
                            }}
                          >
                            Cancel
                          </button>
                          <button
                            class="reply-submit"
                            ?disabled=${this._replySubmitting || !this._replyText.trim()}
                            @click=${() => this._submitReply(thread)}
                          >
                            ${this._replySubmitting ? 'Sending...' : 'Reply'}
                          </button>
                        </div>
                      </div>
                    `
                  : html`
                      <div class="thread-actions">
                        <button class="action-btn" @click=${() => this._startReply(thread.id)}>
                          Reply
                        </button>
                        <button class="action-btn" @click=${() => this._navigateToThread(thread)}>
                          Go to file
                        </button>
                        ${this.currentUser && first.author === this.currentUser
                          ? html`
                              <button
                                class="action-btn"
                                @click=${() => this._startEdit(first.id, first.body)}
                              >
                                Edit
                              </button>
                              <button
                                class="action-btn ${this._deleteConfirm === first.id ? '' : ''}"
                                @click=${() => this._deleteComment(first.id)}
                              >
                                ${this._deleteConfirm === first.id ? 'Confirm?' : 'Delete'}
                              </button>
                            `
                          : ''}
                        ${thread.resolved
                          ? html`<button
                              class="action-btn"
                              @click=${() => this._resolveThread(thread, false)}
                            >
                              Unresolve
                            </button>`
                          : html`<button
                              class="action-btn resolve"
                              @click=${() => this._resolveThread(thread, true)}
                            >
                              Resolve
                            </button>`}
                      </div>
                    `}
              </div>
            `
          : ''}
      </div>
    `;
  }

  render() {
    if (this.loading) {
      return html`<div class="loading">Loading review threads...</div>`;
    }

    if (!this.pr) {
      return html`<div class="empty">No PR for this branch</div>`;
    }

    if (this.threads.length === 0) {
      return html`
        ${this._renderFilterBar()}
        <div class="empty">No review comments on this PR</div>
      `;
    }

    const filtered = this._filteredThreads();
    const fileGroups = this._threadsByFile(filtered);

    return html`
      ${this._renderFilterBar()} ${this._renderReviewForm()} ${this._renderNewCommentForm()}
      <div class="content">
        ${filtered.length === 0
          ? html`<div class="empty">No threads match filters</div>`
          : [...fileGroups.entries()].map(
              ([filePath, threads]) => html`
                <div class="file-group">
                  <div class="file-header" @click=${() => this._navigateToThread(threads[0])}>
                    <span>${filePath}</span>
                    <span class="file-badge">${threads.length}</span>
                  </div>
                  ${threads.map((t) => this._renderThread(t))}
                </div>
              `,
            )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'pr-comments-panel': PRCommentsPanel;
  }
}
