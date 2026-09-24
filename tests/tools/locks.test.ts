import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { registerLockTools } from '../../src/tools/locks.js';
import { client } from '../../src/client.js';
import { createTestHarness, subscriptionFixture, lockSensorFixture, confirmTokenOf } from '../helpers.js';
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

/** Drive a call past the tool's post-write verification polling. */
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

/**
 * Run both phases of the confirm-token flow. Each phase does its own fresh
 * before-read, so a test mocks one lock read per phase ahead of the
 * verification polls.
 */
async function confirmedCall(args: Record<string, unknown>) {
  const phase1 = await harness.callTool('simplisafe_set_lock_state', args);
  expect(writeSpy).not.toHaveBeenCalled();
  return callWithTimers({ ...args, confirmToken: confirmTokenOf(phase1) });
}

describe('simplisafe_set_lock_state', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerLockTools(server, client));
    const names = (await harness.listTools()).map((t) => t.name);
    expect(names).toContain('simplisafe_set_lock_state');
  });

  it('phase 1 returns a preview and a token and makes NO write', async () => {
    requestSpy.mockResolvedValue({ sensors: [lockSensorFixture({ serial: 'L1' })] } as never);

    const parsed = parseToolResult(
      await harness.callTool('simplisafe_set_lock_state', { serial: 'L1', state: 'unlock' }),
    ) as Record<string, unknown>;
    const preview = parsed.preview as Record<string, unknown>;

    expect(parsed.status).toBe('confirmation-required');
    expect(typeof parsed.confirmToken).toBe('string');
    expect(preview).toMatchObject({
      method: 'POST',
      path: '/doorlock/7858153/L1/state',
      willSend: { state: 'unlock' },
      sid: 7858153,
      lockName: 'Mudroom',
      currentState: 'unlocked',
    });
    expect(String(preview.warning)).toMatch(/physically UNLOCKS/i);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('forces a FRESH poll for both the before-read and the verification re-read', async () => {
    // Verifying a write against the cached payload is not verification: it once
    // reported "restored to baseline" for a lock that had actually jammed.
    requestSpy
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })] } as never);
    writeSpy.mockResolvedValue({ ok: true } as never);

    await confirmedCall({ serial: 'L1', state: 'lock' });

    // 1 before-read per phase + at least 1 verification read; every one fresh.
    expect(requestSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of requestSpy.mock.calls) {
      expect(call[2]).toEqual({ query: { forceUpdate: 'true' } });
    }
  });

  it('posts the doorlock route with the action in the body', async () => {
    requestSpy
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })] } as never);
    writeSpy.mockResolvedValue({ ok: true } as never);

    const parsed = parseToolResult(
      await confirmedCall({ serial: 'L1', state: 'lock' }),
    ) as Record<string, unknown>;

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('/doorlock/7858153/L1/state', { state: 'lock' });
    expect(parsed.previousState).toBe('unlocked');
    expect(parsed.currentState).toBe('locked');
    expect(parsed.verification).toBe('confirmed');
  });

  it('reports a jam distinctly instead of calling it success or plain failure', async () => {
    requestSpy
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never)
      .mockResolvedValue({
        sensors: [lockSensorFixture({ serial: 'L1', lockJamState: 1 })],
      } as never);
    writeSpy.mockResolvedValue({ ok: true } as never);

    const parsed = parseToolResult(
      await confirmedCall({ serial: 'L1', state: 'lock' }),
    ) as Record<string, unknown>;

    expect(parsed.verification).toBe('jammed');
    expect(String(parsed.detail)).toMatch(/physical attention/i);
  });

  it('reports unconfirmed when the lock never moves, after exhausting the poll budget', async () => {
    requestSpy
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never)
      .mockResolvedValue({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never);
    writeSpy.mockResolvedValue({ ok: true } as never);

    const parsed = parseToolResult(
      await confirmedCall({ serial: 'L1', state: 'lock' }),
    ) as Record<string, unknown>;

    expect(parsed.verification).toBe('unconfirmed');
  });

  it('reports unverified (not an error) when a verification poll fails after the write', async () => {
    // The door may already be open. A 5xx/timeout on the re-read must not be
    // surfaced as "failed to unlock".
    requestSpy
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })] } as never)
      .mockRejectedValueOnce(new Error('SimpliSafe API timeout'));
    writeSpy.mockResolvedValue({ ok: true } as never);

    const result = await confirmedCall({ serial: 'L1', state: 'unlock' });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledTimes(3); // two before-reads, then stops polling after the failure
    expect(parsed.verification).toBe('unverified');
    expect(parsed.commandSent).toBe(true);
    expect(String(parsed.detail)).toMatch(/was sent/i);
    expect(String(parsed.detail)).toMatch(/SimpliSafe API timeout/);
    expect(parsed.previousState).toBe('locked');
  });

  it('confirms a SLOW lock that only settles after several polls', async () => {
    // The regression this guards: a single 3s delay reported a successful live
    // unlock as `unconfirmed` because the bolt was still travelling.
    requestSpy
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })] } as never)
      .mockResolvedValueOnce({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })] } as never)
      .mockResolvedValue({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never);
    writeSpy.mockResolvedValue({ ok: true } as never);

    const parsed = parseToolResult(
      await confirmedCall({ serial: 'L1', state: 'unlock' }),
    ) as Record<string, unknown>;

    expect(parsed.verification).toBe('confirmed');
    expect(parsed.currentState).toBe('unlocked');
    expect(Number(parsed.verifiedAfterSeconds)).toBeGreaterThan(2.5);
  });

  it('errors with the known serials when the lock is not found, before writing', async () => {
    requestSpy.mockResolvedValue({
      sensors: [lockSensorFixture({ serial: 'L1', name: 'Mudroom' })],
    } as never);

    // Refused before the gate: an unknown serial never gets a preview or token.
    const result = await harness.callTool('simplisafe_set_lock_state', {
      serial: 'NOPE',
      state: 'unlock',
    });

    expect(JSON.stringify(result)).toMatch(/No lock with serial .*NOPE.* on system 7858153/s);
    expect(JSON.stringify(result)).toMatch(/Mudroom \(L1\)/);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
