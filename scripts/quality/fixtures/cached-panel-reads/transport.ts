export interface FixtureClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  requestResource<T = unknown>(method: string, params?: unknown): Promise<{ data: T }>;
}

export declare const gateway: FixtureClient;

export declare const cache: {
  observe(query: unknown, listener: (state: unknown) => void): () => void;
};
