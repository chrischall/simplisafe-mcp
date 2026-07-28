import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { registerLockTools } from '../../src/tools/locks.js';
import { client } from '../../src/client.js';
import { createTestHarness, subscriptionFixture, lockSensorFixture } from '../helpers.js';
import { parseToolResult } from '@chrischall/mcp-utils/test';

const resolveSpy = vi.spyOn(client, 'resolveSystem');
const requestSpy = vi.spyOn(client, 'request');
const writeSpy = vi.spyOn(client, 'write');

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => {
  resolveSpy.mockReset().mockResolvedValue({
    sid: 7858153,
    systemVersion: 3,
    raw: subscriptionFixture(),
  });
  requestSpy.mockReset();
  writeSpy.mockReset();
});
afterAll(async () => {
  if (harness) await harness.close();
});

/** Drive a confirmed call past the tool's post-write verification delay. */
async function callWithTimers(args: Record<string, unknown>) {
  vi.useFakeTimers();
  try {
    const pending = harness.callTool('simplisafe_set_lock_state', args);
    await vi.advanceTimersByTimeAsync(30000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

describe('simplisafe_set_lock_state', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerLockTools(server, client));
    const names = (await harness.listTools()).map((t) => t.name);
    expect(names).toContain('simplisafe_set_lock_state');
  });

  it('makes NO write without confirm: true', async () => {
    requestSpy.mockResolvedValue({ sensors: [lockSensorFixture({ serial: 'L1' })] } as never);

    const parsed = parseToolResult(
      await harness.callTool('simplisafe_set_lock_state', { serial: 'L1', state: 'unlock' }),
    ) as Record<string, unknown>;

    expect(parsed.dryRun).toBe(true);
    expect(parsed.currentState).toBe('unlocked');
    expect(String(parsed.warning)).toMatch(/physically UNLOCKS/i);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('forces a FRESH poll for both the before-read and the verification re-read', async () => {
    // Verifying a write against the cached payload is not verification: it once
    // reported "restored to baseline" for a lock that had actually jammed.
    requestSpy
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })] } as never);
    writeSpy.mockResolvedValue({ ok: true } as never);

    await callWithTimers({ serial: 'L1', state: 'lock', confirm: true });

    // 1 before-read + at least 1 verification read; every one of them fresh.
    expect(requestSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of requestSpy.mock.calls) {
      expect(call[2]).toEqual({ query: { forceUpdate: 'true' } });
    }
  });

  it('posts the doorlock route with the action in the body', async () => {
    requestSpy
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })] } as never);
    writeSpy.mockResolvedValue({ ok: true } as never);

    const parsed = parseToolResult(
      await callWithTimers({ serial: 'L1', state: 'lock', confirm: true }),
    ) as Record<string, unknown>;

    expect(writeSpy).toHaveBeenCalledWith('/doorlock/7858153/L1/state', { state: 'lock' });
    expect(parsed.previousState).toBe('unlocked');
    expect(parsed.currentState).toBe('locked');
    expect(parsed.verification).toBe('confirmed');
  });

  it('reports a jam distinctly instead of calling it success or plain failure', async () => {
    requestSpy
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never)
      .mockResolvedValue({
        sensors: [lockSensorFixture({ serial: 'L1', lockJamState: 1 })],
      } as never);
    writeSpy.mockResolvedValue({ ok: true } as never);

    const parsed = parseToolResult(
      await callWithTimers({ serial: 'L1', state: 'lock', confirm: true }),
    ) as Record<string, unknown>;

    expect(parsed.verification).toBe('jammed');
    expect(String(parsed.detail)).toMatch(/physical attention/i);
  });

  it('reports unconfirmed when the lock never moves, after exhausting the poll budget', async () => {
    requestSpy
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never)
      .mockResolvedValue({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never);
    writeSpy.mockResolvedValue({ ok: true } as never);

    const parsed = parseToolResult(
      await callWithTimers({ serial: 'L1', state: 'lock', confirm: true }),
    ) as Record<string, unknown>;

    expect(parsed.verification).toBe('unconfirmed');
  });

  it('confirms a SLOW lock that only settles after several polls', async () => {
    // The regression this guards: a single 3s delay reported a successful live
    // unlock as `unconfirmed` because the bolt was still travelling.
    requestSpy
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })] } as never)
      .mockResolvedValue({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never);
    writeSpy.mockResolvedValue({ ok: true } as never);

    const parsed = parseToolResult(
      await callWithTimers({ serial: 'L1', state: 'unlock', confirm: true }),
    ) as Record<string, unknown>;

    expect(parsed.verification).toBe('confirmed');
    expect(parsed.currentState).toBe('unlocked');
    expect(Number(parsed.verifiedAfterSeconds)).toBeGreaterThan(2.5);
  });

  it('errors with the known serials when the lock is not found, before writing', async () => {
    requestSpy.mockResolvedValue({
      sensors: [lockSensorFixture({ serial: 'L1', name: 'Mudroom' })],
    } as never);

    const result = await harness.callTool('simplisafe_set_lock_state', {
      serial: 'NOPE',
      state: 'unlock',
      confirm: true,
    });

    expect(JSON.stringify(result)).toMatch(/No lock with serial .*NOPE.* on system 7858153/s);
    expect(JSON.stringify(result)).toMatch(/Mudroom \(L1\)/);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
