import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { PositiveInt, confirmTokenParam, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { SimpliSafeClient } from '../client.js';
import { normalizeSystem } from '../normalize.js';
import { confirmGate } from './_confirm.js';

const sidArg = {
  sid: PositiveInt.optional().describe(
    'System id. Optional when the account has exactly one system; required when it has several.',
  ),
};

export function registerSystemTools(server: McpServer, client: SimpliSafeClient): void {
  server.registerTool(
    'simplisafe_list_systems',
    {
      description:
        'List the SimpliSafe systems on this account with their current alarm state (off/home/away), ' +
        'alarming status, connectivity and power status. Start here to get the `sid` other tools take.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({}),
    },
    async () => {
      const subs = await client.listSubscriptions();
      const systems = subs.map(normalizeSystem);
      return minifiedResult({ count: systems.length, systems });
    },
  );

  server.registerTool(
    'simplisafe_get_system',
    {
      description:
        'Get the current state of one SimpliSafe system: alarm state, whether it is alarming, ' +
        'base-station connectivity, power/battery status and any pending base-station messages.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({ ...sidArg }),
    },
    async ({ sid }) => {
      const system = await client.resolveSystem(sid);
      const location = (system.raw.location ?? {}) as Record<string, unknown>;
      const raw = (location.system ?? {}) as Record<string, unknown>;

      return minifiedResult({
        ...normalizeSystem(system.raw),
        messages: (raw.messages as unknown[]) ?? [],
      });
    },
  );

  server.registerTool(
    'simplisafe_get_settings',
    {
      description:
        'Get base-station settings for a system: entry/exit delays, alarm volume and duration, ' +
        'door chime, voice prompts, plus base-station health (wifi/cellular signal, wall power, ' +
        'backup battery, RF jamming). Does not include PINs — use simplisafe_get_pins for those.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: z.object({ ...sidArg }),
    },
    async ({ sid }) => {
      const system = await client.resolveSystem(sid);
      client.assertV3(system, 'Reading base-station settings');

      const res = await client.request<{
        settings?: { normal?: Record<string, unknown> };
        basestationStatus?: Record<string, unknown>;
        lastUpdated?: string;
      }>('GET', `/ss3/subscriptions/${system.sid}/settings/normal`, {
        query: { forceUpdate: 'false' },
      });

      // Deliberately projects `settings.normal` only. The sibling `settings.pins`
      // block holds cleartext alarm codes and is reachable solely through the
      // confirm-gated simplisafe_get_pins tool.
      return minifiedResult({
        sid: system.sid,
        lastUpdated: res.lastUpdated,
        settings: res.settings?.normal ?? {},
        basestationStatus: res.basestationStatus ?? {},
      });
    },
  );

  server.registerTool(
    'simplisafe_get_pins',
    {
      description:
        'Read the system\'s user PINs (master, duress and named users). These are the live alarm ' +
        'codes and are returned in cleartext, so calling this puts them into the conversation. ' +
        'Asks the user to confirm first: a confirmation prompt where the client supports one; ' +
        'otherwise the first call returns a warning preview and a confirmToken and fetches nothing, ' +
        'and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE).',
      // Not a mutation, but annotated as one on purpose. On a client that
      // cannot show a confirmation prompt the confirmToken passes through the
      // model, so on its own it cannot stop a misread or prompt-injected call
      // (sensor names and base-station messages are echoed back to the model)
      // from spilling the duress PIN. Hosts commonly auto-approve
      // read-only tools; readOnly: false + destructive: true makes them ask a
      // human first, as they do for arm/disarm and unlock.
      annotations: toolAnnotations({ readOnly: false, idempotent: true, openWorld: true, destructive: true }),
      inputSchema: z.object({
        ...sidArg,
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ sid, confirmToken }, ctx) => {
      const system = await client.resolveSystem(sid);
      client.assertV3(system, 'Reading PINs');

      const path = `/ss3/subscriptions/${system.sid}/settings/normal`;
      const gate = await confirmGate(ctx, {
        tool: 'simplisafe_get_pins',
        action: 'pins.read',
        message: 'Review and confirm revealing your alarm PINs:',
        summary: 'read alarm PINs',
        method: 'GET',
        path,
        target: String(system.sid),
        context: { sid: system.sid },
        confirmToken,
        warning:
          'This returns your SimpliSafe alarm PINs IN CLEARTEXT — the master PIN, the duress ' +
          'PIN and every named user PIN. They will appear in this conversation and in any ' +
          'transcript or log that retains it. Only confirm if you want the codes themselves.',
      });
      if (gate) return gate;

      const res = await client.request<{
        settings?: { pins?: Record<string, unknown> };
      }>('GET', path, { query: { forceUpdate: 'false' } });

      return minifiedResult({
        sid: system.sid,
        warning: 'Cleartext alarm PINs follow.',
        pins: res.settings?.pins ?? {},
      });
    },
  );
}

// Re-exported for the index tool-count test.
export const SYSTEM_TOOL_NAMES = [
  'simplisafe_list_systems',
  'simplisafe_get_system',
  'simplisafe_get_settings',
  'simplisafe_get_pins',
] as const;
