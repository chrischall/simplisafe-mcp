import { createConnector } from '@chrischall/mcp-connector';
import { SimpliSafeClient } from './client.js';
import { simplisafeAuth, type SimpliSafeProps } from './simplisafe-auth.js';
import { VERSION } from './version.js';
import { registerSystemTools } from './tools/systems.js';
import { registerDeviceTools } from './tools/devices.js';
import { registerEventTools } from './tools/events.js';
import { registerAlarmTools } from './tools/alarm.js';
import { registerLockTools } from './tools/locks.js';
import { registerUtilityTools } from './tools/utilities.js';

// The Cloudflare remote-connector entrypoint: wires the SAME transport-neutral
// registrars the stdio server uses (src/index.ts) into @chrischall/mcp-connector's
// generic OAuth + McpAgent harness, so the server is reachable from claude.ai on
// the web, desktop and phone.
//
// This archetype is connector-safe: auth is a long-lived, NON-ROTATING OAuth
// refresh token (verified live — the refresh response returns no new token), so
// there is no browser bridge, no signed-in tab, and no writable per-user token
// storage required. `buildClient` mints a per-user client from that token, so
// concurrent sessions never share a credential.
//
// SimpliSafe is STATELESS here — no local cache — so the Worker declares only
// the per-session MCP agent Durable Object (no cache DO).
//
// Full tool surface, including the two physical-control writes. They keep their
// per-call `confirm: true` dry-run gate (tools/_confirm.ts); there is no
// structural write-mode gate, and no path that bypasses the confirm.
const { Agent, handler } = createConnector<SimpliSafeProps, SimpliSafeClient>({
  name: 'simplisafe-mcp',
  version: VERSION,
  auth: simplisafeAuth,
  buildClient: (props) => new SimpliSafeClient({ refreshToken: props.refreshToken }),
  // Keep the SAME order as src/index.ts.
  tools: [
    registerSystemTools,
    registerDeviceTools,
    registerEventTools,
    registerAlarmTools,
    registerLockTools,
    registerUtilityTools,
  ],
});

// Resolves wrangler.jsonc's MCP_OBJECT binding -> SimpliSafeMcpAgent.
export { Agent as SimpliSafeMcpAgent };

export default handler;
