// One pairing at a time across every mounted pairing controller (Settings, the connection screen and
// a link route that remounts mid-pairing), and each payload once: its code is single-use. The camera
// reports a QR on every frame and a link can arrive twice, so React state lands too late for this.
let pairingRunning = false;
let lastPairingData: string | null = null;

/** `handled`: this payload was claimed already. `busy`: another pairing runs. */
export type PairingClaim = 'claimed' | 'handled' | 'busy';

export function claimPairing(data: string): PairingClaim {
  if (data === lastPairingData) return 'handled';
  if (pairingRunning) return 'busy';
  pairingRunning = true;
  lastPairingData = data;
  return 'claimed';
}

export function releasePairing(): void {
  pairingRunning = false;
}

/** A newly opened scanner may read the last QR again; the gateway then reports a spent code. */
export function forgetLastPairing(): void {
  lastPairingData = null;
}
