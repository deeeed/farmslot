import {
  createVisualReviewFeedbackDocument,
  isTerminalRunStatus,
  validateVisualReviewFeedbackDocument,
  validateVisualReviewSourceDocument,
  type VisualReviewFeedbackDocument,
  type VisualReviewFeedbackDraft,
  type VisualReviewSourceDocument,
} from '@farmslot/protocol';

import type { ArtifactHttpHeaders } from '../../lib/artifact-url';
import {
  addVisualReviewAnnotation,
  emptyVisualReviewDraft,
  findVisualReviewSourceArtifacts,
  moveVisualReviewAnnotation,
  removeVisualReviewAnnotation,
  setVisualReviewSurfaceNote,
  updateVisualReviewAnnotation,
  VISUAL_REVIEW_MESSAGE_MAX_BYTES,
  type VisualReviewAnnotationInput,
  visualReviewFeedbackMessage,
  visualReviewMessageBytes,
  visualReviewImageArtifactPath,
} from '../../lib/visual-review';
import type { VisualReviewArtifactRef, VisualReviewGateway } from '../../lib/visual-review-gateway';

/** Delivery only reports whether the worker input accepted the message; it is never approval. */
export type VisualReviewDelivery =
  | { status: 'idle' }
  | { status: 'pending'; targetRunId: string }
  | { status: 'accepted'; targetRunId: string; settledAt: string }
  | { status: 'failed'; targetRunId: string; message: string };

export type VisualReviewAnnotationMode = 'point' | 'area';

export interface VisualReviewCaptureView {
  surfaceId: string;
  captureId: string;
  platform: string;
  artifactPath: string;
  image: { uri: string; headers?: ArtifactHttpHeaders };
  width?: number;
  height?: number;
}

export interface VisualReviewReadyState {
  status: 'ready';
  source: VisualReviewSourceDocument;
  sourceArtifact: VisualReviewArtifactRef;
  /** The connection the source was loaded from; sending goes back to that run store only. */
  gatewayConnectionId: string;
  /** The run the feedback is about: the source's own run id, else the run hosting it. */
  targetRunId: string;
  surfaceId: string;
  captureId: string;
  captures: Record<string, VisualReviewCaptureView>;
  draft: VisualReviewFeedbackDraft;
  selectedAnnotationId: string | null;
  mode: VisualReviewAnnotationMode;
  delivery: VisualReviewDelivery;
}

export type VisualReviewScreenState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | VisualReviewReadyState;

export interface VisualReviewRouteParams {
  runId: string;
  /** Artifact path of the source document; the first source in the run is used when absent. */
  sourcePath?: string;
  recipeRunId?: string;
}

export function visualReviewCaptureKey(surfaceId: string, captureId: string): string {
  return `${surfaceId}\u0000${captureId}`;
}

export class VisualReviewController {
  private state: VisualReviewScreenState = { status: 'loading' };
  private readonly listeners = new Set<() => void>();
  private gateway: VisualReviewGateway | null = null;
  private loadGeneration = 0;

  constructor(
    private readonly route: VisualReviewRouteParams,
    private readonly now: () => Date = () => new Date(),
  ) {}

  getState = (): VisualReviewScreenState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Reconnecting with the same profile, URL, and credentials keeps the draft and rebuilds image
   * sources for the new client. Another profile or URL may be another run store, and replaced
   * credentials may be another principal, so the review reloads.
   * Any change drops an in-flight load that belongs to the previous connection.
   */
  setGateway(gateway: VisualReviewGateway | null): void {
    this.gateway = gateway;
    this.loadGeneration++;
    if (!gateway) return;
    if (this.state.status === 'ready' && this.state.gatewayConnectionId === gateway.connectionId) {
      const { source, sourceArtifact } = this.state;
      this.updateReady((state) => ({
        ...state,
        captures: this.captureViews(gateway, source, sourceArtifact),
      }));
      return;
    }
    this.setState({ status: 'loading' });
    void this.load();
  }

  /** Loads once; after that the draft is the source of truth until the screen closes. */
  async load(): Promise<void> {
    const gateway = this.gateway;
    if (!gateway || this.state.status === 'ready') return;
    const generation = ++this.loadGeneration;
    this.setState({ status: 'loading' });
    try {
      const next = await this.loadSource(gateway);
      if (generation === this.loadGeneration) this.setState(next);
    } catch (error) {
      // A missing or invalid source is the screen's error state, with retry.
      if (generation === this.loadGeneration) {
        this.setState({ status: 'error', message: (error as Error).message });
      }
    }
  }

