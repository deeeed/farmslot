export class NativeWorkerOperationUncertainError extends Error {
  override name = 'NativeWorkerOperationUncertainError';
  constructor(
    readonly operation: 'launch' | 'delivery' | 'handoff' | 'observation',
    message: string,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

/** Uses the existing claim-refusal contract so failure cleanup cannot release a foreign slot. */
export class NativeSlotOwnershipError extends Error {
  readonly code = 'SLOT_CLAIM_REFUSED';
}
