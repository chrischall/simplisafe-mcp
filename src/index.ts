#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { client } from './client.js';
import { VERSION } from './version.js';
import { registerSystemTools } from './tools/systems.js';
import { registerDeviceTools } from './tools/devices.js';
import { registerEventTools } from './tools/events.js';
import { registerAlarmTools } from './tools/alarm.js';
import { registerLockTools } from './tools/locks.js';
import { registerUtilityTools } from './tools/utilities.js';

// runMcp builds the McpServer, applies the registrars (threading `client`
// through as deps), prints the banner to stderr, wires graceful shutdown, and
// connects the stdio transport. The SimpliSafe client is a module-level
// singleton constructed in ./client.js that defers its config error to the
// first request, so the server boots and answers the host's install-time
// tools/list probe even with no refresh token configured.
//
// A hosted per-user deployment injects its own client into
// these same registrars instead of this singleton.
await runMcp({
  name: 'simplisafe-mcp',
  version: VERSION,
  deps: client,
  banner:
    '[simplisafe-mcp] This project was developed and is maintained by AI (Claude Code). ' +
    'It can arm, disarm, and unlock a physical security system — use at your own discretion.',
  tools: [
    registerSystemTools,
    registerDeviceTools,
    registerEventTools,
    registerAlarmTools,
    registerLockTools,
    registerUtilityTools,
  ],
});
