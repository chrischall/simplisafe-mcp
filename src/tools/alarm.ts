import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, PositiveInt } from '@chrischall/mcp-utils';
import type { SimpliSafeClient } from '../client.js';
import { normalizeSystem } from '../normalize.js';
import { previewUnlessConfirmed, schemaConfirm } from './_confirm.js';

/** The three states the SS3 API accepts as a path segment. */
const ALARM_STATES = ['off', 'home', 'away'] as const;
type AlarmState = (typeof ALARM_STATES)[number];

/**
 * Smart locks carry per-lock `home` / `away` flags that AUTO-LOCK every door
 * when the system is armed, and `homeToOff` / `awayToOff` flags controlling
 * whether disarming unlocks them again. On a real system these were observed as
 * `home: 1, away: 1, homeToOff: 0` — so arming locked all three doors and
 * disarming did NOT reverse it.
 *
 * That makes arming a door-locking operation as well as an alarm operation, and
 * it is not symmetric: you cannot assume disarming restores the previous lock
 * state. Callers deserve to hear that before they confirm.
 */
const AUTO_LOCK_NOTE =
  'Note: if your locks have auto-lock enabled for this mode, this will also LOCK your doors — ' +
  'and disarming afterwards does not necessarily unlock them again. Check simplisafe_list_locks.';

const STATE_EFFECT: Record<AlarmState, string> = {
  off: 'DISARMS the system, leaving the house unmonitored. Does NOT necessarily unlock doors that were auto-locked when it was armed.',
  home:
    'Arms perimeter sensors only (interior motion stays inactive). May start an exit delay ' +
    'and can trigger the siren and a monitoring-center dispatch if a sensor opens. ' +
    AUTO_LOCK_NOTE,
  away:
    'Arms ALL sensors including interior motion. Starts an exit delay; anyone still moving ' +
    'inside when it expires can trigger the siren and a monitoring-center dispatch. ' +
    AUTO_LOCK_NOTE,
};

/**
 * How long to wait before re-reading state. The base station applies the change
 * asynchronously, so an immediate re-read can still report the old value.
 */
const VERIFY_DELAY_MS = 2500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compare the requested state against what the system actually reports afterward.
 *
 * Deliberately compares ONE field, `alarmState`. A broader before/after diff
 * would sweep in `alarmStateTimestamp` / `stateUpdated`, which advance on their
 * own and would make every call look successful no matter what happened.
 *
 * Arming is not instantaneous: SimpliSafe reports `HOME_COUNT` / `AWAY_COUNT`
 * while the exit delay runs, settling to `HOME` / `AWAY` when it expires. That
 * is a real success, so it is reported as `in_progress`, not as a failure.
 */
export function classifyStateChange(
  requested: AlarmState,
  before: string | undefined,
  after: string | undefined,
): { verdict: 'confirmed' | 'in_progress' | 'unconfirmed'; detail: string } {
  const expected = requested.toUpperCase();
  const actual = (after ?? '').toUpperCase();

  if (actual === expected) {
    return { verdict: 'confirmed', detail: `System reports ${actual}.` };
  }
  if (actual === `${expected}_COUNT`) {
    return {
      verdict: 'in_progress',
      detail: `System reports ${actual} — the exit delay is counting down and will settle at ${expected}.`,
    };
  }
  return {
    verdict: 'unconfirmed',
    detail:
      `Expected ${expected} but the system reports ${actual || '(unknown)'} ` +
      `(it was ${(before ?? '(unknown)').toUpperCase()} before). The command may still be ` +
      `settling, or it may not have been applied — re-read with simplisafe_get_system.`,
  };
}

export function registerAlarmTools(server: McpServer, client: SimpliSafeClient): void {
  server.registerTool(
    'simplisafe_set_alarm_state',
    {
      description:
        'Arm or disarm the alarm system: "off" (disarm), "home" (perimeter only) or "away" ' +
        '(all sensors). CONFIRM-GATED — without confirm: true nothing is sent and you get a ' +
        'dry-run preview. This physically changes a security system: disarming leaves the house ' +
        'unmonitored, and arming can trigger a siren and a monitoring-center dispatch. ' +
        'After executing, the new state is verified by re-reading the system.',
      annotations: toolAnnotations({ readOnly: false, idempotent: true, openWorld: true }),
      inputSchema: {
        state: z.enum(ALARM_STATES).describe('Target state: off (disarm), home, or away.'),
        sid: PositiveInt.optional().describe(
          'System id. Optional when the account has exactly one system; required when it has several.',
        ),
        confirm: schemaConfirm,
      },
    },
    async ({ state, sid, confirm }) => {
      const system = await client.resolveSystem(sid);
      client.assertV3(system, 'Changing the alarm state');

      const before = normalizeSystem(system.raw);
      const path = `/ss3/subscriptions/${system.sid}/state/${state}`;

      const preview = previewUnlessConfirmed(confirm, `set alarm state to ${state}`, 'POST', path, {
        sid: system.sid,
        locationName: before.locationName,
        currentState: before.alarmState,
        requestedState: state.toUpperCase(),
        warning: STATE_EFFECT[state],
      });
      if (preview) return preview;

      const response = await client.write<Record<string, unknown>>(path);

      // A 2xx is not proof the state changed — re-read and compare the one field
      // that actually settles the question.
      await sleep(VERIFY_DELAY_MS);
      const refreshed = await client.resolveSystem(system.sid);
      const after = normalizeSystem(refreshed.raw);
      const { verdict, detail } = classifyStateChange(state, before.alarmState, after.alarmState);

      return textResult({
        sid: system.sid,
        requestedState: state.toUpperCase(),
        previousState: before.alarmState,
        currentState: after.alarmState,
        exitDelayRemaining: after.exitDelayRemaining,
        isAlarming: after.isAlarming,
        verification: verdict,
        detail,
        response,
      });
    },
  );
}

export const ALARM_TOOL_NAMES = ['simplisafe_set_alarm_state'] as const;
