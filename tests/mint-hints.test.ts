import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestHarness, subscriptionFixture } from './helpers.js';
import { client } from '../src/client.js';
import { registerSystemTools } from '../src/tools/systems.js';
import { registerDeviceTools } from '../src/tools/devices.js';
import { registerEventTools } from '../src/tools/events.js';
import { registerAlarmTools } from '../src/tools/alarm.js';
import { registerLockTools } from '../src/tools/locks.js';
import { registerUtilityTools } from '../src/tools/utilities.js';

/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * read off the SERVED tools/list — what a host sees — so a new tool cannot
 * skip the decision.
 */
const REGISTRARS = [
  registerSystemTools,
  registerDeviceTools,
  registerEventTools,
  registerAlarmTools,
  registerLockTools,
  registerUtilityTools,
];

type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, Record<string, unknown>> };
  _meta?: { mint?: Record<string, unknown> };
};

async function served(): Promise<Listed[]> {
  const h = await createTestHarness((server) => {
    for (const register of REGISTRARS) register(server, client);
  });
  try {
    const { tools } = await h.client.listTools();
    return tools as Listed[];
  } finally {
    await h.close();
  }
}

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  simplisafe_list_systems: 'lookup',
  simplisafe_get_system: 'lookup',
  simplisafe_get_settings: 'lookup',
  simplisafe_get_pins: 'lookup',
  simplisafe_list_sensors: 'lookup',
  simplisafe_list_locks: 'lookup',
  simplisafe_get_events: 'whats-new',
  simplisafe_set_alarm_state: 'turn-on-off',
  simplisafe_set_lock_state: 'turn-on-off',
};