  selectSurface(surfaceId: string): void {
    this.updateReady((state) => {
      const surface = state.source.surfaces.find((candidate) => candidate.id === surfaceId);
      if (!surface) return state;
      const sameCapture = surface.captures.find((capture) => capture.id === state.captureId);
      return {
        ...state,
        surfaceId,
        captureId: (sameCapture ?? surface.captures[0])?.id ?? '',
        selectedAnnotationId: null,
      };
    });
  }

  selectCapture(captureId: string): void {
    this.updateReady((state) => ({ ...state, captureId, selectedAnnotationId: null }));
  }

  setMode(mode: VisualReviewAnnotationMode): void {
    this.updateReady((state) => ({ ...state, mode }));
  }

  setSurfaceNote(body: string): void {
    this.editDraft((state) => ({
      ...state,
      draft: setVisualReviewSurfaceNote(state.draft, state.surfaceId, body),
    }));
  }

  addAnnotation(input: VisualReviewAnnotationInput): void {
    this.editDraft((state) => {
      const { draft, annotation } = addVisualReviewAnnotation(
        state.draft,
        { surfaceId: state.surfaceId, captureId: state.captureId },
        input,
      );
      return annotation ? { ...state, draft, selectedAnnotationId: annotation.id } : state;
    });
  }

  selectAnnotation(annotationId: string | null): void {
    this.updateReady((state) => ({ ...state, selectedAnnotationId: annotationId }));
  }

  moveAnnotation(annotationId: string, delta: { x: number; y: number }): void {
    this.editDraft((state) => ({
      ...state,
      draft: moveVisualReviewAnnotation(state.draft, annotationId, delta),
    }));
  }

  updateAnnotation(annotationId: string, patch: { body?: string; color?: string }): void {
    this.editDraft((state) => ({
      ...state,
      draft: updateVisualReviewAnnotation(state.draft, annotationId, patch),
    }));
  }

  removeAnnotation(annotationId: string): void {
    this.editDraft((state) => ({
      ...state,
      draft: removeVisualReviewAnnotation(state.draft, annotationId),
      selectedAnnotationId:
        state.selectedAnnotationId === annotationId ? null : state.selectedAnnotationId,
    }));
  }

  /** The portable document, identical in shape to the HTML board's download. */
  exportDocument(): VisualReviewFeedbackDocument {
    const state = this.requireReady();
    const document = createVisualReviewFeedbackDocument(state.source, state.draft);
    const validation = validateVisualReviewFeedbackDocument(document);
    if (!validation.ok) {
      throw new Error(`Feedback is not a valid document: ${validation.errors.join('; ')}`);
    }
    return document;
  }

  /**
   * Sends the feedback document to the originating run's worker through `terminal.send`.
   * The draft is kept whatever the outcome, and nothing here resolves gates or publishes.
   */
  async submit(): Promise<void> {
    const state = this.requireReady();
    const gateway = this.gateway;
    if (state.delivery.status === 'pending') return;
    const targetRunId = state.targetRunId;
    const fail = (message: string) =>
      this.updateReady((current) => ({
        ...current,
        delivery: { status: 'failed', targetRunId, message },
      }));
    let document: VisualReviewFeedbackDocument;
    try {
      document = this.exportDocument();
    } catch (error) {
      fail((error as Error).message);
      return;
    }
    if (document.surfaceNotes.length === 0 && document.annotations.length === 0) {
      fail('Add a note or a described annotation before sending.');
      return;
    }
    const text = visualReviewFeedbackMessage(document);
    const bytes = visualReviewMessageBytes(text);
    if (bytes > VISUAL_REVIEW_MESSAGE_MAX_BYTES) {
      fail(
        `Feedback is ${bytes} bytes; worker messages are limited to ${VISUAL_REVIEW_MESSAGE_MAX_BYTES}. Export the JSON instead.`,
      );
      return;
    }
    if (!gateway) {
      fail('Gateway is not connected.');
      return;
    }
    const sentDraft = state.draft;
    this.updateReady((current) => ({
      ...current,
      delivery: { status: 'pending', targetRunId },
    }));
    try {
      const run = await gateway.getRun(targetRunId);
      if (!run.slotId) throw new Error(`Run ${targetRunId} is not attached to a slot.`);
      // A finished run's slot may already host another worker; never type into it.
      if (isTerminalRunStatus(run.status)) {
        throw new Error(`Run ${targetRunId} is ${run.status}; its worker no longer takes input.`);
      }
      // The client is shared across profiles; never send this review through another connection.
      if (this.gateway?.connectionId !== gateway.connectionId) {
        throw new Error('The gateway connection changed while sending. Reopen the review to send.');
      }
      await gateway.sendWorkerMessage({
        slotId: run.slotId,
        runId: targetRunId,
        text,
        enter: true,
      });
    } catch (error) {
      // Delivery failures are part of the review state: the operator retries from the same draft.
      fail((error as Error).message);
      return;
    }
    // Edits made while the send was pending were not in the message the worker received.
    this.updateReady((current) => ({
      ...current,
      delivery:
        current.draft === sentDraft
          ? { status: 'accepted', targetRunId, settledAt: this.now().toISOString() }
          : { status: 'idle' },
    }));
  }

