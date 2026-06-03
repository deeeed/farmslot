import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';

import type { ArtifactKind } from '../../utils/artifact-kind.js';
import type { MdFetchEntry } from '../../utils/markdown.js';

import type { LightboxItem, LightboxPair } from './media-lightbox-types.js';

export const MD_CACHE_LIMIT = 50;

export abstract class MediaLightboxState extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ type: Number }) selectedIndex = 0;
  @property({ attribute: false }) items: LightboxItem[] = [];
  @property({ attribute: false }) pairs: LightboxPair[] = [];
  @property() mode: 'single' | 'compare' = 'single';
  @property({ type: Number }) pairIndex = 0;
  @property() scopeLabel = '';
  @property({ type: Number }) totalItems = 0;

  @state() protected _zoom = 1;
  @state() protected _panX = 0;
  @state() protected _panY = 0;
  @state() protected _broken = new Set<number>();
  @state() protected _divider = 50; // percent, for image compare
  @state() protected _imageCompareLayout: 'slider' | 'side-by-side' = 'slider';
  @state() protected _kindFilter: ArtifactKind | 'all' = 'all';
  @state() protected _mdCacheVersion = 0; // bumped to trigger re-render when _mdCache updates
  // Shared text-fetch cache: stores rendered Markdown HTML for .md/.markdown
  // entries AND pretty-printed JSON for .json entries (entries are keyed by
  // URL so collisions don't happen). Naming kept as `_mdCache` for history
  // even though it now holds both — rename when a third format lands.
  protected _mdCache = new Map<string, MdFetchEntry<string>>();
  protected _panning = false;
  protected _panStartX = 0;
  protected _panStartY = 0;
  protected _draggingDivider = false;
  protected _videoSyncing = false;
}
