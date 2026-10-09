/**
 * A ReactiveControllerHost for node tests: records the controllers it is given
 * and counts update requests, so a controller runs without a LitElement or DOM.
 */

import type { ReactiveController, ReactiveControllerHost } from 'lit';

export class FakeControllerHost implements ReactiveControllerHost {
  readonly controllers: ReactiveController[] = [];
  updates = 0;
  readonly updateComplete = Promise.resolve(true);

  addController(controller: ReactiveController): void {
    this.controllers.push(controller);
  }

  removeController(controller: ReactiveController): void {
    this.controllers.splice(this.controllers.indexOf(controller), 1);
  }

  requestUpdate(): void {
    this.updates += 1;
  }

  connect(): void {
    for (const controller of this.controllers) controller.hostConnected?.();
  }

  disconnect(): void {
    for (const controller of this.controllers) controller.hostDisconnected?.();
  }
}