  private async loadSource(gateway: VisualReviewGateway): Promise<VisualReviewReadyState> {
    const { runId, sourcePath, recipeRunId } = this.route;
    const run = await gateway.getRun(runId);
    const candidates = findVisualReviewSourceArtifacts(await gateway.listRunArtifacts(run));
    const artifact = sourcePath
      ? candidates.find(
          (candidate) =>
            candidate.path === sourcePath &&
            (!recipeRunId || candidate.recipeRunId === recipeRunId),
        )
      : candidates[0];
    if (!artifact) {
      throw new Error(
        sourcePath
          ? `Run ${runId} has no visual review source at ${sourcePath}.`
          : `Run ${runId} has no visual review source artifact.`,
      );
    }
    const sourceArtifact: VisualReviewArtifactRef = {
      path: artifact.path,
      ...(artifact.recipeRunId ? { recipeRunId: artifact.recipeRunId } : {}),
    };
    const text = await gateway.readArtifactText(runId, sourceArtifact);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error(`${artifact.path} is not valid JSON: ${error.message}`);
    }
    const validation = validateVisualReviewSourceDocument(parsed);
    if (!validation.ok || !validation.document) {
      throw new Error(
        `${artifact.path} is not a visual review source: ${validation.errors.join('; ')}`,
      );
    }
    const source = validation.document;
    const firstSurface = source.surfaces.find((surface) => !surface.parentId) ?? source.surfaces[0];
    return {
      status: 'ready',
      source,
      sourceArtifact,
      gatewayConnectionId: gateway.connectionId,
      targetRunId: source.runId ?? runId,
      surfaceId: firstSurface.id,
      captureId: firstSurface.captures[0]?.id ?? '',
      captures: this.captureViews(gateway, source, sourceArtifact),
      draft: emptyVisualReviewDraft(),
      selectedAnnotationId: null,
      mode: 'point',
      delivery: { status: 'idle' },
    };
  }

  private captureViews(
    gateway: VisualReviewGateway,
    source: VisualReviewSourceDocument,
    sourceArtifact: VisualReviewArtifactRef,
  ): Record<string, VisualReviewCaptureView> {
    const captures: Record<string, VisualReviewCaptureView> = {};
    for (const surface of source.surfaces) {
      for (const capture of surface.captures) {
        const imageArtifact = {
          ...sourceArtifact,
          path: visualReviewImageArtifactPath(sourceArtifact.path, capture.image.path),
        };
        captures[visualReviewCaptureKey(surface.id, capture.id)] = {
          surfaceId: surface.id,
          captureId: capture.id,
          platform: capture.platform,
          artifactPath: imageArtifact.path,
          image: gateway.imageSource(this.route.runId, imageArtifact),
          width: capture.image.width,
          height: capture.image.height,
        };
      }
    }
    return captures;
  }

  /** A draft edit after an accepted send means the worker has not seen the current draft. */
  private editDraft(update: (state: VisualReviewReadyState) => VisualReviewReadyState): void {
    this.updateReady((state) => {
      const next = update(state);
      return next !== state && next.delivery.status === 'accepted'
        ? { ...next, delivery: { status: 'idle' } }
        : next;
    });
  }

  private requireReady(): VisualReviewReadyState {
    if (this.state.status !== 'ready') throw new Error('Visual review source is not loaded.');
    return this.state;
  }

  private updateReady(update: (state: VisualReviewReadyState) => VisualReviewReadyState): void {
    if (this.state.status !== 'ready') return;
    const next = update(this.state);
    if (next !== this.state) this.setState(next);
  }

  private setState(state: VisualReviewScreenState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}
