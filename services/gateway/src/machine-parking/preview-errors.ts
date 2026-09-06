/**
 * Typed machine-pause execute failures, in their own leaf module.
 *
 * The posture reconciler classifies these without importing the parking
 * service: it is handed `parkExecute` as a dependency precisely so it stays
 * off that import chain, and a class is the smallest thing both sides can
 * share.
 */

/**
 * The preview digest moved between preview and execute.
 *
 * A race with whatever touched the batch in between, not a verdict about any
 * run in it: the operator's own retry re-previews and succeeds. Typed so the
 * posture layer can say that instead of folding it into the generic
 * "execute refused" bucket that every other execute exception lands in.
 */
export class MachinePausePreviewStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MachinePausePreviewStaleError';
  }
}
