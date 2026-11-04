import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  PositiveInt,
  UNTRUSTED_CONTENT_RULE,
  minifiedResult,
  toolAnnotations,
  untrustedEnvelope,
} from '@chrischall/mcp-utils';
import type { SimpliSafeClient } from '../client.js';
import { normalizeEvent, type NormalizedEvent } from '../normalize.js';
import { EVENTS_META } from './hints.js';

/** The upstream page size when `num_events` is not given (and its ceiling). */
const DEFAULT_NUM_EVENTS = 50;
const BRIEF_MAX = 120;

/** Who wrote the text a brief line carries, for the untrusted-data envelope's note. */
const WHO_WROTE =
  'Event descriptions are written by SimpliSafe and sensor names by whoever set up the system.';

/** The shortest a title is cut to before the event type gives way too. */
const TITLE_FLOOR = 24;

const cut = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, Math.max(n - 1, 0))}…` : s;

/**
 * One `view: "brief"` line: `title — <ISO time | no date> — <event type>`, cut
 * to at most 120 characters as a WHOLE, title first: the title shortens until
 * the line fits, and if the event type alone would still overflow once the
 * title is at its floor, the event type is cut as well. The title is the
 * sensor name and the event text (`Front Door: Doorlock Unlocked`), whichever
 * exist. A title starting with `-- ` or `\` is escaped with one leading `\`,
 * so a sensor name can never read as a note (the gateway strips one).
 */
export function briefLine(e: NormalizedEvent): string {
  const text = e.info ?? e.messageSubject ?? e.sensorTypeName ?? '(event)';
  const raw = e.sensorName ? `${e.sensorName}: ${text}` : text;
  const title = raw.startsWith('-- ') || raw.startsWith('\\') ? `\\${raw}` : raw;
  const status = e.eventType || 'event';
  const sep = ` — ${e.isoTime || 'no date'} — `;
  const room = BRIEF_MAX - sep.length;
  if (title.length + status.length <= room) return `${title}${sep}${status}`;
  const titleRoom = Math.max(room - status.length, Math.min(title.length, TITLE_FLOOR));
  const shown = cut(title, titleRoom);
  return `${shown}${sep}${cut(status, room - shown.length)}`;
}

export function registerEventTools(server: McpServer, client: SimpliSafeClient): void {
  server.registerTool(
    'simplisafe_get_events',
    {
      description:
        'Get recent events recorded by the base station — arm/disarm, sensor opens, lock and ' +
        'unlock, alarms, errors — newest first. Each event carries an ISO timestamp alongside ' +
        'the raw epoch seconds.',
      _meta: EVENTS_META,
      annotations: toolAnnotations({ readOnly: true, openWorld: true }),
      inputSchema: z.object({
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
        view: z
          .enum(['full', 'brief'])
          .optional()
          .describe(
            '"full" (default) returns the events as records; "brief" returns one line per event — ' +
              '"<sensor>: <event> — <ISO time> — <event type>" — as the untrusted-data envelope\'s ' +
              '`data`, with "-- none" for no events and "-- more" when the page came back full.',
          ),
      }),
    },
    async ({ sid, num_events, from_timestamp, event_type, view }) => {
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

      const raw = res.events ?? [];
      let events = raw.map(normalizeEvent);
      if (event_type) {
        const want = event_type.toLowerCase();
        events = events.filter((e) => e.eventType?.toLowerCase() === want);
      }

      if (view === 'brief') {
        const lines = events.map(briefLine);
        // A full page means older events may exist past it; SimpliSafe reports
        // no total, so the note says "more" rather than "N of M". "-- none" is
        // said only when nothing lies past the page either.
        const more = raw.length >= (num_events ?? DEFAULT_NUM_EVENTS);
        if (more) lines.push('-- more');
        else if (lines.length === 0) lines.push('-- none');
        const payload = untrustedEnvelope(lines, { note: `${WHO_WROTE} ${UNTRUSTED_CONTENT_RULE}` });
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
      }

      return minifiedResult({ sid: system.sid, count: events.length, events });
    },
  );
}

export const EVENT_TOOL_NAMES = ['simplisafe_get_events'] as const;
