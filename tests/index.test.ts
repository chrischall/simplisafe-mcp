import { describe, it, expect } from 'vitest';
import { createTestHarness } from './helpers.js';
import { client } from '../src/client.js';
import { registerSystemTools } from '../src/tools/systems.js';
import { registerDeviceTools } from '../src/tools/devices.js';
import { registerEventTools } from '../src/tools/events.js';
import { registerAlarmTools } from '../src/tools/alarm.js';
import { registerLockTools } from '../src/tools/locks.js';
import { registerUtilityTools } from '../src/tools/utilities.js';

/** Must stay in the same order as src/index.ts. */
const REGISTRARS = [
  registerSystemTools,
  registerDeviceTools,
  registerEventTools,
  registerAlarmTools,
  registerLockTools,
  registerUtilityTools,
];

const EXPECTED_TOOLS = [
  'simplisafe_get_events',
  'simplisafe_get_pins',
  'simplisafe_get_settings',
  'simplisafe_get_system',
  'simplisafe_healthcheck',
  'simplisafe_list_locks',
  'simplisafe_list_sensors',
  'simplisafe_list_systems',
  'simplisafe_set_alarm_state',
  'simplisafe_set_lock_state',
];

describe('tool roster', () => {
  it('registers exactly the expected tools', async () => {
    const harness = await createTestHarness((server) => {
      for (const register of REGISTRARS) register(server, client);
    });
    try {
      const names = (await harness.listTools()).map((t) => t.name).sort();
      expect(names).toEqual(EXPECTED_TOOLS);
    } finally {
      await harness.close();
    }
  });

  it('marks the physical-control tools and the cleartext-PIN read as non-read-only', async () => {
    const harness = await createTestHarness((server) => {
      for (const register of REGISTRARS) register(server, client);
    });
    try {
      // The harness's own listTools() projects to names, so go through the raw
      // MCP client to see annotations and schemas.
      const { tools } = await harness.client.listTools();
      const writers = tools
        .filter((t) => t.annotations?.readOnlyHint === false)
        .map((t) => t.name)
        .sort();
      // get_pins mutates nothing, but hosts auto-approve read-only tools, and a
      // model-held confirmToken alone must not be what releases the duress PIN.
      expect(writers).toEqual([
        'simplisafe_get_pins',
        'simplisafe_set_alarm_state',
        'simplisafe_set_lock_state',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('gates every tool that writes or discloses secrets behind a confirmation', async () => {
    const harness = await createTestHarness((server) => {
      for (const register of REGISTRARS) register(server, client);
    });
    try {
      const { tools } = await harness.client.listTools();
      const gated = tools
        .filter((t) => 'confirmToken' in ((t.inputSchema?.properties ?? {}) as object))
        .map((t) => t.name)
        .sort();
      // The two physical-control tools plus the cleartext-PIN read — and none of
      // them still takes the retired `confirm` flag.
      const legacy = tools.filter((t) => 'confirm' in ((t.inputSchema?.properties ?? {}) as object));
      expect(legacy).toEqual([]);
      expect(gated).toEqual([
        'simplisafe_get_pins',
        'simplisafe_set_alarm_state',
        'simplisafe_set_lock_state',
      ]);
    } finally {
      await harness.close();
    }
  });
});
