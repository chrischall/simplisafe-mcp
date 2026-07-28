/**
 * Projections from SimpliSafe's raw API payloads to compact, agent-friendly
 * records.
 *
 * Every field name here was read off a real response (see docs/SIMPLISAFE-API.md),
 * not inferred. Where the upstream shape drifts, these helpers degrade to
 * `undefined`/`unknown_<n>` rather than throwing — an undocumented API changing
 * a field should not take the whole tool down.
 */

/**
 * Device type ids. Sourced from the reference client's `DeviceTypes` enum and
 * cross-checked against the live account, which also returns ids 21, 23 and 24
 * that the reference enum does not cover — those fall through to
 * `unknown_<n>` and keep their raw status rather than being dropped.
 */
const DEVICE_TYPE_NAMES: Record<number, string> = {
  0: 'remote',
  1: 'keypad',
  2: 'keychain',
  3: 'panic_button',
  4: 'motion',
  5: 'entry',
  6: 'glass_break',
  7: 'carbon_monoxide',
  8: 'smoke',
  9: 'leak',
  10: 'temperature',
  12: 'camera',
  13: 'siren',
  14: 'smoke_and_carbon_monoxide',
  15: 'doorbell',
  16: 'lock',
  17: 'outdoor_camera',
  20: 'motion_v2',
  22: 'outdoor_alarm_security_bell_box',
  253: 'lock_keypad',
};

export function deviceTypeName(type: number): string {
  return DEVICE_TYPE_NAMES[type] ?? `unknown_${type}`;
}

/**
 * Lock state, from the raw `status` block.
 *
 * The raw encoding is NOT the obvious one: `lockState` 1 means LOCKED and 2
 * means UNLOCKED (confirmed against the reference client's internal enum and a
 * live lock). `lockJamState` takes precedence — a jammed lock is neither.
 */
export function lockStateName(status: Record<string, unknown> | undefined): string {
  if (!status) return 'unknown';
  if (status.lockJamState) return 'jammed';
  switch (status.lockState) {
    case 1:
      return 'locked';
    case 2:
      return 'unlocked';
    default:
      return 'unknown';
  }
}

export interface NormalizedSystem {
  sid: number;
  locationName?: string;
  city?: string;
  state?: string;
  systemVersion?: number;
  alarmState?: string;
  isAlarming?: boolean;
  isOffline?: boolean;
  powerOutage?: boolean;
  connType?: string;
  temperature?: number | null;
  exitDelayRemaining?: number;
  serial?: string;
  planName?: string;
  alarmStateTimestamp?: number;
}

/** Project one raw subscription into a compact system record. */
export function normalizeSystem(sub: Record<string, unknown>): NormalizedSystem {
  const location = (sub.location ?? {}) as Record<string, unknown>;
  const system = (location.system ?? {}) as Record<string, unknown>;

  return {
    sid: Number(sub.sid),
    locationName: (location.locationName as string) || undefined,
    city: (location.city as string) || undefined,
    state: (location.state as string) || undefined,
    systemVersion: system.version as number | undefined,
    alarmState: system.alarmState as string | undefined,
    isAlarming: system.isAlarming as boolean | undefined,
    isOffline: system.isOffline as boolean | undefined,
    powerOutage: system.powerOutage as boolean | undefined,
    connType: system.connType as string | undefined,
    temperature: (system.temperature as number | null) ?? undefined,
    exitDelayRemaining: system.exitDelayRemaining as number | undefined,
    serial: system.serial as string | undefined,
    planName: sub.planName as string | undefined,
    alarmStateTimestamp: system.alarmStateTimestamp as number | undefined,
  };
}

export interface NormalizedSensor {
  serial: string;
  name: string;
  type: number;
  typeName: string;
  offline?: boolean;
  lowBattery?: boolean;
  triggered?: boolean;
  rssi?: number;
  firmwareVersion?: string;
  /** Present only for locks. */
  lockState?: string;
  /** Non-empty raw status, preserved so device-specific flags aren't lost. */
  status?: Record<string, unknown>;
}

/** Project one raw sensor record. */
export function normalizeSensor(raw: Record<string, unknown>): NormalizedSensor {
  const flags = (raw.flags ?? {}) as Record<string, unknown>;
  const status = (raw.status ?? {}) as Record<string, unknown>;
  const type = Number(raw.type);

  const normalized: NormalizedSensor = {
    serial: String(raw.serial ?? ''),
    name: (raw.name as string) || '(unnamed)',
    type,
    typeName: deviceTypeName(type),
    offline: flags.offline as boolean | undefined,
    lowBattery: flags.lowBattery as boolean | undefined,
    rssi: raw.rssi as number | undefined,
    firmwareVersion: raw.firmwareVersion as string | undefined,
  };

  if (typeof status.triggered === 'boolean') normalized.triggered = status.triggered;
  if (type === 16) normalized.lockState = lockStateName(status);
  if (Object.keys(status).length > 0) normalized.status = status;

  return normalized;
}

export interface NormalizedEvent {
  eventId: number;
  timestamp: number;
  isoTime: string;
  eventType?: string;
  eventCid?: number;
  info?: string;
  sensorName?: string;
  sensorType?: number;
  sensorTypeName?: string;
  pinName?: string;
  messageSubject?: string;
}

/** Project one raw event record. Adds an ISO time beside the raw epoch. */
export function normalizeEvent(raw: Record<string, unknown>): NormalizedEvent {
  const ts = Number(raw.eventTimestamp ?? 0);
  const sensorType = raw.sensorType as number | undefined;

  return {
    eventId: Number(raw.eventId),
    timestamp: ts,
    // The API returns seconds since epoch; surface both so an agent needn't convert.
    isoTime: ts ? new Date(ts * 1000).toISOString() : '',
    eventType: raw.eventType as string | undefined,
    eventCid: raw.eventCid as number | undefined,
    info: (raw.info as string) || undefined,
    sensorName: (raw.sensorName as string) || undefined,
    sensorType,
    sensorTypeName: sensorType === undefined ? undefined : deviceTypeName(sensorType),
    pinName: (raw.pinName as string) || undefined,
    messageSubject: (raw.messageSubject as string) || undefined,
  };
}
