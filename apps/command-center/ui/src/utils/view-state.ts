import { LitElement, nothing, type ReactiveController, type ReactiveControllerHost } from 'lit';
import { AsyncDirective } from 'lit/async-directive.js';
import { Directive, directive, type Part, PartType } from 'lit/directive.js';

import { createViewStateContext, type ViewStateContext, viewToggleField } from '@farmslot/protocol';

import { buildHash, hashParams, hashRoute } from './url-state.js';

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** One browser adapter for every context-configured display field. */
export const browserViewState = createViewStateContext({
  read: () => (typeof location === 'undefined' ? new URLSearchParams() : hashParams()),
  write(params, mode) {
    if (typeof location === 'undefined' || typeof history === 'undefined') return;
    // A configured field write is authoritative, including restoring the collapsed default.
    const hash = buildHash(hashRoute(), params);
    if (hash === location.hash) return;
    history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', hash);
    // History writes do not dispatch hashchange. Notify the same subscribers synchronously.
    if (typeof window !== 'undefined') window.dispatchEvent(new HashChangeEvent('hashchange'));
    else notify();
  },
  subscribe(listener) {
    const browser = typeof window !== 'undefined';
    if (browser && !listeners.size) {
      window.addEventListener('popstate', notify);
      window.addEventListener('hashchange', notify);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (browser && !listeners.size) {
        window.removeEventListener('popstate', notify);
        window.removeEventListener('hashchange', notify);
      }
    };
  },
});

export class ViewStateController implements ReactiveController {
  private unsubscribe?: () => void;
  constructor(
    private host: ReactiveControllerHost,
    readonly state: ViewStateContext = browserViewState,
  ) {
    host.addController(this);
  }
  hostConnected(): void {
    this.unsubscribe = this.state.subscribe(() => this.host.requestUpdate());
  }
  hostDisconnected(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

const controllers = new WeakMap<LitElement, ViewStateController>();

export function useViewState(host: LitElement): ViewStateContext {
  let controller = controllers.get(host);
  if (!controller) {
    controller = new ViewStateController(host);
    controllers.set(host, controller);
  }
  return controller.state;
}

/** Shared renderers bind their host once, so Back/Forward also updates nested panels. */
class ViewStateUpdates extends Directive {
  render() {
    return nothing;
  }
  update(part: Part) {
    const host = part.options?.host;
    if (host instanceof LitElement) useViewState(host);
    return nothing;
  }
}
export const viewStateUpdates = directive(ViewStateUpdates);

/** A configured binding adapts component properties without another URL codec or listener. */
export interface ViewStateBinding {
  restore(values: import('@farmslot/protocol').ViewStateValues): boolean;
  persist(values: import('@farmslot/protocol').ViewStateValues): void;
}
export function viewBinding<T>(
  field:
    | import('@farmslot/protocol').ViewStateField<T>
    | (() => import('@farmslot/protocol').ViewStateField<T>),
  read: () => T,
  write: (value: T) => void,
): ViewStateBinding {
  const currentField = () => (typeof field === 'function' ? field() : field);
  let previous = '';
  return {
    restore(values) {
      const value = values.get(currentField());
      previous = JSON.stringify(value);
      const changed = JSON.stringify(read()) !== previous;
      if (changed) write(value);
      return changed;
    },
    persist(values) {
      const value = read();
      const encoded = JSON.stringify(value);
      if (encoded !== previous) {
        previous = encoded;
        values.set(currentField(), value);
      }
    },
  };
}

/** Restores before first paint, then atomically records changes made by existing controls. */
export class ViewStateBindings implements ReactiveController {
  private unsubscribe?: () => void;
  constructor(
    private host: ReactiveControllerHost,
    private bindings: readonly ViewStateBinding[],
    private onRestore?: () => void,
  ) {
    host.addController(this);
  }
  restore = () => {
    let changed = false;
    for (const binding of this.bindings) changed = binding.restore(browserViewState) || changed;
    if (changed) {
      this.host.requestUpdate();
      this.onRestore?.();
    }
  };
  hostConnected(): void {
    this.restore();
    this.unsubscribe = browserViewState.subscribe(this.restore);
  }
  hostUpdate(): void {
    browserViewState.update((values) => {
      for (const binding of this.bindings) binding.persist(values);
    });
  }
  hostDisconnected(): void {
    this.unsubscribe?.();
  }
}

/** Native details elements use the same configured fields as shared panel renderers. */
class ViewDetails extends AsyncDirective {
  private element?: HTMLDetailsElement;
  private field = viewToggleField('panels', '', false);
  private unsubscribe?: () => void;
  render(_id: string | import('@farmslot/protocol').ViewStateField<boolean>, _defaultOpen = false) {
    return nothing;
  }
  update(
    part: Part,
    [id, defaultOpen = false]: [
      string | import('@farmslot/protocol').ViewStateField<boolean>,
      boolean?,
    ],
  ) {
    if (part.type !== PartType.ELEMENT || !(part.element instanceof HTMLDetailsElement))
      return nothing;
    this.element = part.element;
    this.field = typeof id === 'string' ? viewToggleField('panels', id, defaultOpen) : id;
    this.attach();
    this.restore();
    return nothing;
  }
  private restore = () => {
    if (this.element) this.element.open = browserViewState.get(this.field);
  };
  private toggle = () => {
    if (this.element && this.element.open !== browserViewState.get(this.field))
      browserViewState.set(this.field, this.element.open);
  };
  private attach() {
    if (this.unsubscribe || !this.isConnected) return;
    this.element?.addEventListener('toggle', this.toggle);
    this.unsubscribe = browserViewState.subscribe(this.restore);
  }
  protected disconnected() {
    this.element?.removeEventListener('toggle', this.toggle);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
  protected reconnected() {
    this.attach();
    this.restore();
  }
}
export const viewDetails = directive(ViewDetails);
