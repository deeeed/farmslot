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
