import type { PRPushAttention } from '@farmslot/protocol';

import type { StoredPushDevice } from './store.js';

export type PushResult =
  | { status: 'ticket'; id: string }
  | { status: 'delivered' }
  | { status: 'pending' }
  | {
      status: 'error';
      message: string;
      retryable: boolean;
      invalidDevice?: boolean;
      uncertain?: boolean;
      receiptLookup?: boolean;
    };
export interface PRPushProvider {
  send(
    device: StoredPushDevice,
    attention: PRPushAttention,
    deliveryId: string,
  ): Promise<PushResult>;
  receipt(ticketId: string): Promise<PushResult>;
}

function providerResult(value: unknown, receipt: boolean): PushResult {
  if (!value || typeof value !== 'object')
    return { status: 'error', message: 'Invalid Expo response', retryable: false, uncertain: true };
  const data = value as {
    status?: string;
    id?: string;
    message?: string;
    details?: { error?: string };
  };
  if (data.status === 'ok') {
    if (receipt) return { status: 'delivered' };
    if (typeof data.id === 'string' && data.id) return { status: 'ticket', id: data.id };
  }
  if (data.status === 'error') {
    const code = data.details?.error;
    return {
      status: 'error',
      message: code ?? 'Expo rejected the notification',
      retryable: code === 'MessageRateExceeded',
      invalidDevice: code === 'DeviceNotRegistered',
    };
  }
  return {
    status: 'error',
    message: 'Expo did not confirm notification acceptance',
    retryable: false,
    uncertain: true,
  };
}

/** Production endpoints are fixed: callers cannot redirect device tokens or private attention. */
export class ExpoPushProvider implements PRPushProvider {
  private async request(
    path: string,
    payload: unknown,
  ): Promise<{ body?: unknown; failure?: PushResult }> {
    let response: Response;
    try {
      response = await fetch(`https://exp.host/--/api/v2/push/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.FARMSLOT_EXPO_ACCESS_TOKEN
            ? { Authorization: `Bearer ${process.env.FARMSLOT_EXPO_ACCESS_TOKEN}` }
            : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // The request may have reached Expo. Blind retry can duplicate a delivered notification.
      return {
        failure: {
          status: 'error',
          message: 'Expo connection ended without a delivery result',
          retryable: false,
          uncertain: true,
        },
      };
    }
    if (!response.ok)
      return {
        failure: {
          status: 'error',
          message: `Expo HTTP ${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
        },
      };
    try {
      return { body: await response.json() };
    } catch {
      return {
        failure: {
          status: 'error',
          message: 'Expo returned unreadable delivery status',
          retryable: false,
          uncertain: true,
        },
      };
    }
  }
  async send(
    device: StoredPushDevice,
    attention: PRPushAttention,
    deliveryId: string,
  ): Promise<PushResult> {
    const result = await this.request('send', {
      to: device.token,
      title: attention.title,
      body: attention.body,
      sound: device.sound ? 'default' : null,
      channelId: device.sound ? 'pr-attention' : 'pr-attention-silent',
      data: {
        route: attention.route,
        profileId: device.profileId,
        notificationId: attention.id,
        deliveryId,
      },
      ttl: 3600,
    });
    if (result.failure) return result.failure;
    const body = result.body as { data?: unknown };
    return providerResult(body?.data, false);
  }
  async receipt(ticketId: string): Promise<PushResult> {
    const result = await this.request('getReceipts', { ids: [ticketId] });
    if (result.failure)
      return result.failure.status === 'error'
        ? { ...result.failure, receiptLookup: true }
        : result.failure;
    const data = (result.body as { data?: Record<string, unknown> })?.data;
    return data && Object.hasOwn(data, ticketId)
      ? providerResult(data[ticketId], true)
      : { status: 'pending' };
  }
}
