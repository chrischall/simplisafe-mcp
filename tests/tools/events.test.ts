import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { registerEventTools } from '../../src/tools/events.js';
import { client } from '../../src/client.js';
import { createTestHarness, subscriptionFixture } from '../helpers.js';
import { parseToolResult } from '@chrischall/mcp-utils/test';

const resolveSpy = vi.spyOn(client, 'resolveSystem');
const requestSpy = vi.spyOn(client, 'request');

let harness: Awaited<ReturnType<typeof createTestHarness>>;

const EVENTS = [
  {
    eventId: 1,
    eventTimestamp: 1785238087,
    eventType: 'activity',
    sensorType: 16,
    sensorName: 'Mudroom',
    info: 'Doorlock Unlocked',
  },
  {
    eventId: 2,
    eventTimestamp: 1785238000,
    eventType: 'alarm',
    sensorType: 5,
    sensorName: 'Front Door',
    info: 'Alarm triggered',
  },
];

beforeEach(() => {
  resolveSpy.mockReset().mockResolvedValue({
    sid: 7858153,
    systemVersion: 3,
    raw: subscriptionFixture(),
  });
  requestSpy.mockReset().mockResolvedValue({ events: EVENTS } as never);
});
afterAll(async () => {
  if (harness) await harness.close();
});

describe('simplisafe_get_events', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerEventTools(server, client));
    expect((await harness.listTools()).map((t) => t.name)).toContain('simplisafe_get_events');
  });

  it('uses the version-neutral events route, NOT the ss3 prefix', async () => {
    await harness.callTool('simplisafe_get_events');
    // Getting this wrong 404s: events are the one system route without ss3/.
    expect(requestSpy).toHaveBeenCalledWith('GET', '/subscriptions/7858153/events', {
      query: { numEvents: undefined, fromTimestamp: undefined },
    });
  });

  it('passes through paging arguments', async () => {
    await harness.callTool('simplisafe_get_events', { num_events: 10, from_timestamp: 1785238000 });
    expect(requestSpy).toHaveBeenCalledWith('GET', '/subscriptions/7858153/events', {
      query: { numEvents: 10, fromTimestamp: 1785238000 },
    });
  });

  it('rejects num_events above the upstream ceiling of 50 without calling the API', async () => {
    // Verified by bisection against the live API: 50 is accepted, 51+ returns
    // 400 InvalidParameter. Catching it in the schema beats surfacing that 400.
    const result = await harness.callTool('simplisafe_get_events', { num_events: 51 });
    expect(result.isError).toBe(true);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('accepts the maximum of 50', async () => {
    await harness.callTool('simplisafe_get_events', { num_events: 50 });
    expect(requestSpy).toHaveBeenCalledWith('GET', '/subscriptions/7858153/events', {
      query: { numEvents: 50, fromTimestamp: undefined },
    });
  });

  it('filters by event type', async () => {
    const parsed = parseToolResult(
      await harness.callTool('simplisafe_get_events', { event_type: 'alarm' }),
    ) as { count: number; events: { eventId: number }[] };
    expect(parsed.count).toBe(1);
    expect(parsed.events[0]!.eventId).toBe(2);
  });

  it('works on a legacy system too (events are not SS3-gated)', async () => {
    resolveSpy.mockResolvedValue({
      sid: 1,
      systemVersion: 2,
      raw: subscriptionFixture({ version: 2 }),
    });
    const result = await harness.callTool('simplisafe_get_events');
    expect(result.isError).toBeFalsy();
  });

  it('degrades to an empty list when the payload has no events array', async () => {
    requestSpy.mockResolvedValue({} as never);
    const parsed = parseToolResult(await harness.callTool('simplisafe_get_events')) as {
      count: number;
    };
    expect(parsed.count).toBe(0);
  });
});
