export interface PRPushRegisterParams {
  installationId: string;
  /** Required when updating an existing registration. Fences stale token refreshes. */
  expectedRevision?: number;
  token: string;
  platform: 'ios' | 'android';
  /** Device-local gateway profile used when opening the notification. */
  profileId: string;
  enabled: boolean;
  sound: boolean;
}

export interface PRPushDevice {
  id: string;
  installationId: string;
  platform: 'ios' | 'android';
  profileId: string;
  enabled: boolean;
  sound: boolean;
  revision: number;
  registeredAt: string;
  updatedAt: string;
  error?: string;
}

export interface PRPushDelivery {
  id: string;
  deviceId: string;
  deviceRevision: number;
  deviceTokenRevision?: number;
  sourceId: string;
  state:
    | 'queued'
    | 'sending'
    | 'ticket'
    | 'delivered'
    | 'retry'
    | 'unknown'
    | 'failed'
    | 'cancelled';
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
  ticketId?: string;
  error?: string;
}

export interface PRPushListResult {
  attention: PRPushAttention[];
  devices: PRPushDevice[];
  deliveries: PRPushDelivery[];
  schedulerError?: string;
}

/** Recipient-scoped attention. It conveys no monitor policy or execution authority. */
export interface PRPushAttention {
  id: string;
  kind: 'monitor' | 'rule';
  teamId?: string;
  title: string;
  body: string;
  route: string;
  createdAt: string;
  current: boolean;
  acknowledgedAt?: string;
}