describe('_meta.mint on tools/list', () => {
  it('names every served tool except the healthcheck', async () => {
    const names = (await served()).map((t) => t.name).filter((n) => !n.endsWith('_healthcheck'));
    expect(names.sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it('every tool except the healthcheck carries domain home and its intent', async () => {
    for (const t of await served()) {
      if (t.name.endsWith('_healthcheck')) continue;
      const m = t._meta?.mint;
      expect(m, t.name).toBeDefined();
      expect(m!.domain, t.name).toBe('home');
      expect(m!.intent, t.name).toBe(EXPECTED_INTENT[t.name]);
    }
  });

  it('every hint is shaped per the host contract', async () => {
    for (const t of await served()) {
      const m = t._meta?.mint;
      if (!m) continue;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(m).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(m.domain);
      expect(INTENTS, t.name).toContain(m.intent);
      if ('canonical' in m) {
        expect(m.canonical, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(CANONICAL_INTENTS, t.name).toContain(m.intent);
      }
      if ('subject' in m) expect(props, t.name).toHaveProperty(m.subject as string);
      if ('when' in m) {
        const when = m.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start);
        expect(props, t.name).toHaveProperty(when.end);
      }
      if ('aliases' in m) {
        const aliases = m.aliases as string[];
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
        }
      }
    }
  });

  it('marks at most one canonical read per intent: the event log answers whats-new', async () => {
    const canonical = (await served())
      .filter((t) => t._meta?.mint?.canonical === true)
      .map((t) => [t.name, t._meta!.mint!.intent]);
    expect(canonical).toEqual([['simplisafe_get_events', 'whats-new']]);
  });

  it('the canonical read offers view: brief and names no subject or range it cannot honour', async () => {
    const events = (await served()).find((t) => t.name === 'simplisafe_get_events')!;
    expect(events.inputSchema.properties?.view?.enum).toEqual(['full', 'brief']);
    // No subject: see src/tools/hints.ts. No `when`: the log takes a start, never a range.
    expect(events._meta?.mint).toEqual({
      domain: 'home',
      intent: 'whats-new',
      canonical: true,
      aliases: ['alarm', 'security', 'security system', 'activity', 'doors', 'sensors', 'simplisafe'],
    });
  });

  it('the arm/disarm and lock writes carry the words a person says', async () => {
    const tools = await served();
    const aliasesOf = (n: string) => tools.find((t) => t.name === n)?._meta?.mint?.aliases;
    expect(aliasesOf('simplisafe_set_alarm_state')).toEqual(['alarm', 'arm', 'disarm', 'security system', 'away mode', 'home mode']);
    expect(aliasesOf('simplisafe_set_lock_state')).toEqual(['lock', 'unlock', 'door lock', 'deadbolt', 'smart lock']);
  });
});

describe('simplisafe_get_events view: brief', () => {
  const resolveSpy = vi.spyOn(client, 'resolveSystem');
  const requestSpy = vi.spyOn(client, 'request');

  const event = (id: number, info: string, sensorName?: string, eventType = 'activity') => ({
    eventId: id,
    eventTimestamp: 1785238087 - id,
    eventType,
    sensorName,
    info,
  });

  beforeEach(() => {
    resolveSpy.mockReset().mockResolvedValue({ sid: 7858153, systemVersion: 3, raw: subscriptionFixture() });
    requestSpy.mockReset();
  });
  afterEach(() => {
    resolveSpy.mockReset();
    requestSpy.mockReset();
  });

  async function brief(args: Record<string, unknown> = {}) {
    const h = await createTestHarness((server) => registerEventTools(server, client));
    try {
      const result = await h.callTool('simplisafe_get_events', { view: 'brief', ...args });
      const text = (result as { content: { text: string }[] }).content[0]!.text;
      return JSON.parse(text) as { untrusted_content: boolean; note: string; data: string[] };
    } finally {
      await h.close();
    }
  }

  it('answers one line per event inside the untrusted-data envelope', async () => {
    requestSpy.mockResolvedValue({
      events: [event(1, 'Doorlock Unlocked', 'Front Door'), event(2, 'Alarm triggered', undefined, 'alarm')],
    } as never);
    const out = await brief();
    expect(out.untrusted_content).toBe(true);
    expect(out.note).toMatch(/SimpliSafe/);
    expect(out.data).toEqual([
      `Front Door: Doorlock Unlocked — ${new Date((1785238087 - 1) * 1000).toISOString()} — activity`,
      `Alarm triggered — ${new Date((1785238087 - 2) * 1000).toISOString()} — alarm`,
    ]);
  });

  it('keeps every line within 120 characters, shortening the title', async () => {
    requestSpy.mockResolvedValue({ events: [event(1, 'x'.repeat(300), 'Garage')] } as never);
    const [line] = (await brief()).data;
    expect(line!.length).toBeLessThanOrEqual(120);
    expect(line).toMatch(/^Garage: x+… — .+ — activity$/);
  });

  it('says "no date" for an event without a timestamp', async () => {
    requestSpy.mockResolvedValue({ events: [{ eventId: 9, info: 'Sensor error' }] } as never);
    expect((await brief()).data).toEqual(['Sensor error — no date — event']);
  });

  it('answers "-- none" for an empty log', async () => {
    requestSpy.mockResolvedValue({ events: [] } as never);
    expect((await brief()).data).toEqual(['-- none']);
  });

  it('answers "-- none" when the type filter leaves nothing', async () => {
    requestSpy.mockResolvedValue({ events: [event(1, 'Doorlock Unlocked', 'Front Door')] } as never);
    expect((await brief({ event_type: 'alarm' })).data).toEqual(['-- none']);
  });

  it('adds "-- more" when the page came back full, so a partial log is never silent', async () => {
    requestSpy.mockResolvedValue({ events: [event(1, 'a'), event(2, 'b')] } as never);
    const out = await brief({ num_events: 2 });
    expect(out.data).toHaveLength(3);
    expect(out.data[2]).toBe('-- more');
  });

  it('says "-- more", not "-- none", when the filter empties a full page', async () => {
    requestSpy.mockResolvedValue({ events: [event(1, 'a'), event(2, 'b')] } as never);
    expect((await brief({ num_events: 2, event_type: 'alarm' })).data).toEqual(['-- more']);
  });

  it('adds "-- more" on a full default page of 50', async () => {
    requestSpy.mockResolvedValue({ events: Array.from({ length: 50 }, (_, i) => event(i + 1, `e${i}`)) } as never);
    const out = await brief();
    expect(out.data).toHaveLength(51);
    expect(out.data.at(-1)).toBe('-- more');
  });

  it('leaves the full view unchanged', async () => {
    requestSpy.mockResolvedValue({ events: [event(1, 'Doorlock Unlocked', 'Front Door')] } as never);
    const h = await createTestHarness((server) => registerEventTools(server, client));
    try {
      const result = await h.callTool('simplisafe_get_events', {});
      const parsed = JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
      expect(parsed).toMatchObject({ sid: 7858153, count: 1 });
      expect(parsed.events[0]).toMatchObject({ info: 'Doorlock Unlocked', sensorName: 'Front Door' });
    } finally {
      await h.close();
    }
  });
});
