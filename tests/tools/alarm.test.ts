import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { registerAlarmTools, classifyStateChange } from '../../src/tools/alarm.js';
import { client } from '../../src/client.js';
import { createTestHarness, subscriptionFixture } from '../helpers.js';
import { parseToolResult } from '@chrischall/mcp-utils/test';

const resolveSpy = vi.spyOn(client, 'resolveSystem');
const writeSpy = vi.spyOn(client, 'write');

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => {
  resolveSpy.mockReset();
  writeSpy.mockReset();
});
afterAll(async () => {
  if (harness) await harness.close();
});

/** Drive a confirmed call past the tool's post-write verification delay. */
async function callWithTimers(args: Record<string, unknown>) {
  vi.useFakeTimers();
  try {
    const pending = harness.callTool('simplisafe_set_alarm_state', args);
    await vi.advanceTimersByTimeAsync(5000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

describe('classifyStateChange', () => {
  it('confirms an exact state match', () => {
    expect(classifyStateChange('off', 'AWAY', 'OFF').verdict).toBe('confirmed');
  });

  it('treats the exit-delay countdown as in_progress, not failure', () => {
    // Arming reports AWAY_COUNT until the exit delay expires. Calling that a
    // failure would make every successful arm look broken.
    const result = classifyStateChange('away', 'OFF', 'AWAY_COUNT');
    expect(result.verdict).toBe('in_progress');
    expect(result.detail).toMatch(/exit delay/i);
  });

  it('reports unconfirmed when the state did not move', () => {
    // The verification must be CAPABLE of failing — a classifier that always
    // returns success is worse than none.
    const result = classifyStateChange('away', 'OFF', 'OFF');
    expect(result.verdict).toBe('unconfirmed');
    expect(result.detail).toMatch(/Expected AWAY/);
  });

  it('reports unconfirmed rather than crashing when the state is missing', () => {
    expect(classifyStateChange('home', undefined, undefined).verdict).toBe('unconfirmed');
  });
});

describe('simplisafe_set_alarm_state', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerAlarmTools(server, client));
    const names = (await harness.listTools()).map((t) => t.name);
    expect(names).toContain('simplisafe_set_alarm_state');
  });

  it('makes NO network call without confirm: true', async () => {
    resolveSpy.mockResolvedValue({ sid: 7858153, systemVersion: 3, raw: subscriptionFixture() });

    const result = await harness.callTool('simplisafe_set_alarm_state', { state: 'away' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.dryRun).toBe(true);
    expect(parsed.requestedState).toBe('AWAY');
    expect(parsed.currentState).toBe('OFF');
    // The load-bearing assertion: the gate is what prevents a hallucinated call
    // from arming a real house.
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('warns about the physical consequence in the dry run', async () => {
    resolveSpy.mockResolvedValue({ sid: 1, systemVersion: 3, raw: subscriptionFixture() });

    const off = parseToolResult(
      await harness.callTool('simplisafe_set_alarm_state', { state: 'off' }),
    ) as Record<string, string>;
    expect(off.warning).toMatch(/unmonitored/i);

    const away = parseToolResult(
      await harness.callTool('simplisafe_set_alarm_state', { state: 'away' }),
    ) as Record<string, string>;
    expect(away.warning).toMatch(/dispatch/i);
  });

  it('posts to the ss3 state route and verifies by re-reading', async () => {
    resolveSpy
      .mockResolvedValueOnce({ sid: 7858153, systemVersion: 3, raw: subscriptionFixture() })
      .mockResolvedValueOnce({
        sid: 7858153,
        systemVersion: 3,
        raw: subscriptionFixture({ alarmState: 'AWAY_COUNT' }),
      });
    writeSpy.mockResolvedValue({ ok: true } as never);

    const parsed = parseToolResult(
      await callWithTimers({ state: 'away', confirm: true }),
    ) as Record<string, unknown>;

    expect(writeSpy).toHaveBeenCalledWith('/ss3/subscriptions/7858153/state/away');
    expect(parsed.previousState).toBe('OFF');
    expect(parsed.currentState).toBe('AWAY_COUNT');
    expect(parsed.verification).toBe('in_progress');
  });

  it('reports unconfirmed when the system does not actually move', async () => {
    // A 2xx that changed nothing must NOT read as success.
    resolveSpy
      .mockResolvedValueOnce({ sid: 1, systemVersion: 3, raw: subscriptionFixture() })
      .mockResolvedValueOnce({ sid: 1, systemVersion: 3, raw: subscriptionFixture() });
    writeSpy.mockResolvedValue({ ok: true } as never);

    const parsed = parseToolResult(
      await callWithTimers({ state: 'home', confirm: true }),
    ) as Record<string, unknown>;

    expect(parsed.verification).toBe('unconfirmed');
  });

  it('refuses on a non-SS3 system before sending anything', async () => {
    resolveSpy.mockResolvedValue({
      sid: 1,
      systemVersion: 2,
      raw: subscriptionFixture({ version: 2 }),
    });

    const result = await harness.callTool('simplisafe_set_alarm_state', {
      state: 'off',
      confirm: true,
    });
    expect(JSON.stringify(result)).toMatch(/requires a SimpliSafe 3 system/);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('rejects a state outside the accepted enum', async () => {
    const result = await harness.callTool('simplisafe_set_alarm_state', {
      state: 'panic',
      confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
