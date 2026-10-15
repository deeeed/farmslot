/** Client-only sign-in policy shared by Command Center and Companion. */
export const ACCOUNT_SESSION_POLICY = {
  durationMs: 30 * 24 * 60 * 60 * 1000,
  renewWithinMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export const ACCOUNT_SIGN_IN_EXPIRED = 'Your saved sign-in has expired. Enter your token again.';

export function accountSignOutConfirmation(app: string) {
  return {
    title: `Sign out of ${app}?`,
    message: "You'll need your token to sign back in.",
    cancel: 'Cancel',
    confirm: 'Sign out',
  } as const;
}

export async function confirmAccountSignOut(
  confirm: () => Promise<boolean>,
  signOut: () => Promise<void>,
): Promise<void> {
  if (await confirm()) await signOut();
}

export function parseAccountSessionExpiry(value: string | null): number | null {
  const expiry = Number(value);
  return Number.isFinite(expiry) && expiry > 0 ? expiry : null;
}

export function accountSessionCaption(expiresAt: number | null, now = Date.now()): string {
  if (expiresAt === null) return '';
  return expiresAt <= now
    ? ACCOUNT_SIGN_IN_EXPIRED
    : `Signed in until ${new Date(expiresAt).toLocaleDateString()}`;
}

/** Storage stays platform-owned. Existing logins get an expiry on their next successful use. */
export class RememberedAccountSession {
  private active = true;
  private pending: Promise<void> | null = null;

  constructor(
    public expiresAt: number | null,
    private readonly persist: (expiresAt: number | null) => void | Promise<void>,
    private readonly now = Date.now,
  ) {}

  assertCurrent(): void {
    if (!this.active || (this.expiresAt !== null && this.expiresAt <= this.now()))
      throw new Error(ACCOUNT_SIGN_IN_EXPIRED);
  }

  async recordSuccessfulUse(): Promise<void> {
    this.assertCurrent();
    if (this.pending) return this.pending;
    const now = this.now();
    if (this.expiresAt !== null && this.expiresAt - now > ACCOUNT_SESSION_POLICY.renewWithinMs)
      return;
    const next = now + ACCOUNT_SESSION_POLICY.durationMs;
    this.pending = (async () => {
      await this.persist(next);
      if (this.active) this.expiresAt = next;
    })();
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
  }

  async clear(): Promise<void> {
    this.active = false;
    try {
      await this.pending;
      await this.persist(null);
      this.expiresAt = null;
    } catch (error) {
      this.active = true;
      throw error;
    }
  }
}
