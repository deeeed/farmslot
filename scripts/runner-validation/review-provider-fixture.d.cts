export interface ReviewProviderFixture {
  origin: string;
  close(): Promise<void>;
}

export function startReviewProviderFixture(): Promise<ReviewProviderFixture>;

export function handleReviewProviderRequest(request: {
  method: string;
  pathname: string;
  payload: Record<string, unknown>;
}): { status?: number; body?: unknown; destroy?: boolean };

/** GitHub's HTTP 200 validation error for a mutation that selects `rateLimit`; undefined otherwise. */
export function rejectMutationRateLimit(query: string): { errors: unknown[] } | undefined;
