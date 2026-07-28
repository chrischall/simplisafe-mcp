import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, PositiveInt } from '@chrischall/mcp-utils';
import type { SimpliSafeClient } from '../client.js';
import { normalizeSensor, deviceTypeName, lockStateName } from '../normalize.js';

const sidArg = {
  sid: PositiveInt.optional().describe(
    'System id. Optional when the account has exactly one system; required when it has several.',
  ),
};

/** Fetch the raw sensor list for a system, guarding the SS3-only route. */
async function fetchSensors(
  client: SimpliSafeClient,
  sid: number | undefined,
  forceUpdate: boolean,
): Promise<{ systemId: number; sensors: Record<string, unknown>[] }> {
  const system = await client.resolveSystem(sid);
  client.assertV3(system, 'Listing devices');

  const res = await client.request<{ sensors?: Record<string, unknown>[] }>(
    'GET',
    `/ss3/subscriptions/${system.sid}/sensors`,
    // `forceUpdate=true` makes the base station re-poll its devices — slower and
    // heavier on the hardware, so it stays opt-in.
    { query: { forceUpdate: String(forceUpdate) } },
  );

  return { systemId: system.sid, sensors: res.sensors ?? [] };
}

export function registerDeviceTools(server: McpServer, client: SimpliSafeClient): void {
  server.registerTool(
    'simplisafe_list_sensors',
    {
      description:
        'List the sensors and devices paired to a system — entry sensors, motion, glass break, ' +
        'smoke/CO, keypads, sirens and locks — with battery, offline and triggered status. ' +
        'Filter by type with `type_name` (e.g. "entry", "motion_v2", "lock").',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {
        ...sidArg,
        type_name: z
          .string()
          .optional()
          .describe('Only return devices of this type name, e.g. "entry", "lock", "smoke".'),
        problems_only: z
          .boolean()
          .optional()
          .describe('Only return devices that are offline, low battery, or triggered.'),
        force_update: z
          .boolean()
          .optional()
          .describe('Ask the base station to re-poll its devices first (slower). Defaults to false.'),
      },
    },
    async ({ sid, type_name, problems_only, force_update }) => {
      const { systemId, sensors } = await fetchSensors(client, sid, force_update === true);
      let normalized = sensors.map(normalizeSensor);

      if (type_name) {
        const want = type_name.toLowerCase();
        normalized = normalized.filter((s) => s.typeName === want);
      }
      if (problems_only === true) {
        normalized = normalized.filter(
          (s) => s.offline === true || s.lowBattery === true || s.triggered === true,
        );
      }

      return textResult({
        sid: systemId,
        count: normalized.length,
        // A quick roster of what types exist, so a follow-up filter needn't guess.
        typesPresent: [...new Set(sensors.map((s) => deviceTypeName(Number(s.type))))].sort(),
        sensors: normalized,
      });
    },
  );

  server.registerTool(
    'simplisafe_list_locks',
    {
      description:
        'List the smart locks on a system with their current state (locked / unlocked / jammed), ' +
        'lock and keypad battery status, and keypad connectivity. Returns the `serial` that ' +
        'simplisafe_set_lock_state takes. Polls the base station fresh by default, because a ' +
        'stale answer to "is my door locked?" is worse than a slow one.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {
        ...sidArg,
        force_update: z
          .boolean()
          .optional()
          .describe(
            'Re-poll the base station before answering. Defaults to TRUE for locks — set false ' +
              'to accept a possibly-stale cached reading in exchange for speed.',
          ),
      },
    },
    async ({ sid, force_update }) => {
      // Locks default to a FRESH poll, unlike the general sensor list. The
      // cached payload can lag by minutes and has been observed reporting a
      // jammed lock as cleanly unlocked — a dangerously wrong answer to the one
      // question this tool exists to answer.
      const fresh = force_update !== false;
      const { systemId, sensors } = await fetchSensors(client, sid, fresh);

      const locks = sensors
        .filter((s) => Number(s.type) === 16)
        .map((s) => {
          const status = (s.status ?? {}) as Record<string, unknown>;
          const flags = (s.flags ?? {}) as Record<string, unknown>;
          return {
            serial: String(s.serial ?? ''),
            name: (s.name as string) || '(unnamed)',
            state: lockStateName(status),
            lockLowBattery: status.lockLowBattery as boolean | undefined,
            pinPadLowBattery: status.pinPadLowBattery as boolean | undefined,
            pinPadOffline: status.pinPadOffline as boolean | undefined,
            lockDisabled: status.lockDisabled as boolean | undefined,
            offline: flags.offline as boolean | undefined,
            autoLock: (s.setting as Record<string, unknown> | undefined)?.autoLock,
          };
        });

      return textResult({
        sid: systemId,
        count: locks.length,
        // State the freshness explicitly: a cached reading is materially less
        // trustworthy here, and the caller should know which they got.
        dataFreshness: fresh ? 'fresh poll' : 'cached (may be stale)',
        locks,
      });
    },
  );
}

export const DEVICE_TOOL_NAMES = ['simplisafe_list_sensors', 'simplisafe_list_locks'] as const;
