import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, messageOf } from '@chrischall/mcp-utils';
import type { SimpliSafeClient } from '../client.js';
import { VERSION } from '../version.js';

export function registerUtilityTools(server: McpServer, client: SimpliSafeClient): void {
  server.registerTool(
    'simplisafe_healthcheck',
    {
      description:
        'Check that the server can authenticate to SimpliSafe and reach the API. Reports whether ' +
        'the refresh token is configured and working, the resolved user id, and how many active ' +
        'systems the account has. Start here when other tools fail.',
      annotations: toolAnnotations({ readOnly: true }),
      inputSchema: {},
    },
    async () => {
      // Never throws: a healthcheck that fails to report is useless. It converts
      // every failure into a described status instead.
      try {
        const userId = await client.getUserId();
        const subs = await client.listSubscriptions();

        return textResult({
          status: 'ok',
          version: VERSION,
          authenticated: true,
          userId,
          activeSystems: subs.length,
          systemIds: subs.map((s) => Number(s.sid)),
        });
      } catch (err) {
        return textResult({
          status: 'error',
          version: VERSION,
          authenticated: false,
          error: messageOf(err),
          hint:
            'If this reports a missing or invalid refresh token, run the one-time browser login: ' +
            '`node scripts/bootstrap-auth.mjs`, then re-run it with the callback URL it prints.',
        });
      }
    },
  );
}

export const UTILITY_TOOL_NAMES = ['simplisafe_healthcheck'] as const;
