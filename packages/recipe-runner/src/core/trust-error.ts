import type { RecipeTrustFailure } from '@farmslot/protocol';

export class RecipeTrustError extends Error {
  readonly code: RecipeTrustFailure['code'];
  readonly userAction: string;
  readonly failure: RecipeTrustFailure;

  constructor(failure: RecipeTrustFailure) {
    super(failure.message);
    this.name = 'RecipeTrustError';
    this.code = failure.code;
    this.userAction = failure.userAction;
    this.failure = failure;
  }
}

export function invalidRecipeSource(message: string, userAction: string): RecipeTrustError {
  return new RecipeTrustError({
    code: 'RECIPE_SOURCE_INVALID',
    message,
    userAction,
    reason: 'invalid-source',
  });
}
