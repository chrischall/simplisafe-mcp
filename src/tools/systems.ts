import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PositiveInt, minifiedResult, toolAnnotations } from '@chrischall/mcp-utils';
import type { SimpliSafeClient } from '../client.js';
import { normalizeSystem } from '../normalize.js';
import { previewUnlessConfirmed, schemaConfirm } from './_confirm.js';

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
      inputSchema: {},
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
      inputSchema: { ...sidArg },
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
      inputSchema: { ...sidArg },
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
        'Read the system\'s user PINs (master, duress and named users). CONFIRM-GATED: these are ' +
        'the live alarm codes and are returned in cleartext, so calling this puts them into the ' +
        'conversation. Without confirm: true it returns a warning and fetches nothing.',
      // Not a mutation, but destructive-ish in the disclosure sense: the gate is
      // what keeps a casual "show me my settings" from spilling alarm codes.
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {
        ...sidArg,
        confirm: schemaConfirm,
      },
    },
    async ({ sid, confirm }) => {
      const system = await client.resolveSystem(sid);
      client.assertV3(system, 'Reading PINs');

      const path = `/ss3/subscriptions/${system.sid}/settings/normal`;
      const preview = previewUnlessConfirmed(confirm, 'read alarm PINs', 'GET', path, {
        sid: system.sid,
        warning:
          'This returns your SimpliSafe alarm PINs IN CLEARTEXT — the master PIN, the duress ' +
          'PIN and every named user PIN. They will appear in this conversation and in any ' +
          'transcript or log that retains it. Only confirm if you want the codes themselves.',
      });
      if (preview) return preview;

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
