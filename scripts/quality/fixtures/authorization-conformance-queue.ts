function initDispatchQueue(
  _broadcast: () => void,
  _createAndStartRun: (item: unknown, claim: unknown) => Promise<void>,
): void {
  // Fixture-only registration point used by the conformance guard.
}

function allowlistedRoute(method: string): unknown[] {
  switch (method) {
    case 'nodes.list':
      return [];
    default:
      return [];
  }
}

export function authorizationQueueFixture(): void {
  initDispatchQueue(
    () => undefined,
    async () => {
      allowlistedRoute('nodes.list');
    },
  );
}
