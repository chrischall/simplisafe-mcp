import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PositiveInt, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { SimpliSafeClient } from '../client.js';
import { normalizeEvent } from '../normalize.js';

export function registerEventTools(server: McpServer, client: SimpliSafeClient): void {
  server.registerTool(
    'simplisafe_get_events',
    {
      description:
        'Get recent events recorded by the base station — arm/disarm, sensor opens, lock and ' +
        'unlock, alarms, errors — newest first. Each event carries an ISO timestamp alongside ' +
        'the raw epoch seconds.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {
        sid: PositiveInt.optional().describe(
          'System id. Optional when the account has exactly one system; required when it has several.',
        ),
        // 50 is a HARD upstream ceiling, verified by bisection against the live
        // API: 50 succeeds, 51 and above return 400 InvalidParameter. Bounding
        // it here turns a confusing upstream 400 into a clear schema error.
        num_events: PositiveInt.max(50)
          .optional()
          .describe(
            'How many events to return, 1-50 (SimpliSafe rejects more than 50). Defaults to 50.',
          ),
        from_timestamp: PositiveInt.optional().describe(
          'Only events at or after this Unix timestamp (seconds).',
        ),
        event_type: z
          .string()
          .optional()
          .describe('Only return events with this eventType, e.g. "activity" or "alarm".'),
      },
    },
    async ({ sid, num_events, from_timestamp, event_type }) => {
      const system = await client.resolveSystem(sid);

      // Note the route: events live under the version-neutral
      // /subscriptions/{sid}/events, NOT under the ss3/ prefix the other
      // system routes use.
      const res = await client.request<{ events?: Record<string, unknown>[] }>(
        'GET',
        `/subscriptions/${system.sid}/events`,
        {
          query: {
            numEvents: num_events,
            fromTimestamp: from_timestamp,
          },
        },
      );

      let events = (res.events ?? []).map(normalizeEvent);
      if (event_type) {
        const want = event_type.toLowerCase();
        events = events.filter((e) => e.eventType?.toLowerCase() === want);
      }

      return minifiedResult({ sid: system.sid, count: events.length, events });
    },
  );
}

export const EVENT_TOOL_NAMES = ['simplisafe_get_events'] as const;
