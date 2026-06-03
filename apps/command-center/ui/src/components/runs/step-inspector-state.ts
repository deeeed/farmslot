import { LitElement } from 'lit';
import { property, state } from 'lit/decorators.js';

import type { Run, RunStep, TaskProgressStructured } from '@farmslot/protocol';

import type { LightboxItem } from '../shared/media-lightbox-types.js';

export abstract class StepInspectorState extends LitElement {
  @property({ attribute: false }) step: RunStep | null = null;
  @property({ attribute: false }) run?: Run;
  @property({ attribute: false }) taskProgress?: TaskProgressStructured | null;
  @property({ type: Boolean }) allowReplay = false;

  @state() protected _tickNow = Date.now();
  protected _tickTimer: number | null = null;

  @state() protected _poking = false;
  @state() protected _pokeStatus: { ok: boolean; msg: string } | null = null;
  @state() protected _lightboxOpen = false;
  @state() protected _lightboxItems: LightboxItem[] = [];
  @state() protected _lightboxIndex = 0;
  protected _pokeStatusTimer: number | null = null;
  @state() protected _lastPokePollCount: number | null = null;

  protected _prevLastOutput = '';
  protected _prevStepName = '';
}
