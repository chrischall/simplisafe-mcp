import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult, toolAnnotations, PositiveInt, McpToolError } from '@chrischall/mcp-utils';
import type { SimpliSafeClient } from '../client.js';
import { lockStateName } from '../normalize.js';
import { previewUnlessConfirmed, schemaConfirm } from './_confirm.js';

const LOCK_STATES = ['lock', 'unlock'] as const;
type LockAction = (typeof LOCK_STATES)[number];

/** Expected steady state after each action, in the vocabulary of `lockStateName`. */
const EXPECTED_AFTER: Record<LockAction, string> = { lock: 'locked', unlock: 'unlocked' };

/**
 * Verification polling. A deadbolt takes seconds to travel and report, and a
 * single fixed delay gets it wrong in both directions: too short reports a
 * successful unlock as `unconfirmed` (observed live at 3s — the lock had in
 * fact opened), too long makes every call sluggish. So poll instead, and stop
 * as soon as the answer is known.
 */
const VERIFY_POLL_INTERVAL_MS = 2500;
const VERIFY_MAX_ATTEMPTS = 6; // ~15s worst case
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch one lock's raw record by serial, or throw with the available serials.
 *
 * `forceUpdate` is NOT optional here by accident. The cached sensor payload can
 * lag reality by minutes: during live testing a cached read reported a lock as
 * cleanly `unlocked` while a fresh poll of the same lock reported
 * `lockJamState: 1`. Verifying a write against that cache is not verification at
 * all — it produced a confident "restored to baseline" for a lock that had in
 * fact jammed. Both the before-read and the after-read therefore force a fresh
 * poll.
 */
async function findLock(
  client: SimpliSafeClient,
  sid: number,
  serial: string,
  forceUpdate: boolean,
): Promise<Record<string, unknown>> {
  const res = await client.request<{ sensors?: Record<string, unknown>[] }>(
    'GET',
    `/ss3/subscriptions/${sid}/sensors`,
    { query: { forceUpdate: String(forceUpdate) } },
  );
  const locks = (res.sensors ?? []).filter((s) => Number(s.type) === 16);
  const match = locks.find((l) => String(l.serial) === serial);

  if (!match) {
    const names = locks.map((l) => `${l.name} (${l.serial})`).join(', ') || 'none';
    throw new McpToolError(`No lock with serial "${serial}" on system ${sid}. Locks: ${names}.`, {
      hint: 'Call simplisafe_list_locks for current serials.',
    });
  }
  return match;
}

export function registerLockTools(server: McpServer, client: SimpliSafeClient): void {
  server.registerTool(
    'simplisafe_set_lock_state',
    {
      description:
        'Lock or unlock a SimpliSafe smart lock. CONFIRM-GATED — without confirm: true nothing ' +
        'is sent and you get a dry-run preview. Unlocking physically opens a door lock, so it is ' +
        'gated even though it is technically reversible. After executing, the result is verified ' +
        'by re-reading the lock state.',
      annotations: toolAnnotations({ readOnly: false, idempotent: true, openWorld: true }),
      inputSchema: {
        serial: z
          .string()
          .min(1)
          .describe('Lock serial, from simplisafe_list_locks.'),
        state: z.enum(LOCK_STATES).describe('Target: lock or unlock.'),
        sid: PositiveInt.optional().describe(
          'System id. Optional when the account has exactly one system; required when it has several.',
        ),
        confirm: schemaConfirm,
      },
    },
    async ({ serial, state, sid, confirm }) => {
      const system = await client.resolveSystem(sid);
      client.assertV3(system, 'Controlling locks');

      const lock = await findLock(client, system.sid, serial, true);
      const before = lockStateName((lock.status ?? {}) as Record<string, unknown>);
      const name = (lock.name as string) || '(unnamed)';

      // Note the route shape: doorlock control is NOT under the ss3/ prefix and
      // takes the serial as a path segment plus the action in the body.
      const path = `/doorlock/${system.sid}/${serial}/state`;
      const body = { state };

      const preview = previewUnlessConfirmed(confirm, `${state} the "${name}" lock`, 'POST', path, {
        body,
        sid: system.sid,
        lockName: name,
        currentState: before,
        warning:
          state === 'unlock'
            ? `This physically UNLOCKS the "${name}" door, allowing entry.`
            : `This physically LOCKS the "${name}" door.`,
      });
      if (preview) return preview;

      const response = await client.write<Record<string, unknown>>(path, body);

      // Re-read rather than trusting the 2xx, polling until the bolt settles.
      const expected = EXPECTED_AFTER[state];
      let afterState = before;
      let waitedMs = 0;

      for (let attempt = 0; attempt < VERIFY_MAX_ATTEMPTS; attempt += 1) {
        await sleep(VERIFY_POLL_INTERVAL_MS);
        waitedMs += VERIFY_POLL_INTERVAL_MS;
        const after = await findLock(client, system.sid, serial, true);
        afterState = lockStateName((after.status ?? {}) as Record<string, unknown>);
        // Both outcomes are terminal — stop rather than burning the full budget.
        if (afterState === expected || afterState === 'jammed') break;
      }

      let verification: 'confirmed' | 'jammed' | 'unconfirmed';
      let detail: string;
      if (afterState === expected) {
        verification = 'confirmed';
        detail = `Lock reports ${afterState} after ${(waitedMs / 1000).toFixed(1)}s.`;
      } else if (afterState === 'jammed') {
        verification = 'jammed';
        detail =
          'The lock reports JAMMED — it did not complete travel and needs physical attention. ' +
          'Nothing the API can do will clear this.';
      } else {
        verification = 'unconfirmed';
        detail =
          `Expected ${expected} but the lock still reports ${afterState} after ` +
          `${(waitedMs / 1000).toFixed(1)}s (was ${before} before). Re-read with ` +
          `simplisafe_list_locks — a slow lock may yet complete.`;
      }

      return textResult({
        sid: system.sid,
        serial,
        lockName: name,
        requested: state,
        previousState: before,
        currentState: afterState,
        verification,
        verifiedAfterSeconds: waitedMs / 1000,
        detail,
        response,
      });
    },
  );
}

export const LOCK_TOOL_NAMES = ['simplisafe_set_lock_state'] as const;
