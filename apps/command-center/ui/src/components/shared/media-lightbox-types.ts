export interface LightboxItem {
  url: string;
  path: string;
  purpose: string;
  caption?: string;
  /** Capture provenance, e.g. "baseline @ main · abc123" or "fix @ feat/x · def456". */
  provenance?: string;
}

export interface LightboxPair {
  before: LightboxItem;
  after: LightboxItem;
  stem: string;
  kind: 'image' | 'video';
}
