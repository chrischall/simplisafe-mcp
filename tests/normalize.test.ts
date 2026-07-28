import { describe, it, expect } from 'vitest';
import {
  deviceTypeName,
  lockStateName,
  normalizeSystem,
  normalizeSensor,
  normalizeEvent,
} from '../src/normalize.js';
import { subscriptionFixture, lockSensorFixture, entrySensorFixture } from './helpers.js';

describe('deviceTypeName', () => {
  it('maps known device type ids', () => {
    expect(deviceTypeName(5)).toBe('entry');
    expect(deviceTypeName(16)).toBe('lock');
    expect(deviceTypeName(20)).toBe('motion_v2');
    expect(deviceTypeName(253)).toBe('lock_keypad');
  });

  it('degrades to unknown_<n> for ids the reference enum does not cover', () => {
    // The live account returns 21, 23 and 24, which the reference client's enum
    // has no entry for. They must survive as identifiable devices rather than
    // being dropped or crashing the projection.
    expect(deviceTypeName(21)).toBe('unknown_21');
    expect(deviceTypeName(24)).toBe('unknown_24');
  });
});

describe('lockStateName', () => {
  // The encoding is counter-intuitive and getting it backwards would invert
  // every lock reading in the server, so it is pinned explicitly.
  it('reads 1 as locked and 2 as unlocked', () => {
    expect(lockStateName({ lockState: 1, lockJamState: 0 })).toBe('locked');
    expect(lockStateName({ lockState: 2, lockJamState: 0 })).toBe('unlocked');
  });

  it('reports a jam regardless of lockState', () => {
    expect(lockStateName({ lockState: 1, lockJamState: 1 })).toBe('jammed');
    expect(lockStateName({ lockState: 2, lockJamState: 1 })).toBe('jammed');
  });

  it('returns unknown for missing or unrecognized state', () => {
    expect(lockStateName(undefined)).toBe('unknown');
    expect(lockStateName({})).toBe('unknown');
    expect(lockStateName({ lockState: 7, lockJamState: 0 })).toBe('unknown');
  });
});

describe('normalizeSystem', () => {
  it('lifts state out of the nested location.system block', () => {
    const result = normalizeSystem(subscriptionFixture({ alarmState: 'AWAY' }));
    expect(result).toMatchObject({
      sid: 7858153,
      alarmState: 'AWAY',
      systemVersion: 3,
      isAlarming: false,
      connType: 'wifi',
      city: 'Testville',
    });
  });

  it('does not throw when location/system are absent', () => {
    expect(() => normalizeSystem({ sid: 1 })).not.toThrow();
    expect(normalizeSystem({ sid: 1 }).alarmState).toBeUndefined();
  });
});

describe('normalizeSensor', () => {
  it('projects an entry sensor with its flags', () => {
    const result = normalizeSensor(entrySensorFixture({ triggered: true, lowBattery: true }));
    expect(result).toMatchObject({
      name: 'Front Door',
      type: 5,
      typeName: 'entry',
      triggered: true,
      lowBattery: true,
      offline: false,
    });
  });

  it('adds a decoded lockState for locks only', () => {
    expect(normalizeSensor(lockSensorFixture({ lockState: 1 })).lockState).toBe('locked');
    expect(normalizeSensor(entrySensorFixture()).lockState).toBeUndefined();
  });

  it('preserves a non-empty raw status so device-specific flags survive', () => {
    // A smoke/CO combo carries flags this projection has no named field for.
    const smoke = { serial: 'S1', type: 24, name: 'Hall', flags: {}, status: { smokeTriggered: true } };
    expect(normalizeSensor(smoke).status).toEqual({ smokeTriggered: true });
  });

  it('omits status entirely when it is empty', () => {
    const keypad = { serial: 'K1', type: 1, name: 'Keypad', flags: {}, status: {} };
    expect(normalizeSensor(keypad).status).toBeUndefined();
  });
});

describe('normalizeEvent', () => {
  it('adds an ISO time beside the raw epoch seconds', () => {
    const result = normalizeEvent({
      eventId: 80339933010,
      eventTimestamp: 1785238087,
      eventType: 'activity',
      sensorType: 16,
      sensorName: 'Mudroom',
      info: 'Doorlock Unlocked',
    });
    expect(result.timestamp).toBe(1785238087);
    expect(result.isoTime).toBe(new Date(1785238087 * 1000).toISOString());
    expect(result.sensorTypeName).toBe('lock');
  });

  it('yields an empty isoTime rather than an Invalid Date string', () => {
    expect(normalizeEvent({ eventId: 1 }).isoTime).toBe('');
  });
});
