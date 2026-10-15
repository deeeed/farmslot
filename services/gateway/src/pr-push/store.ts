import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import Ajv from 'ajv';

import type { PRPushDelivery, PRPushDevice, PRPushRegisterParams } from '@farmslot/protocol';

import { writeAtomicJSON } from '../core/atomic-json.js';

export interface StoredPushDevice extends PRPushDevice {
  ownerId: string;
  token: string;
  tokenRevision?: number;
}
interface PushData {
  version: 1;
  devices: StoredPushDevice[];
  deliveries: PRPushDelivery[];
  acknowledgements?: Record<string, string>;
}
const text = { type: 'string', minLength: 1 };
const timestamp = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
};
const integer = { type: 'integer', minimum: 0 };
const validate = new Ajv().compile<PushData>({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'devices', 'deliveries'],
  properties: {
    version: { const: 1 },
    acknowledgements: { type: 'object', additionalProperties: timestamp },
    devices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'ownerId',
          'token',
          'installationId',
          'platform',
          'profileId',
          'enabled',
          'sound',
          'revision',
          'registeredAt',
          'updatedAt',
        ],
        properties: {
          id: text,
          ownerId: text,
          tokenRevision: integer,
          token: text,
          installationId: text,
          platform: { enum: ['ios', 'android'] },
          profileId: text,
          enabled: { type: 'boolean' },
          sound: { type: 'boolean' },
          revision: integer,
          registeredAt: timestamp,
          updatedAt: timestamp,
          error: text,
        },
      },
    },
    deliveries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'deviceId',
          'deviceRevision',
          'sourceId',
          'state',
          'attempts',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          id: text,
          deviceId: text,
          deviceRevision: integer,
          deviceTokenRevision: integer,
          sourceId: text,
          state: {
            enum: [
              'queued',
              'sending',
              'ticket',
              'delivered',
              'retry',
              'unknown',
              'failed',
              'cancelled',
            ],
          },
          attempts: integer,
          createdAt: timestamp,
          updatedAt: timestamp,
          nextAttemptAt: timestamp,
          ticketId: text,
          error: text,
        },
      },
    },
  },
});

export function assertPushRegistration(value: unknown): asserts value is PRPushRegisterParams {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Device registration is required');
  const p = value as Record<string, unknown>;
  if (
    Object.keys(p).some(
      (key) =>
        ![
          'installationId',
          'token',
          'platform',
          'profileId',
          'enabled',
          'sound',
          'expectedRevision',
        ].includes(key),
    )
  )
    throw new Error('Unknown device registration field');
  if (
    p.expectedRevision !== undefined &&
    (typeof p.expectedRevision !== 'number' ||
      !Number.isSafeInteger(p.expectedRevision) ||
      p.expectedRevision < 1)
  )
    throw new Error('Invalid registration revision');
  for (const key of ['installationId', 'profileId']) {
    if (typeof p[key] !== 'string' || !/^[a-zA-Z0-9._:-]{1,160}$/.test(p[key]))
      throw new Error(`Invalid ${key}`);
  }
  if (
    typeof p.token !== 'string' ||
    !/^(ExponentPushToken|ExpoPushToken)\[[a-zA-Z0-9_-]{1,200}\]$/.test(p.token)
  )
    throw new Error('Invalid Expo push token');
  if (
    typeof p.platform !== 'string' ||
    !['ios', 'android'].includes(p.platform) ||
    typeof p.enabled !== 'boolean' ||
    typeof p.sound !== 'boolean'
  )
    throw new Error('Platform and notification preferences are required');
}

