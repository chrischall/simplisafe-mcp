// Re-export the shared in-memory test harness from `@chrischall/mcp-utils/test`,
// matching the fleet convention so test imports read the same everywhere.
export { createTestHarness } from '@chrischall/mcp-utils/test';

/**
 * Fixtures below are trimmed copies of REAL responses captured from a live
 * SimpliSafe account (see docs/SIMPLISAFE-API.md). Serial numbers and address
 * fields are replaced with obvious placeholders; the field names, types and
 * encodings are verbatim — including the lock encoding, where 1 = locked and
 * 2 = unlocked.
 */
export function subscriptionFixture(
  overrides: { sid?: number; alarmState?: string; version?: number } = {},
): Record<string, unknown> {
  return {
    sid: overrides.sid ?? 7858153,
    planName: 'Interactive Monitoring',
    location: {
      locationName: '',
      city: 'Testville',
      state: 'NC',
      system: {
        serial: 'BASE0001',
        version: overrides.version ?? 3,
        alarmState: overrides.alarmState ?? 'OFF',
        alarmStateTimestamp: 1785238087,
        isAlarming: false,
        isOffline: false,
        powerOutage: false,
        connType: 'wifi',
        temperature: null,
        exitDelayRemaining: 60,
        messages: [],
      },
    },
  };
}

export function lockSensorFixture(
  overrides: { serial?: string; name?: string; lockState?: number; lockJamState?: number } = {},
): Record<string, unknown> {
  return {
    serial: overrides.serial ?? 'LOCK0001',
    type: 16,
    name: overrides.name ?? 'Mudroom',
    flags: { offline: false, lowBattery: false, hardwareId: 1 },
    setting: { autoLock: 0 },
    status: {
      lockState: overrides.lockState ?? 2,
      lockJamState: overrides.lockJamState ?? 0,
      lockLowBattery: false,
      lockDisabled: false,
      pinPadLowBattery: false,
      pinPadOffline: false,
      pinPadState: 0,
    },
    firmwareVersion: '1.7.2',
  };
}

export function entrySensorFixture(
  overrides: { serial?: string; name?: string; triggered?: boolean; lowBattery?: boolean } = {},
): Record<string, unknown> {
  return {
    serial: overrides.serial ?? 'ENTRY001',
    type: 5,
    name: overrides.name ?? 'Front Door',
    flags: {
      offline: false,
      lowBattery: overrides.lowBattery ?? false,
      swingerShutdown: false,
    },
    status: { triggered: overrides.triggered ?? false },
    rssi: -61,
    firmwareVersion: '2.13.10',
  };
}
