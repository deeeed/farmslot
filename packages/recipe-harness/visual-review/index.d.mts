import type { VisualReviewFeedbackDraft, VisualReviewSourceDocument } from '@farmslot/protocol';

export interface GenerateReviewBoardOptions {
  outputDir: string;
  source: VisualReviewSourceDocument;
  storageKey: string;
  defaultPlatform?: string;
}

export interface VisualReviewServer {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

/** Reopens a portable feedback document as the board's editable draft for `source`. */
export function feedbackDraftFromDocument(
  source: VisualReviewSourceDocument,
  document: unknown,
): VisualReviewFeedbackDraft;
export function generateReviewBoard(options: GenerateReviewBoardOptions): void;
export function buildRecipeReviewBoard(options: {
  artifactsDir: string;
  outputDir: string;
  platform: string;
  recipePath: string;
  sourceId: string;
  project?: string;
  runId?: string;
  surfaceLocations?: Record<string, string>;
  title?: string;
  storageKey?: string;
}): VisualReviewSourceDocument;
export function serveReviewBoard(options: {
  directory: string;
  host?: string;
  port?: number;
}): Promise<VisualReviewServer>;
