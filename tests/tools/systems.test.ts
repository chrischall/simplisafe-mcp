import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { registerSystemTools } from '../../src/tools/systems.js';
import { client } from '../../src/client.js';
import { createTestHarness, subscriptionFixture } from '../helpers.js';
import { parseToolResult } from '@chrischall/mcp-utils/test';

const listSpy = vi.spyOn(client, 'listSubscriptions');
const resolveSpy = vi.spyOn(client, 'resolveSystem');
const requestSpy = vi.spyOn(client, 'request');

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => {
  listSpy.mockReset();
  resolveSpy.mockReset();
  requestSpy.mockReset();
});
afterAll(async () => {
  if (harness) await harness.close();
});

describe('system tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerSystemTools(server, client));
    const names = (await harness.listTools()).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'simplisafe_list_systems',
        'simplisafe_get_system',
        'simplisafe_get_settings',
        'simplisafe_get_pins',
      ]),
    );
  });

  it('simplisafe_list_systems projects the nested state', async () => {
    listSpy.mockResolvedValue([subscriptionFixture({ sid: 42, alarmState: 'HOME' })]);
    const parsed = parseToolResult(
      await harness.callTool('simplisafe_list_systems'),
    ) as { count: number; systems: Record<string, unknown>[] };

    expect(parsed.count).toBe(1);
    expect(parsed.systems[0]).toMatchObject({ sid: 42, alarmState: 'HOME', systemVersion: 3 });
  });

  it('simplisafe_get_system includes base-station messages', async () => {
    const raw = subscriptionFixture();
    (raw.location as Record<string, Record<string, unknown>>).system.messages = [
      { id: 'm1', text: 'Base Station firmware was updated successfully.' },
    ];
    resolveSpy.mockResolvedValue({ sid: 7858153, systemVersion: 3, raw });

    const parsed = parseToolResult(
      await harness.callTool('simplisafe_get_system'),
    ) as { messages: unknown[] };
    expect(parsed.messages).toHaveLength(1);
  });

  it('simplisafe_get_settings returns settings.normal and never the pins block', async () => {
    resolveSpy.mockResolvedValue({ sid: 1, systemVersion: 3, raw: subscriptionFixture() });
    requestSpy.mockResolvedValue({
      settings: {
        normal: { alarmVolume: 3, entryDelayAway: 30 },
        // The upstream response carries PINs in the same payload; the projection
        // must not pass them through this tool.
        pins: { master: { pin: '1234' }, duress: { pin: '9999' } },
      },
      basestationStatus: { wifiRssi: -50 },
      lastUpdated: '2026-02-05T20:00:30.967Z',
    } as never);

    const result = await harness.callTool('simplisafe_get_settings');
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.settings).toMatchObject({ alarmVolume: 3 });
    expect(parsed.basestationStatus).toMatchObject({ wifiRssi: -50 });
    // Assert on the SERIALIZED result: a nested leak would slip past a shallow
    // property check.
    expect(JSON.stringify(result)).not.toContain('1234');
    expect(JSON.stringify(result)).not.toContain('9999');
  });
});

describe('simplisafe_get_pins', () => {
  it('fetches NOTHING without confirm: true', async () => {
    resolveSpy.mockResolvedValue({ sid: 1, systemVersion: 3, raw: subscriptionFixture() });

    const result = await harness.callTool('simplisafe_get_pins');
    const parsed = parseToolResult(result) as Record<string, unknown>;

    expect(parsed.dryRun).toBe(true);
    expect(String(parsed.warning)).toMatch(/CLEARTEXT/i);
    // No request means no codes were pulled into the transcript.
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('returns the pins once explicitly confirmed', async () => {
    resolveSpy.mockResolvedValue({ sid: 1, systemVersion: 3, raw: subscriptionFixture() });
    requestSpy.mockResolvedValue({
      settings: { pins: { master: { pin: '1234' }, users: [{ name: 'Kid', pin: '5678' }] } },
    } as never);

    const parsed = parseToolResult(
      await harness.callTool('simplisafe_get_pins', { confirm: true }),
    ) as Record<string, unknown>;

    expect(parsed.pins).toMatchObject({ master: { pin: '1234' } });
    expect(String(parsed.warning)).toMatch(/cleartext/i);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });
});
