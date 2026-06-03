import type { SearchMatch } from '../contracts/index.js';

export interface GitFilesParams {
  slotId: string;
}

export interface GitFilesResult {
  files: string[];
}

export interface SearchQueryParams {
  slotId: string;
  pattern: string;
  caseSensitive?: boolean;
  fileGlob?: string;
  maxResults?: number;
}

export interface SearchQueryResult {
  matches: SearchMatch[];
  truncated: boolean;
}
