import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { registerDeviceTools } from '../../src/tools/devices.js';
import { client } from '../../src/client.js';
import {
  createTestHarness,
  subscriptionFixture,
  lockSensorFixture,
  entrySensorFixture,
} from '../helpers.js';
import { parseToolResult } from '@chrischall/mcp-utils/test';

const resolveSpy = vi.spyOn(client, 'resolveSystem');
const requestSpy = vi.spyOn(client, 'request');

let harness: Awaited<ReturnType<typeof createTestHarness>>;

const SENSORS = [
  entrySensorFixture({ serial: 'E1', name: 'Front Door' }),
  entrySensorFixture({ serial: 'E2', name: 'Back Door', lowBattery: true }),
  lockSensorFixture({ serial: 'L1', name: 'Mudroom', lockState: 2 }),
  lockSensorFixture({ serial: 'L2', name: 'Front', lockState: 1 }),
  { serial: 'K1', type: 1, name: 'Keypad', flags: { offline: true, lowBattery: false }, status: {} },
];

beforeEach(() => {
  resolveSpy.mockReset().mockResolvedValue({
    sid: 7858153,
    systemVersion: 3,
    raw: subscriptionFixture(),
  });
  requestSpy.mockReset().mockResolvedValue({ sensors: SENSORS } as never);
});
afterAll(async () => {
  if (harness) await harness.close();
});

describe('simplisafe_list_sensors', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerDeviceTools(server, client));
    const names = (await harness.listTools()).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['simplisafe_list_sensors', 'simplisafe_list_locks']),
    );
  });

  it('lists every device with a type roster', async () => {
    const parsed = parseToolResult(await harness.callTool('simplisafe_list_sensors')) as {
      count: number;
      typesPresent: string[];
    };
    expect(parsed.count).toBe(5);
    expect(parsed.typesPresent).toEqual(['entry', 'keypad', 'lock']);
  });

  it('defaults to forceUpdate=false so it does not re-poll the hardware', async () => {
    await harness.callTool('simplisafe_list_sensors');
    expect(requestSpy).toHaveBeenCalledWith('GET', '/ss3/subscriptions/7858153/sensors', {
      query: { forceUpdate: 'false' },
    });
  });

  it('passes forceUpdate=true only when asked', async () => {
    await harness.callTool('simplisafe_list_sensors', { force_update: true });
    expect(requestSpy).toHaveBeenCalledWith('GET', '/ss3/subscriptions/7858153/sensors', {
      query: { forceUpdate: 'true' },
    });
  });

  it('filters by type name', async () => {
    const parsed = parseToolResult(
      await harness.callTool('simplisafe_list_sensors', { type_name: 'lock' }),
    ) as { count: number; sensors: { typeName: string }[] };
    expect(parsed.count).toBe(2);
    expect(parsed.sensors.every((s) => s.typeName === 'lock')).toBe(true);
  });

  it('problems_only surfaces the offline keypad and the low-battery door', async () => {
    const parsed = parseToolResult(
      await harness.callTool('simplisafe_list_sensors', { problems_only: true }),
    ) as { count: number; sensors: { name: string }[] };
    expect(parsed.sensors.map((s) => s.name).sort()).toEqual(['Back Door', 'Keypad']);
  });
});

describe('simplisafe_list_locks', () => {
  it('polls FRESH by default, unlike the general sensor list', async () => {
    // A cached payload has been observed reporting a jammed lock as cleanly
    // unlocked. For "is my door locked?" a stale answer is worse than a slow one.
    await harness.callTool('simplisafe_list_locks');
    expect(requestSpy).toHaveBeenCalledWith('GET', '/ss3/subscriptions/7858153/sensors', {
      query: { forceUpdate: 'true' },
    });
  });

  it('allows opting back into the cached read, and says which was used', async () => {
    const parsed = parseToolResult(
      await harness.callTool('simplisafe_list_locks', { force_update: false }),
    ) as { dataFreshness: string };
    expect(requestSpy).toHaveBeenCalledWith('GET', '/ss3/subscriptions/7858153/sensors', {
      query: { forceUpdate: 'false' },
    });
    expect(parsed.dataFreshness).toMatch(/cached/);
  });

  it('returns only locks, with decoded state', async () => {
    const parsed = parseToolResult(await harness.callTool('simplisafe_list_locks')) as {
      count: number;
      locks: { name: string; state: string; serial: string }[];
    };

    expect(parsed.count).toBe(2);
    // Pins the raw encoding end to end through the tool layer: 2 -> unlocked,
    // 1 -> locked.
    expect(parsed.locks.find((l) => l.serial === 'L1')?.state).toBe('unlocked');
    expect(parsed.locks.find((l) => l.serial === 'L2')?.state).toBe('locked');
  });

  it('returns an empty list rather than erroring when there are no locks', async () => {
    requestSpy.mockResolvedValue({ sensors: [entrySensorFixture()] } as never);
    const parsed = parseToolResult(await harness.callTool('simplisafe_list_locks')) as {
      count: number;
    };
    expect(parsed.count).toBe(0);
  });

  it('degrades to an empty list when the payload has no sensors array', async () => {
    requestSpy.mockResolvedValue({} as never);
    const parsed = parseToolResult(await harness.callTool('simplisafe_list_locks')) as {
      count: number;
    };
    expect(parsed.count).toBe(0);
  });
});
