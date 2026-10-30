/** Display text only. Retention never supplies data or readiness to a command. */
export class RetainedNotice {
  private scope?: string;
  private value?: string;

  read(
    scope: string | undefined,
    value: string | undefined,
    retainMissing: boolean,
  ): string | undefined {
    if (scope !== this.scope) {
      this.scope = scope;
      this.value = undefined;
    }
    if (!scope) return undefined;
    if (value !== undefined || !retainMissing) this.value = value;
    return this.value;
  }
}
