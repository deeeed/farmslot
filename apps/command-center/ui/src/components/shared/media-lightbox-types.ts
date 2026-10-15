import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';

/** A child proof traversal replaces the gallery and its selected file together. */
export interface LightboxSelection {
  items: LightboxItem[];
  index: number;
}

export interface LightboxItem {
  fullscreen?: boolean;
  url: string;
  path: string;
  purpose: string;
  caption?: string;
  /** Exact report bytes verified against the retained output snapshot before opening. */
  verifiedText?: string;
  /** Capture provenance, e.g. "baseline @ main · abc123" or "fix @ feat/x · def456". */
  provenance?: string;
  sha256?: string;
  timelinePath?: string;
  timelineUnavailableReason?: string;
  resolveArtifactUrl?: (path: string) => string;
  viewUrl?: string;
  initialTraceIndex?: number;
  initialTracePhase?: 'start' | 'end';
  /** The same model selected by the claim/step panel that opened the player. */
  evidenceModel?: EvidenceReviewModel;
}

export interface LightboxPair {
  before: LightboxItem;
  after: LightboxItem;
  stem: string;
  kind: 'image' | 'video';
}