export class PRPushStore {
  private pending: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly file: string,
    private data: PushData,
  ) {}
  static async load(file: string): Promise<PRPushStore> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return new PRPushStore(file, { version: 1, devices: [], deliveries: [] });
    }
    const data: unknown = JSON.parse(raw);
    if (!validate(data)) throw new Error('Invalid PR push store');
    if (
      new Set(data.devices.map((d) => d.id)).size !== data.devices.length ||
      new Set(data.deliveries.map((d) => d.id)).size !== data.deliveries.length ||
      data.deliveries.some((d) => !data.devices.some((device) => device.id === d.deviceId))
    )
      throw new Error('Invalid PR push identities');
    return new PRPushStore(file, data);
  }
  snapshot(): PushData {
    return structuredClone(this.data);
  }
  private change<T>(apply: (data: PushData) => T): Promise<T> {
    const work = this.pending.then(async () => {
      const copy = structuredClone(this.data);
      const result = apply(copy);
      await writeAtomicJSON(this.file, copy);
      this.data = copy;
      return structuredClone(result);
    });
    this.pending = work.then(
      () => undefined,
      () => undefined,
    ); // Caller receives failure; later mutations must still run.
    return work;
  }
  acknowledgement(ownerId: string, sourceId: string): string | undefined {
    return this.data.acknowledgements?.[JSON.stringify([ownerId, sourceId])];
  }
  acknowledge(ownerId: string, sourceId: string, authorized: () => boolean): Promise<void> {
    return this.change((data) => {
      if (!authorized()) throw new Error('Notification is unavailable');
      const key = JSON.stringify([ownerId, sourceId]);
      (data.acknowledgements ??= {})[key] ??= new Date().toISOString();
    });
  }
  register(
    ownerId: string,
    input: PRPushRegisterParams,
    authorized: () => boolean,
  ): Promise<PRPushDevice> {
    assertPushRegistration(input);
    const { expectedRevision, ...p } = structuredClone(input);
    return this.change((data) => {
      if (!authorized()) throw new Error('Notification registration authority was revoked');
      if (
        data.devices.some(
          (d) =>
            d.token === p.token &&
            d.enabled &&
            (d.ownerId !== ownerId || d.installationId !== p.installationId),
        )
      )
        throw new Error('Push token is already registered to another installation or principal');
      const previous = data.devices.find(
        (d) => d.ownerId === ownerId && d.installationId === p.installationId,
      );
      if (previous ? previous.revision !== expectedRevision : expectedRevision !== undefined)
        throw new Error('Push settings changed; refresh before registering');
      const now = new Date().toISOString();
      const changed =
        !previous ||
        previous.token !== p.token ||
        previous.profileId !== p.profileId ||
        previous.enabled !== p.enabled ||
        previous.sound !== p.sound ||
        previous.platform !== p.platform;
      const device: StoredPushDevice = {
        ...previous,
        ...p,
        id: previous?.id ?? randomUUID(),
        ownerId,
        revision: (previous?.revision ?? 0) + (changed ? 1 : 0),
        tokenRevision: previous
          ? (previous.tokenRevision ?? previous.revision) + (previous.token !== p.token ? 1 : 0)
          : 1,
        registeredAt: previous?.registeredAt ?? now,
        updatedAt: now,
      };
      if (previous && previous.token !== p.token) {
        for (const delivery of data.deliveries) {
          if (delivery.deviceId === device.id && delivery.state === 'failed') {
            Object.assign(delivery, {
              state: 'queued',
              attempts: 0,
              deviceRevision: device.revision,
              updatedAt: now,
            });
            delete delivery.error;
            delete delivery.ticketId;
            delete delivery.nextAttemptAt;
          }
        }
      }
      delete device.error;
      data.devices = data.devices.filter((d) => d.id !== device.id).concat(device);
      return publicDevice(device);
    });
  }
  disable(ownerId: string, installationId: string): Promise<void> {
    return this.change((data) => {
      const device = data.devices.find(
        (d) => d.ownerId === ownerId && d.installationId === installationId,
      );
      if (device?.enabled) {
        device.enabled = false;
        device.revision++;
        device.updatedAt = new Date().toISOString();
      }
    });
  }
  reserve(
    device: StoredPushDevice,
    sourceId: string,
    now: number,
  ): Promise<PRPushDelivery | undefined> {
    return this.change((data) => {
      const current = data.devices.find((d) => d.id === device.id);
      if (!current?.enabled || current.revision !== device.revision) return undefined;
      // Token rotation/preferences never replay an already delivered source on this installation.
      const id = createHash('sha256')
        .update(JSON.stringify([device.id, sourceId]))
        .digest('hex');
      const existing = data.deliveries.find((d) => d.id === id);
      if (existing) {
        if (existing.state === 'cancelled' && !existing.ticketId) {
          Object.assign(existing, {
            state: 'queued',
            updatedAt: new Date(now).toISOString(),
            deviceRevision: device.revision,
            deviceTokenRevision: device.tokenRevision ?? device.revision,
          });
          delete existing.error;
        }
        return existing;
      }
      const timestamp = new Date(now).toISOString();
      const delivery: PRPushDelivery = {
        id,
        deviceId: device.id,
        deviceRevision: device.revision,
        deviceTokenRevision: device.tokenRevision ?? device.revision,
        sourceId,
        state: 'queued',
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.deliveries.push(delivery);
      return delivery;
    });
  }
  update(id: string, patch: Partial<PRPushDelivery>): Promise<void> {
    return this.change((data) => {
      const delivery = data.deliveries.find((d) => d.id === id);
      if (!delivery) throw new Error('Push delivery is unavailable');
      Object.assign(delivery, patch, { updatedAt: new Date().toISOString() });
    });
  }
  recordFailure(
    id: string,
    tokenRevision: number,
    patch: Partial<PRPushDelivery>,
    invalidDevice: boolean,
  ): Promise<void> {
    return this.change((data) => {
      const delivery = data.deliveries.find((item) => item.id === id);
      if (!delivery) throw new Error('Push delivery is unavailable');
      const device = data.devices.find((item) => item.id === delivery.deviceId);
      const replaced =
        invalidDevice &&
        device?.enabled &&
        (device.tokenRevision ?? device.revision) !== tokenRevision;
      Object.assign(delivery, patch, { updatedAt: new Date().toISOString() });
      if (patch.state !== 'unknown') delete delivery.ticketId;
      if (replaced) {
        delivery.state = 'queued';
        delete delivery.nextAttemptAt;
        delete delivery.ticketId;
      } else if (
        invalidDevice &&
        device &&
        (device.tokenRevision ?? device.revision) === tokenRevision
      ) {
        device.enabled = false;
        device.error = patch.error;
        device.revision++;
      }
    });
  }
}

export function publicDevice(device: StoredPushDevice): PRPushDevice {
  const { token: _token, ownerId: _ownerId, tokenRevision: _tokenRevision, ...value } = device;
  return value;
}
