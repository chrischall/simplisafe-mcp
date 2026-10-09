import { describe, it, expect } from 'vitest';
import { createTestHarness } from './helpers.js';
import { client } from '../src/client.js';
import { registerSystemTools } from '../src/tools/systems.js';
import { registerDeviceTools } from '../src/tools/devices.js';
import { registerEventTools } from '../src/tools/events.js';
import { registerAlarmTools } from '../src/tools/alarm.js';
import { registerLockTools } from '../src/tools/locks.js';
import { registerUtilityTools } from '../src/tools/utilities.js';

/**
 * Fleet annotation meta-test, read off the SERVED tools/list rather than a
 * hand-kept list. `destructiveHint` defaults to TRUE whenever readOnlyHint is
 * false, and `openWorldHint` defaults to true, so a forgotten hint and a
 * considered one are indistinguishable on the wire — these checks make every
 * tool choose.
 */
async function servedAnnotations(): Promise<Record<string, Ann | undefined>> {
  const harness = await createTestHarness((server) => {
    for (const register of [
      registerSystemTools,
      registerDeviceTools,
      registerEventTools,
      registerAlarmTools,
      registerLockTools,
      registerUtilityTools,
    ]) {
      register(server, client);
    }
  });
  try {
    const { tools } = await harness.client.listTools();
    return Object.fromEntries(tools.map((t) => [t.name, t.annotations as Ann | undefined]));
  } finally {
    await harness.close();
  }
}

interface Ann {
  readOnlyHint?: unknown;
  destructiveHint?: unknown;
  openWorldHint?: unknown;
}

describe('tool annotations', () => {
  it('covers the full surface (guards against a registrar being dropped here)', async () => {
    expect(Object.keys(await servedAnnotations())).toHaveLength(10);
  });

  it('sets an explicit boolean readOnlyHint on every tool', async () => {
    const missing = Object.entries(await servedAnnotations())
      .filter(([, a]) => typeof a?.readOnlyHint !== 'boolean')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', async () => {
    const undeclared = Object.entries(await servedAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', async () => {
    const contradictory = Object.entries(await servedAnnotations())
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([name]) => name);
    expect(contradictory).toEqual([]);
  });

  it('marks every tool open-world (each one calls the SimpliSafe API)', async () => {
    const notOpen = Object.entries(await servedAnnotations())
      .filter(([, a]) => a?.openWorldHint !== true)
      .map(([name]) => name);
    expect(notOpen).toEqual([]);
  });

  it('pins the destructive set', async () => {
    // set_alarm_state can disarm and set_lock_state can unlock — both reduce
    // security. get_pins spills live alarm codes into the conversation, which
    // no tool here can take back.
    const destructive = Object.entries(await servedAnnotations())
      .filter(([, a]) => a?.readOnlyHint === false && a?.destructiveHint === true)
      .map(([name]) => name)
      .sort();
    expect(destructive).toEqual([
      'simplisafe_get_pins',
      'simplisafe_set_alarm_state',
      'simplisafe_set_lock_state',
    ]);
  });
});
