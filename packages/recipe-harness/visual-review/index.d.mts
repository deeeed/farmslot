import type { VisualReviewSourceDocument } from '@farmslot/protocol';

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

export function generateReviewBoard(options: GenerateReviewBoardOptions): void;
export function buildRecipeReviewBoard(options: {
  artifactsDir: string;
  outputDir: string;
  platform: string;
  recipePath: string;
  sourceId: string;
  project?: string;
  title?: string;
  storageKey?: string;
}): VisualReviewSourceDocument;
export function serveReviewBoard(options: {
  directory: string;
  host?: string;
  port?: number;
}): Promise<VisualReviewServer>;
