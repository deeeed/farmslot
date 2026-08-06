import { verificationCacheKey } from './credential-secret.js';

export class VerificationCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly capacity = 256) {}

  get(presented: string): string | undefined {
    const key = verificationCacheKey(presented);
    const credentialId = this.entries.get(key);
    if (!credentialId) return undefined;
    this.entries.delete(key);
    this.entries.set(key, credentialId);
    return credentialId;
  }

  set(presented: string, credentialId: string): void {
    const key = verificationCacheKey(presented);
    this.entries.delete(key);
    this.entries.set(key, credentialId);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
