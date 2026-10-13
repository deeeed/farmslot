import type { EvidenceManifestStandalone } from '../contracts/runs.js';

export interface EvidenceManifestPair {
  label: string;
  covers?: string[];
  before?: string;
  after?: string;
  note?: string;
}

export interface EvidenceManifestVideo {
  before?: string;
  after?: string;
  preferred?: boolean;
  note?: string;
}

export interface EvidenceManifestOmit {
  file: string;
  reason?: string;
}

/** Existing publication selection format; paths are relative to its artifact root. */
export interface EvidenceManifest {
  version?: number;
  preferred_mode?: 'screenshots' | 'video';
  summary?: string;
  before_after_pairs?: EvidenceManifestPair[];
  standalone?: EvidenceManifestStandalone[];
  omit?: Array<string | EvidenceManifestOmit>;
  videos?: EvidenceManifestVideo;
  before_state_capture?: Record<string, unknown>;
}
