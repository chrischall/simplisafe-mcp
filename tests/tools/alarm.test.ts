import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { registerAlarmTools, classifyStateChange } from '../../src/tools/alarm.js';
import { client } from '../../src/client.js';
import { createTestHarness, subscriptionFixture, confirmTokenOf } from '../helpers.js';
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

/** Drive a call past the tool's post-write verification delay. */
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

/**
 * Run both phases of the confirm-token flow: phase 1 (no token) for the preview
 * and token, then phase 2 with that token, past the verification delay. Each
 * phase reads the system once, so a test mocks one read per phase before the
 * verification re-read.
 */
async function confirmedCall(args: Record<string, unknown>) {
  const phase1 = await harness.callTool('simplisafe_set_alarm_state', args);
  expect(writeSpy).not.toHaveBeenCalled();
  return callWithTimers({ ...args, confirmToken: confirmTokenOf(phase1) });
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

  it('phase 1 returns a preview and a token and makes NO write', async () => {
    resolveSpy.mockResolvedValue({ sid: 7858153, systemVersion: 3, raw: subscriptionFixture() });

    const result = await harness.callTool('simplisafe_set_alarm_state', { state: 'away' });
    const parsed = parseToolResult(result) as Record<string, unknown>;
    const preview = parsed.preview as Record<string, unknown>;

    expect(parsed.status).toBe('confirmation-required');
    expect(typeof parsed.confirmToken).toBe('string');
    expect(preview).toMatchObject({
      method: 'POST',
      path: '/ss3/subscriptions/7858153/state/away',
      sid: 7858153,
      requestedState: 'AWAY',
      currentState: 'OFF',
    });
    // The load-bearing assertion: the gate is what prevents a hallucinated call
    // from arming a real house.
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('warns about the physical consequence in the preview', async () => {
    resolveSpy.mockResolvedValue({ sid: 1, systemVersion: 3, raw: subscriptionFixture() });

    const off = parseToolResult(
      await harness.callTool('simplisafe_set_alarm_state', { state: 'off' }),
    ) as { preview: Record<string, string> };
    expect(off.preview.warning).toMatch(/unmonitored/i);

    const away = parseToolResult(
      await harness.callTool('simplisafe_set_alarm_state', { state: 'away' }),
    ) as { preview: Record<string, string> };
    expect(away.preview.warning).toMatch(/dispatch/i);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('phase 2 posts to the ss3 state route once and verifies by re-reading', async () => {
    resolveSpy
      .mockResolvedValueOnce({ sid: 7858153, systemVersion: 3, raw: subscriptionFixture() })
      .mockResolvedValueOnce({ sid: 7858153, systemVersion: 3, raw: subscriptionFixture() })
      .mockResolvedValueOnce({
        sid: 7858153,
        systemVersion: 3,
        raw: subscriptionFixture({ alarmState: 'AWAY_COUNT' }),
      });
    writeSpy.mockResolvedValue({ ok: true } as never);

    const parsed = parseToolResult(
      await confirmedCall({ state: 'away' }),
    ) as Record<string, unknown>;

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('/ss3/subscriptions/7858153/state/away');
    expect(parsed.previousState).toBe('OFF');
    expect(parsed.currentState).toBe('AWAY_COUNT');
    expect(parsed.verification).toBe('in_progress');
  });

  it('reports unconfirmed when the system does not actually move', async () => {
    // A 2xx that changed nothing must NOT read as success.
    resolveSpy.mockResolvedValue({ sid: 1, systemVersion: 3, raw: subscriptionFixture() });
    writeSpy.mockResolvedValue({ ok: true } as never);

    const parsed = parseToolResult(
      await confirmedCall({ state: 'home' }),
    ) as Record<string, unknown>;

    expect(parsed.verification).toBe('unconfirmed');
  });

  it('reports unverified (not an error) when the post-write re-read fails', async () => {
    // The command WAS sent. A transient failure re-reading state must not tell
    // the model the disarm failed — it may then retry or misreport it.
    resolveSpy
      .mockResolvedValueOnce({ sid: 1, systemVersion: 3, raw: subscriptionFixture() })
      .mockResolvedValueOnce({ sid: 1, systemVersion: 3, raw: subscriptionFixture() })
      .mockRejectedValueOnce(new Error('SimpliSafe API 503'));
    writeSpy.mockResolvedValue({ ok: true } as never);

    const result = await confirmedCall({ state: 'off' });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(parsed.verification).toBe('unverified');
    expect(parsed.commandSent).toBe(true);
    expect(String(parsed.detail)).toMatch(/was sent/i);
    expect(String(parsed.detail)).toMatch(/SimpliSafe API 503/);
    expect(parsed.response).toEqual({ ok: true });
  });

  it('refuses on a non-SS3 system before sending anything', async () => {
    resolveSpy.mockResolvedValue({
      sid: 1,
      systemVersion: 2,
      raw: subscriptionFixture({ version: 2 }),
    });

    // Refused before the gate: no preview, no token, nothing to confirm.
    const result = await harness.callTool('simplisafe_set_alarm_state', { state: 'off' });
    expect(JSON.stringify(result)).toMatch(/requires a SimpliSafe 3 system/);
    expect(JSON.stringify(result)).not.toContain('confirmToken');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('rejects a state outside the accepted enum', async () => {
    const result = await harness.callTool('simplisafe_set_alarm_state', { state: 'panic' });
    expect(result.isError).toBe(true);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
