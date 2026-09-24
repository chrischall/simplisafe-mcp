// The confirm-token flow end to end, on the real gated tools.
//
// A harness created WITHOUT an elicitation handler is a client that cannot show
// a confirmation prompt (claude.ai, Claude Desktop): under the default
// MCP_CONFIRM_MODE=ask-user it gets the two-phase preview-plus-token flow. A
// harness WITH one is a client that can (Claude Code), which is asked instead.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerAlarmTools } from '../../src/tools/alarm.js';
import { registerLockTools } from '../../src/tools/locks.js';
import { registerSystemTools } from '../../src/tools/systems.js';
import { client } from '../../src/client.js';
import { createTestHarness, subscriptionFixture, lockSensorFixture, confirmTokenOf } from '../helpers.js';
import { parseToolResult } from '@chrischall/mcp-utils/test';

const resolveSpy = vi.spyOn(client, 'resolveSystem');
const requestSpy = vi.spyOn(client, 'request');
const writeSpy = vi.spyOn(client, 'write');

let savedEnv: NodeJS.ProcessEnv;
const open: { close: () => Promise<void> }[] = [];

beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.MCP_CONFIRM_MODE;
  resolveSpy.mockReset().mockResolvedValue({ sid: 1, systemVersion: 3, raw: subscriptionFixture() });
  requestSpy.mockReset().mockResolvedValue({
    sensors: [lockSensorFixture({ serial: 'L1', lockState: 1 })],
    settings: { pins: { master: { pin: '1234' } } },
  } as never);
  writeSpy.mockReset().mockResolvedValue({ ok: true } as never);
});

afterEach(async () => {
  process.env = savedEnv;
  vi.useRealTimers();
  while (open.length) await open.pop()!.close();
});

type Elicitation = NonNullable<Parameters<typeof createTestHarness>[1]>['elicitation'];

async function harnessWith(elicitation?: Elicitation) {
  const harness = await createTestHarness(
    (server) => {
      registerSystemTools(server, client);
      registerAlarmTools(server, client);
      registerLockTools(server, client);
    },
    elicitation ? { elicitation } : undefined,
  );
  open.push(harness);
  return harness;
}

/** Call a tool, advancing fake timers past any post-write verification wait. */
async function callWithTimers(
  harness: Awaited<ReturnType<typeof harnessWith>>,
  name: string,
  args: Record<string, unknown>,
) {
  vi.useFakeTimers();
  try {
    const pending = harness.callTool(name, args);
    await vi.advanceTimersByTimeAsync(30000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

describe('confirm-token flow', () => {
  it('refuses a replayed token with TOKEN_REUSED and does not act again', async () => {
    const harness = await harnessWith();
    const confirmToken = confirmTokenOf(await harness.callTool('simplisafe_get_pins'));

    const first = await harness.callTool('simplisafe_get_pins', { confirmToken });
    expect(first.isError).toBeFalsy();
    expect(requestSpy).toHaveBeenCalledTimes(1);

    const replay = await harness.callTool('simplisafe_get_pins', { confirmToken });
    const parsed = parseToolResult(replay) as Record<string, unknown>;
    expect(replay.isError).toBe(true);
    expect(parsed.error).toBe('TOKEN_REUSED');
    expect(JSON.stringify(replay)).not.toContain('1234');
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a token whose arguments changed with DRAFT_CHANGED and sends nothing', async () => {
    const harness = await harnessWith();
    // Approved: arm HOME. Presented: arm AWAY with the HOME approval.
    const confirmToken = confirmTokenOf(
      await harness.callTool('simplisafe_set_alarm_state', { state: 'home' }),
    );

    const result = await harness.callTool('simplisafe_set_alarm_state', { state: 'away', confirmToken });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(parsed.error).toBe('DRAFT_CHANGED');
    // It hands back the preview of what WOULD happen now, with a fresh token.
    expect((parsed.preview as Record<string, unknown>).requestedState).toBe('AWAY');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('refuses with DRAFT_CHANGED when the lock state moved between the phases', async () => {
    const harness = await harnessWith();
    const confirmToken = confirmTokenOf(
      await harness.callTool('simplisafe_set_lock_state', { serial: 'L1', state: 'unlock' }),
    );

    // Someone unlocked the door by hand after the user approved "unlock (currently locked)".
    requestSpy.mockResolvedValue({ sensors: [lockSensorFixture({ serial: 'L1', lockState: 2 })] } as never);
    const result = await harness.callTool('simplisafe_set_lock_state', {
      serial: 'L1',
      state: 'unlock',
      confirmToken,
    });

    expect((parseToolResult(result) as Record<string, unknown>).error).toBe('DRAFT_CHANGED');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('acts on a client that accepts the confirmation prompt, without any token', async () => {
    const elicitation = vi.fn(async () => ({ action: 'accept' as const, content: { confirmed: true } }));
    const harness = await harnessWith(elicitation);

    const result = await callWithTimers(harness, 'simplisafe_set_lock_state', { serial: 'L1', state: 'unlock' });

    expect(elicitation).toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith('/doorlock/1/L1/state', { state: 'unlock' });
  });

  it('does nothing on a client that declines the confirmation prompt', async () => {
    const elicitation = vi.fn(async () => ({ action: 'decline' as const }));
    const harness = await harnessWith(elicitation);

    await callWithTimers(harness, 'simplisafe_set_alarm_state', { state: 'off' });

    expect(elicitation).toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('refuses outright under MCP_CONFIRM_MODE=refuse on a client that cannot be prompted', async () => {
    process.env.MCP_CONFIRM_MODE = 'refuse';
    const harness = await harnessWith();

    const result = await harness.callTool('simplisafe_set_alarm_state', { state: 'off' });
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.reason).toBe('confirmation-unsupported');
    expect(parsed.confirmToken).toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
